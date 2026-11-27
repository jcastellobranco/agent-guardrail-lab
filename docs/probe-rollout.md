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
