# Observability

## Metrics (`GET /metrics` on the guardrail)

| Metric | Meaning | Why it matters |
|---|---|---|
| `guardrail_stage_duration_ms{stage}` | Histogram per stage: auth, policy, rules, inference, decision | Shows which stage uses up the latency budget |
| `guardrail_decisions_total{outcome,degraded}` | Decision counter | Block rate and degraded rate. A sudden rise in degraded usually means inference is timing out |
| `guardrail_policy_cache_age_seconds` | Age of the last verified signed snapshot | Grows while the control plane is unreachable. Past `MAX_POLICY_AGE_MS` the per-policy fail mode applies |
| `guardrail_policy_bundle_version`, `guardrail_policy_stale` | Active snapshot version, and whether it is stale or missing | Confirms that a policy change has actually arrived |
| `guardrail_audit_dropped_total` | Audit events lost before durable enqueue | The cost of keeping audit off the hot path |
| `guardrail_probe_shadow_outcomes_total{probe,version,role,outcome}`, `guardrail_probe_shadow_disagreements_total` | Shadow-mode comparison (see [probe rollout](probe-rollout.md)) | Candidate probe block rate against the current version, before promoting it |
| `nodejs_eventloop_lag_{p50,p90,p99}_seconds` | Event-loop delay from `perf_hooks.monitorEventLoopDelay`, 10 ms resolution, reset on every scrape | Deadlines are JS timers. If p99 delay approaches the 50 ms budget, timers fire late and requests overshoot their deadline |

prom-client's default metrics already measure event-loop delay with `monitorEventLoopDelay`, so the guardrail sets the resolution explicitly rather than running a second monitor. Alert on p99 delay above about 20 % of the decision budget. That points to CPU saturation or synchronous work, such as policy compilation or a burst of signature checks, that should move to a worker thread.

## Tracing

Every `/v1/check` (and `/v1/proxy/:tool`) produces a `guardrail.check` root span with one child span per stage: `guardrail.auth`, `guardrail.policy`, `guardrail.rules`, `guardrail.inference` (only when probes run) and `guardrail.decision`. Stage spans reuse the timestamps of the Prometheus histogram, so traces and metrics always agree.

The root span carries `guardrail.outcome`, `guardrail.degraded`, `guardrail.policy_id` and `guardrail.policy_version`. On failure it carries `guardrail.error` (the error code only) with status `ERROR`. Tool arguments, prompts and tokens are never recorded; a test asserts that.

Tracing is off by default. With no `OTEL_EXPORTER_OTLP_ENDPOINT`, the OpenTelemetry API is a no-op. When it is set, spans go through a `BatchSpanProcessor` to OTLP/HTTP. Export happens in the background: a slow or missing collector drops spans and never adds latency to a decision.

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://jaeger:4318 docker compose --profile tracing up -d --build
docker compose up -d --wait guardrail-api
make compose-demo
open http://127.0.0.1:16686   # service: guardrail-api
```

## Telemetry export to the control plane

The telemetry exporter reads only observation fields and sends one-minute aggregates: decision counts per policy and probe, disjoint score buckets, p50/p95/p99 by stage, observed cache age and versions. A strict allowlist schema rejects unexpected fields at every nested level, so prompts, arguments, agent IDs and full traces never leave the data plane. Ingest deduplicates by tenant, deployment and window.

Windows use processing time, not original event time. Empty windows report zero cache age and version; the local Prometheus gauges show live freshness. The lab caps a window at 10,000 events, and a larger window stalls with an explicit warning rather than being silently truncated. A production system would use bounded histograms or SQL aggregation, partitioned tables, retention, encryption, role-based access and privacy thresholds.
