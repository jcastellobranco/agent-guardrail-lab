import { createHash } from 'node:crypto';
import type { AgentPolicy, TelemetryWindow } from '@lab/contracts';

/** The fields of a stored rollout that decide bundles and rollbacks. */
export interface Rollout {
  tenantId: string;
  probeId: string;
  stableVersion: string;
  canaryVersion: string;
  flagThreshold: number;
  blockThreshold: number;
  percent: number;
  maxBlockRateIncrease: number;
  minSamples: number;
  status: 'active' | 'rolled_back' | 'promoted' | 'aborted';
}

/**
 * Deterministic, sticky bucketing: the same agent stays in (or out of) the canary for the
 * whole rollout, so its behavior does not flip between bundles. Including the canary
 * version reshuffles agents for the next rollout, so the same agents are not always first.
 */
export function inCanary(rollout: Rollout, agentId: string): boolean {
  const key = `${rollout.tenantId}:${rollout.probeId}:${rollout.canaryVersion}:${agentId}`;
  const bucket = createHash('sha256').update(key).digest().readUInt32BE(0) % 100;
  return bucket < rollout.percent;
}

/** Returns the policy an agent should receive, with canary versions substituted. */
export function applyRollouts(policy: AgentPolicy, rollouts: readonly Rollout[]): AgentPolicy {
  return substitute(
    policy,
    rollouts,
    (rollout) => rollout.status === 'active' && inCanary(rollout, policy.agentId),
  );
}

/** The policy after promotion: every agent moves to the canary version, permanently. */
export function promote(policy: AgentPolicy, rollout: Rollout): AgentPolicy {
  return substitute(policy, [rollout], () => true);
}

function substitute(
  policy: AgentPolicy,
  rollouts: readonly Rollout[],
  useCanary: (rollout: Rollout) => boolean,
): AgentPolicy {
  const configurations = policy.probes.configurations.map((config) => {
    const rollout = rollouts.find(
      (r) => r.probeId === config.probeId && r.stableVersion === config.version,
    );
    if (!rollout || !useCanary(rollout)) return config;

    const { shadow, ...rest } = config;
    return {
      ...rest,
      version: rollout.canaryVersion,
      flagThreshold: rollout.flagThreshold,
      blockThreshold: rollout.blockThreshold,
      // A shadow of the canary version would now duplicate the current version.
      ...(shadow && shadow.version !== rollout.canaryVersion ? { shadow } : {}),
    };
  });
  return { ...policy, probes: { ...policy.probes, configurations } };
}

export interface BlockRate {
  blocks: number;
  total: number;
  rate: number;
}

export type RolloutVerdict =
  | { action: 'continue'; stable: BlockRate; canary: BlockRate }
  | { action: 'rollback'; stable: BlockRate; canary: BlockRate; reason: string };

/** Sums probe decisions per version over aggregate telemetry windows. */
export function blockRate(
  windows: readonly TelemetryWindow[],
  probeId: string,
  version: string,
): BlockRate {
  let blocks = 0;
  let total = 0;
  for (const window of windows) {
    for (const metric of window.probeMetrics) {
      if (metric.probeId !== probeId || metric.version !== version) continue;
      for (const decision of metric.decisions ?? []) {
        total += decision.count;
        if (decision.outcome === 'block') blocks += decision.count;
      }
    }
  }
  return { blocks, total, rate: total ? blocks / total : 0 };
}

/**
 * Rolls back when the canary blocks noticeably more than the stable version on the same
 * tenant's traffic. Both sides need `minSamples` decisions; until then the rollout continues,
 * because a handful of calls would make the comparison noise.
 */
export function evaluateRollout(
  rollout: Rollout,
  windows: readonly TelemetryWindow[],
): RolloutVerdict {
  const stable = blockRate(windows, rollout.probeId, rollout.stableVersion);
  const canary = blockRate(windows, rollout.probeId, rollout.canaryVersion);
  const enoughData = stable.total >= rollout.minSamples && canary.total >= rollout.minSamples;
  if (!enoughData || canary.rate - stable.rate <= rollout.maxBlockRateIncrease) {
    return { action: 'continue', stable, canary };
  }
  const reason =
    `canary block rate ${canary.rate.toFixed(3)} (n=${canary.total}) exceeds stable ` +
    `${stable.rate.toFixed(3)} (n=${stable.total}) by more than ${rollout.maxBlockRateIncrease}`;
  return { action: 'rollback', stable, canary, reason };
}
