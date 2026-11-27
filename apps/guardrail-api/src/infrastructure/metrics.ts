import { Registry, Histogram, Counter, Gauge, collectDefaultMetrics } from 'prom-client';
import type { Metrics } from '../application/ports.js';
import type { ShadowComparison } from '../application/evaluate-probes.js';
import type { StageName } from '@lab/contracts';
export class PromMetrics implements Metrics {
  readonly registry = new Registry();
  private readonly stages = new Histogram({
    name: 'guardrail_stage_duration_ms',
    help: 'Stage duration in milliseconds',
    labelNames: ['stage'] as const,
    buckets: [0.1, 0.5, 1, 2, 5, 10, 20, 35, 50, 100, 500],
    registers: [this.registry],
  });
  private readonly outcomes = new Counter({
    name: 'guardrail_decisions_total',
    help: 'Decision counts',
    labelNames: ['outcome', 'degraded'] as const,
    registers: [this.registry],
  });
  private readonly staleCount = new Counter({
    name: 'guardrail_stale_policy_total',
    help: 'Checks encountering a stale policy',
    registers: [this.registry],
  });
  private readonly auditDrops = new Counter({
    name: 'guardrail_audit_dropped_total',
    help: 'Audit events lost before durable queue insertion',
    registers: [this.registry],
  });
  // Block-rate comparison: rate(outcome="block") / rate(all) per role, for current vs candidate.
  private readonly shadowOutcomes = new Counter({
    name: 'guardrail_probe_shadow_outcomes_total',
    help: 'Shadow-mode probe outcomes by role (current decides, candidate is observed only)',
    labelNames: ['probe', 'version', 'role', 'outcome'] as const,
    registers: [this.registry],
  });
  private readonly shadowDisagreements = new Counter({
    name: 'guardrail_probe_shadow_disagreements_total',
    help: 'Calls where the candidate probe version would have decided differently',
    labelNames: ['probe', 'current_outcome', 'candidate_outcome'] as const,
    registers: [this.registry],
  });
  shadow(comparisons: readonly ShadowComparison[]) {
    for (const c of comparisons) {
      this.shadowOutcomes.inc({
        probe: c.probeId,
        version: c.currentVersion,
        role: 'current',
        outcome: c.current,
      });
      this.shadowOutcomes.inc({
        probe: c.probeId,
        version: c.candidateVersion,
        role: 'candidate',
        outcome: c.candidate,
      });
      if (c.current !== c.candidate) {
        this.shadowDisagreements.inc({
          probe: c.probeId,
          current_outcome: c.current,
          candidate_outcome: c.candidate,
        });
      }
    }
  }
  auditDrop() {
    this.auditDrops.inc();
  }
  constructor(cache?: () => { age: number; version: number; stale: boolean }) {
    // Includes nodejs_eventloop_lag_{p50,p90,p99}_seconds, measured with
    // perf_hooks.monitorEventLoopDelay and reset on every scrape. A p99 close to the
    // decision budget means timers fire late and deadlines are overshot.
    collectDefaultMetrics({ register: this.registry, eventLoopMonitoringPrecision: 10 });
    if (cache) {
      for (const [name, help, get] of [
        [
          'guardrail_policy_cache_age_seconds',
          'Age of the last verified policy snapshot',
          () => cache().age,
        ],
        [
          'guardrail_policy_bundle_version',
          'Version of active policy snapshot',
          () => cache().version,
        ],
        [
          'guardrail_policy_stale',
          'Whether policy cache is stale or empty',
          () => Number(cache().stale),
        ],
      ] as const)
        new Gauge({
          name,
          help,
          registers: [this.registry],
          collect() {
            this.set(get());
          },
        });
    }
  }
  stage(stage: StageName, elapsedMs: number) {
    this.stages.observe({ stage }, elapsedMs);
  }
  decision(outcome: 'allow' | 'flag' | 'block', degraded: boolean) {
    this.outcomes.inc({ outcome, degraded: String(degraded) });
  }
  stale() {
    this.staleCount.inc();
  }
}
