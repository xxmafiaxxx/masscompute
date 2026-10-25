// MassCompute worker<->coordinator wire protocol, version 1.
// One JSON object per WebSocket text frame. Every worker->coordinator
// message that creates state carries a jobId; jobs flow coordinator->worker.

export const PROTOCOL_VERSION = 1;

/** Worker advertises which inference backend each GPU/detector uses. */
export type BackendKind = 'cuda' | 'vulkan' | 'rocm' | 'metal' | 'cpu' | 'ollama';

export interface GpuInfo {
  name: string;
  vramTotalMb: number;
  backend: BackendKind;
}

export interface NodeSpecs {
  os: 'windows' | 'macos' | 'linux';
  cpuModel: string;
  ramTotalMb: number;
  gpus: GpuInfo[];
  workerVersion: string;
}

/**
 * Donor availability, computed worker-side from its gates (manual toggle,
 * idle timer, GPU busy, battery, schedule). Coordinator only routes jobs to
 * nodes whose latest heartbeat said 'available'.
 */
export type DonorState =
  | 'available'
  | 'paused' // manual donor toggle off
  | 'idle-wait' // user active, waiting for idle threshold
  | 'gpu-busy' // someone is using the machine (game/render)
  | 'on-battery'
  | 'schedule-off'
  | 'warming'; // model loading / llama-server starting

export interface Usage {
  promptTokens: number;
  completionTokens: number;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatParams {
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stop?: string[];
  seed?: number;
}

export interface CatalogFile {
  name: string;
  sha256: string;
  bytes: number;
}

export interface CatalogEntry {
  id: string;
  label: string;
  tier: 'test' | 'small' | 'mid' | 'large';
  hfRepo: string;
  /** Pinned commit. Downloads must use this, never a moving branch. */
  revision: string;
  /** Shards in order; llama-server takes the first shard path. */
  files: CatalogFile[];
  totalBytes: number;
  /** Recommended free VRAM to host this model (0 = CPU capable by design). */
  vramMinMb: number;
  cpuCapable: boolean;
  contextDefault: number;
  description: string;
}

// ---- Worker -> Coordinator ----

export type W2C =
  | {
      t: 'hello';
      proto: number;
      /** Present on reconnect, absent on first join. */
      nodeToken?: string;
      /** Public leaderboard name; anonymized if absent. */
      name?: string;
      specs: NodeSpecs;
      /** Model ids hosted and ready right now. */
      models: string[];
      /** Concurrent generation requests the node will accept. */
      slots: number;
    }
  | {
      t: 'heartbeat';
      state: DonorState;
      gpuUtil: number; // 0-100, max across GPUs
      vramFreeMb: number;
      idleSec: number;
      onBattery: boolean;
      jobsInFlight: number;
      tokensServedTotal: number;
    }
  | { t: 'models'; models: string[] }
  | { t: 'slots'; slots: number }
  | { t: 'jobAccept'; jobId: string }
  | { t: 'jobReject'; jobId: string; reason: string }
  | {
      t: 'gen';
      jobId: string;
      /** Incremental text chunk. */
      delta?: string;
      done?: boolean;
      error?: string;
      usage?: Usage;
      msTotal?: number;
    }
  | { t: 'benchmark'; model: string; tokPerSec: number }
  | { t: 'pong'; ts: number };

// ---- Coordinator -> Worker ----

export type C2W =
  | {
      t: 'helloAck';
      proto: number;
      /** Persistent node identity; store and present on reconnect. */
      nodeToken: string;
      catalog: CatalogEntry[];
      heartbeatMs: number;
    }
  | { t: 'ping'; ts: number }
  | {
      t: 'job';
      jobId: string;
      model: string;
      messages: ChatMessage[];
      params: ChatParams;
    }
  | {
      /** Synthetic verification job. Always temp 0, small max_tokens. */
      t: 'probe';
      jobId: string;
      model: string;
      prompt: string;
      maxTokens: number;
    }
  | { t: 'jobCancel'; jobId: string };

export function isW2C(m: unknown): m is W2C {
  return typeof m === 'object' && m !== null && 't' in m;
}

export function isC2W(m: unknown): m is C2W {
  return typeof m === 'object' && m !== null && 't' in m;
}
