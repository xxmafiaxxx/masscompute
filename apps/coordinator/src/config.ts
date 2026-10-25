// Coordinator configuration from environment with local-dev defaults.

import path from 'node:path';

export interface Config {
  port: number;
  dataDir: string;
  webDir: string | null;
  heartbeatMs: number;
  /** Drop a worker socket if no frame for this long. */
  workerSilentMs: number;
  /** Time a node has to accept an offered job. */
  jobAcceptTimeoutMs: number;
  /** Wall-clock budget for one completion request end-to-end. */
  jobTimeoutMs: number;
  /** Default per-key daily completion-token quota. */
  keyDailyTokens: number;
  /** Daily completion-token quota for keyless (IP-tracked) callers. */
  anonDailyTokens: number;
  /** Probe cadence per node (verification jobs). */
  probeIntervalMs: number;
}

function int(v: string | undefined, d: number): number {
  const n = v ? Number.parseInt(v, 10) : NaN;
  return Number.isFinite(n) ? n : d;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    port: int(env.PORT, 8090),
    dataDir: env.DATA_DIR ?? path.resolve('data'),
    webDir: env.WEB_DIR ? path.resolve(env.WEB_DIR) : null,
    heartbeatMs: int(env.HEARTBEAT_MS, 5_000),
    workerSilentMs: int(env.WORKER_SILENT_MS, 30_000),
    jobAcceptTimeoutMs: int(env.JOB_ACCEPT_TIMEOUT_MS, 5_000),
    jobTimeoutMs: int(env.JOB_TIMEOUT_MS, 120_000),
    keyDailyTokens: int(env.KEY_DAILY_TOKENS, 250_000),
    anonDailyTokens: int(env.ANON_DAILY_TOKENS, 4_000),
    probeIntervalMs: int(env.PROBE_INTERVAL_MS, 10 * 60_000),
  };
}
