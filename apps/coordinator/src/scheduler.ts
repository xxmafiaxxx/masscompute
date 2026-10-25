// Request routing: pick the best available node hosting the model.
// Pure decision function over node snapshots — unit-tested.

import { REP_QUARANTINE } from './reputation.js';

export interface SchedNode {
  token: string;
  models: Set<string> | ReadonlySet<string>;
  state: string;
  jobsInFlight: number;
  slots: number;
  rep: number;
}

export interface SchedDecision {
  /** Ordered preference list. Try in order; each pick may still reject. */
  picks: string[];
  reason: 'ok' | 'no-model' | 'no-capacity' | 'all-quarantined';
}

export function schedule(model: string, nodes: SchedNode[], limit = 3): SchedDecision {
  const hosting = nodes.filter((n) => n.models.has(model));
  if (hosting.length === 0) return { picks: [], reason: 'no-model' };
  const reputable = hosting.filter((n) => n.rep >= REP_QUARANTINE);
  if (reputable.length === 0) return { picks: [], reason: 'all-quarantined' };
  const open = reputable.filter((n) => n.state === 'available' && n.jobsInFlight < n.slots);
  if (open.length === 0) return { picks: [], reason: 'no-capacity' };

  const scored = open
    .map((n) => ({
      token: n.token,
      // Lower is better: load ratio dominates, reputation is a soft
      // preference, and jitter spreads identical nodes. The rep weight stays
      // BELOW the jitter span on purpose — otherwise an early streak makes
      // one node's rep diverge and the others never get picked again, which
      // starves them of the very traffic that would earn trust (and keeps
      // them unverified forever).
      score: n.jobsInFlight / Math.max(1, n.slots) - n.rep * 0.05 + Math.random() * 0.1,
    }))
    .sort((a, b) => a.score - b.score);
  return { picks: scored.slice(0, limit).map((s) => s.token), reason: 'ok' };
}

/** Rough token estimate when a worker reports no usage: ~4 chars/token. */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}
