// Node reputation: EWMA over verification + job outcomes.
// Pure functions — unit-tested; the coordinator persists results via store.

export type RepEventKind =
  | 'probe-match' // output agreed with a reference node
  | 'probe-mismatch' // output disagreed with every reference
  | 'probe-unverifiable' // not enough reference nodes; no signal
  | 'job-success'
  | 'job-failure' // crashed, errored, or garbage-errored mid-stream
  | 'reject-spam'; // accepted-then-rejected or reject storms

const ALPHA_GOOD = 0.03;
const ALPHA_PROBE_MATCH = 0.05;
const BETA_PROBE_MISMATCH = 0.25;
const BETA_JOB_FAILURE = 0.08;
const BETA_REJECT_SPAM = 0.15;

export const REP_QUARANTINE = 0.35;
export const REP_PROBATION = 0.7;

export interface RepState {
  rep: number;
  events: number;
}

export function initialRep(): RepState {
  // New nodes start BELOW the probation line so they are probed aggressively
  // from their first minute; good behavior earns full trust.
  return { rep: 0.65, events: 0 };
}

export function applyEvent(s: RepState, kind: RepEventKind): RepState {
  let { rep } = s;
  switch (kind) {
    case 'probe-match':
      rep = rep + (1 - rep) * ALPHA_PROBE_MATCH;
      break;
    case 'job-success':
      rep = rep + (1 - rep) * ALPHA_GOOD;
      break;
    case 'job-failure':
      rep = rep - rep * BETA_JOB_FAILURE;
      break;
    case 'probe-mismatch':
      rep = rep - rep * BETA_PROBE_MISMATCH;
      break;
    case 'reject-spam':
      rep = rep - rep * BETA_REJECT_SPAM;
      break;
    case 'probe-unverifiable':
      return s;
  }
  return { rep: clamp(rep, 0, 1), events: s.events + 1 };
}

export function isQuarantined(s: RepState): boolean {
  return s.rep < REP_QUARANTINE;
}

/** Nodes on probation get probed more aggressively. */
export function shouldProbe(s: RepState, baseIntervalMs: number, now: number, lastProbeAt: number): boolean {
  const interval = s.rep < REP_PROBATION ? baseIntervalMs / 4 : baseIntervalMs;
  return now - lastProbeAt >= interval;
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}
