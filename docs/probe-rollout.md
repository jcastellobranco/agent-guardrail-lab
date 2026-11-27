# Rolling out probe versions

A new probe version can be wrong in a way that offline evaluation misses: different traffic, a shifted threshold, a regression on one tenant's tools. Rolling out in stages limits who is exposed at each step:

1. **Shadow:** every call is scored by both versions; only the current one decides.
2. **Canary:** the candidate decides for a fixed share of agents, and rolls back automatically if its block rate climbs.
3. **Promote:** the candidate becomes the version in every policy.

## 1. Shadow mode

Add a `shadow` block to a probe configuration:

```json
{
  "probeId": "jailbreak",
  "version": "1.0.0",
  "flagThreshold": 0.5,
  "blockThreshold": 0.85,
  "shadow": { "version": "2.0.0", "flagThreshold": 0.5, "blockThreshold": 0.85 }
}
```

- The guardrail sends `jailbreak:1.0.0` and `jailbreak:2.0.0` in the **same** inference request. The model runs one forward pass and computes every probe as one matrix multiply, so a shadow adds a matrix row, not a second model call.
- Only current versions produce findings. Shadow outcomes never appear in the decision, the reasons or the audit record.
- The candidate must have its own thresholds: a new probe's score distribution is not the old one's.
- Comparison metrics on `/metrics`:
  - `guardrail_probe_shadow_outcomes_total{probe,version,role="current"|"candidate",outcome}`
  - `guardrail_probe_shadow_disagreements_total{probe,current_outcome,candidate_outcome}`

  Block rate per role in PromQL:

  ```promql
  sum by (role) (rate(guardrail_probe_shadow_outcomes_total{probe="jailbreak",outcome="block"}[15m]))
    / sum by (role) (rate(guardrail_probe_shadow_outcomes_total{probe="jailbreak"}[15m]))
  ```

- Current and shadow versions together are limited to 32 keys per policy, which is the inference request limit.
- The control plane lists shadow keys in the bundle's `probeVersions` and in `/probe-versions`, so data planes provision those artifacts too.

**Trade-off:** a shadow that the inference service has not loaded makes the request fail (`UNKNOWN_PROBE_VERSION`), and the policy's fail mode applies. So a broken shadow configuration *can* affect decisions. Signed artifact sync (below) closes this gap: the bundle is accepted only once every listed artifact is present.

## 2. Canary rollout with automatic rollback

Once shadow metrics look good, let the candidate decide for a share of agents:

```bash
curl -X PUT http://127.0.0.1:8002/v1/admin/tenants/tenant-a/probe-rollouts/jailbreak \
  -H "authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"stableVersion":"1.0.0","canaryVersion":"2.0.0","flagThreshold":0.5,"blockThreshold":0.85,
       "percent":10,"maxBlockRateIncrease":0.05,"minSamples":200}'
```

- **Who gets the canary.** When building each bundle, the control plane hashes `tenant:probe:canaryVersion:agent` with SHA-256 and puts the agent in the canary if `hash mod 100 < percent`. Assignment is deterministic and sticky. Ramping from 10 % to 30 % (the same `PUT` with a new `percent`) keeps the first 10 % and adds more. The stored policy is never modified: substitution happens only in the signed bundle, and only for configurations that use `stableVersion`.
- **When it rolls back.** After every telemetry ingest, the control plane sums probe decisions per version since the rollout started, across all of the tenant's deployments. If both versions have at least `minSamples` decisions and `canaryRate − stableRate > maxBlockRateIncrease`, the rollout becomes `rolled_back` with a reason, and the next bundle pull puts every agent back on the stable version. Changing versions during an active rollout returns `409`; abort or promote it first.
- **Rollback speed** is one telemetry window (1 min) plus one bundle poll (`SYNC_INTERVAL_MS`). There is no push.
- `GET .../probe-rollouts` shows status, reason and timestamps. `POST .../:probeId/abort` stops a rollout manually.

**Why block rate:** it is the cheapest signal that needs no labels, and a probe that suddenly blocks more is the most visible way a bad probe hurts users. It cannot detect a probe that blocks *less* (missed attacks). That needs labelled evaluation (the CI FPR gate) or shadow comparison against a reviewed sample. Telemetry counts are aggregates only, so the comparison never needs raw traces.

## 3. Promote

`POST .../probe-rollouts/:probeId/promote` rewrites, in one transaction, every stored policy that uses the stable version: new version, new thresholds, and a bumped policy version. Promotion lives in the policies, not in the rollout row, so it survives the next rollout replacing that row.

## 4. Signed artifact distribution

A shadow or canary is only useful if every data plane can load the candidate's weights. Artifacts travel like policy bundles: pulled, signed and verified.

1. **Publish.** `node scripts/publish-probe.mjs <artifact.json>` uploads a trained artifact to `PUT /v1/admin/probes/:probeId/versions/:version`. The control plane validates it with `ProbeArtifactSchema` (which mirrors the Python model) and stores the exact JSON text with its SHA-256. Versions are immutable: identical re-uploads are no-ops, and different content under the same version returns `409 ARTIFACT_IMMUTABLE`.
2. **Serve.** `GET /v1/sync/:tenantId/probes/:probeId/:version` returns `{payload, signature, keyId, algorithm}`, but only for versions the tenant's effective policies use (current, shadow or canary). Other tenants' or unused versions return 404.
3. **Sign with domain separation.** The bundle key signs `"agent-guardrail-lab/probe-artifact/v1\n" + payload`. A bundle signature can never verify as an artifact signature, or the reverse, even though both use one key.
4. **Verify before accepting the bundle.** With `PROBE_ARTIFACT_DIR` set (Helm: `inference.syncArtifacts=true`), the sync agent downloads each artifact the incoming bundle lists in `probeVersions` that is not already on disk. For each one it verifies the signature, the schema, and that the artifact is the requested `probeId:version`, then writes it atomically. Only then does it write the bundle. Any failure rejects the bundle and keeps the previous one, so the guardrail never references weights the data plane lacks.
5. **Hot reload.** The inference service checks its artifact directory every `PROBE_RELOAD_INTERVAL_S` (default 5 s). It builds and validates a complete new probe bank before swapping it in; if any artifact is invalid or incompatible with the loaded model, the current bank keeps serving.

**Remaining gaps:**
- A new bundle can reach the guardrail up to one reload interval before inference has loaded the new weights. During that window requests for the new version fail, and the policy's fail mode applies.
- The inference service trusts its local volume and does not re-verify signatures, unlike the guardrail, which re-verifies bundles.
- Artifact sync is off by default in Compose, because the locally trained artifact volume is owned by the inference user.
