# ADR 0014 — Rolling out probe versions: shadow, canary, signed artifacts

## Context

A probe version is a model change: offline metrics on a toy dataset don't show how it behaves on a tenant's real tool calls. Replacing the version in every policy at once makes every regression immediately user-visible, and the artifacts it depends on had to be copied onto each data plane by hand.

## Decision

- **Shadow:** a probe configuration can name a candidate version with its own thresholds. Both are scored in the same inference request (one forward pass, one extra matrix row). Only the current version produces findings; per-role Prometheus counters expose the comparison.
- **Canary:** the control plane stores one rollout per tenant and probe. While building each bundle it substitutes the canary version for agents whose `sha256(tenant:probe:canary:agent) mod 100 < percent`. The stored policies are untouched. After each telemetry ingest it compares block rates since the rollout started and rolls back when `canary − stable > maxBlockRateIncrease` with at least `minSamples` decisions on both sides. Promotion rewrites the stored policies in one transaction.
- **Artifacts:** admins publish immutable artifacts, and the control plane serves them signed with the bundle key under a domain-separation prefix. The sync agent downloads and verifies every artifact a new bundle lists *before* accepting the bundle. The inference service hot-reloads its artifact directory and swaps in a fully validated bank.

## Consequences

- Rollback needs no human and no data-plane change: the next bundle pull returns agents to the stable version, about one telemetry window plus one poll interval.
- The rollback signal is aggregate counts only, so it fits the "no raw traces leave the customer" rule (ADR 0011). It detects over-blocking, not under-blocking; missed attacks still need labelled evaluation.
- Block rates are pooled across the tenant's deployments; per-deployment differences are not separated.
- Bucketing is per agent, not per request: an agent sees one consistent version, but a small fleet gives a coarse percentage.
- Rejected: per-request random assignment (agents would flip between versions); a separate signing key for artifacts (more key management than domain separation needs in this lab); having the data plane decide canary membership (the control plane already sees aggregate telemetry from every deployment).
- Gaps: a bundle can reach the guardrail up to one reload interval before inference has loaded new weights, and inference doesn't re-verify artifact signatures.
