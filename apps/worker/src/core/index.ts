// Worker core: ties probe + gates + model manager + engine + WS client into
// the donor loop. Runs under Electron (tray app) or headless via --dev.

import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';
import { PROTOCOL_VERSION, catalogEntry, MODEL_CATALOG, type C2W, type DonorState, type W2C } from '@masscompute/protocol';
import { configDir, loadConfig, saveConfig, type WorkerConfig, type WorkerSettings } from './config.js';
import { probe, type ProbeResult } from './probe.js';
import { evaluateGates } from './gates.js';
import { ensureModel, firstShardPath, modelReady, pickModel } from './modelmgr.js';
import { ensureLlamaServer, llamaKey, llamaServerPath, randomPort, startLlamaServer, type RunningServer } from './llama.js';
import { EngineClient } from './engine.js';

export interface CoreEvents {
  onStatus?: (line: string) => void;
  onState?: (s: { donorState: DonorState; model: string | null; engineUp: boolean; connected: boolean; jobsDone: number; tokensServed: number }) => void;
  /** Idle seconds source (Electron powerMonitor or stub). */
  idleSeconds?: () => number;
  onBattery?: () => boolean;
}

export class WorkerCore {
  private cfg: WorkerConfig;
  private specs: ProbeResult | null = null;
  private engine: RunningServer | null = null;
  private client: EngineClient | null = null;
  private ws: WebSocket | null = null;
  private modelId: string | null = null;
  private connected = false;
  private jobsDone = 0;
  private tokensServed = 0;
  private activeJobs = new Map<string, AbortController>();
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private engineRetryTimer: NodeJS.Timeout | null = null;
  private heartbeatMs = 5_000;
  private reconnectAttempts = 0;
  private stopped = false;
  private lastDonorState: DonorState = 'paused';

  constructor(
    private events: CoreEvents = {},
    settingsOverride?: Partial<WorkerSettings>,
  ) {
    this.cfg = loadConfig();
    if (settingsOverride) Object.assign(this.cfg.settings, settingsOverride);
  }

  get settings(): WorkerSettings {
    return this.cfg.settings;
  }

  updateSettings(patch: Partial<WorkerSettings>): void {
    Object.assign(this.cfg.settings, patch);
    saveConfig(this.cfg);
    this.status('settings updated');
  }

  private status(line: string): void {
    this.events.onStatus?.(line);
  }

  private emitState(): void {
    this.events.onState?.({
      donorState: this.lastDonorState,
      model: this.modelId,
      engineUp: this.engine !== null,
      connected: this.connected,
      jobsDone: this.jobsDone,
      tokensServed: this.tokensServed,
    });
    this.writeStatusFile();
  }

  /**
   * Last-known state for `masscompute status` (and the tray app's CLI
   * twin): the donor usually runs headless in the background, so the
   * status verb reads this instead of guessing. Written at most 1x/sec.
   */
  private lastStatusWrite = 0;
  private writeStatusFile(): void {
    const now = Date.now();
    if (now - this.lastStatusWrite < 1_000 && !this.stopped) return;
    this.lastStatusWrite = now;
    try {
      const file = path.join(configDir(), 'state.json');
      fs.mkdirSync(configDir(), { recursive: true });
      fs.writeFileSync(
        file,
        JSON.stringify(
          {
            pid: process.pid,
            donorState: this.lastDonorState,
            model: this.modelId,
            engineUp: this.engine !== null,
            connected: this.connected,
            coordinator: this.cfg.settings.coordinator,
            name: this.cfg.settings.name || null,
            nodeToken: this.cfg.nodeToken ? this.cfg.nodeToken.slice(0, 12) : null,
            jobsDone: this.jobsDone,
            tokensServed: this.tokensServed,
            updatedAt: now,
          },
          null,
          2,
        ),
      );
    } catch {
      /* status is best-effort */
    }
  }

  /** Hardware facts for `doctor` — probe without starting anything. */
  async hardwareSummary(): Promise<{ gpus: Array<{ name: string; vramTotalMb: number; backend: string }>; backend: string; vramTotalMb: number; cpuModel: string; ramTotalMb: number; os: string; model: string; modelReady: boolean; engineBinary: string; engineBinaryReady: boolean }> {
    const specs = this.specs ?? (await probe());
    const entry = pickModel(specs.vramTotalMb, this.cfg.settings.modelTier);
    return {
      gpus: specs.gpus.map((g) => ({ name: g.name, vramTotalMb: g.vramTotalMb, backend: g.backend })),
      backend: specs.backend,
      vramTotalMb: specs.vramTotalMb,
      cpuModel: specs.cpuModel,
      ramTotalMb: specs.ramTotalMb,
      os: specs.os,
      model: entry.id,
      modelReady: modelReady(entry),
      engineBinary: llamaServerPath(),
      engineBinaryReady: fs.existsSync(llamaServerPath()),
    };
  }

  async start(): Promise<void> {
    this.stopped = false;
    this.status('probing hardware…');
    this.specs = await probe();
    this.status(`found: ${this.specs.gpus.map((g) => `${g.name} (${g.backend})`).join(', ') || 'CPU only'}`);

    // Engine + model bootstrap happens once; failures are survivable (node
    // connects and reports paused/unavailable) but logged loudly.
    try {
      await this.bootstrapEngine();
    } catch (e) {
      this.status(`engine bootstrap failed: ${(e as Error).message}`);
    }

    this.connect();
  }

  private async bootstrapEngine(): Promise<void> {
    if (this.engineRetryTimer) {
      clearTimeout(this.engineRetryTimer);
      this.engineRetryTimer = null;
    }
    const entry = pickModel(this.specs!.vramTotalMb, this.cfg.settings.modelTier);
    this.status(`hosting model: ${entry.label}`);
    if (!modelReady(entry)) await ensureModel(entry, (s) => this.status(s));
    const exe = await ensureLlamaServer((s) => this.status(s));
    this.status('starting inference engine…');
    const port = await randomPort();
    const apiKey = llamaKey();
    const gpuLayers = this.specs!.backend === 'cpu' ? 0 : 999;
    const engine = await startLlamaServer(firstShardPath(entry), { port, apiKey, contextSize: entry.contextDefault, gpuLayers }, (l) => {
      if (process.env.MASSCOMPUTE_VERBOSE) this.status(`engine: ${l}`);
    });
    this.engine = engine;
    this.client = new EngineClient(`http://127.0.0.1:${port}`, apiKey);
    this.modelId = entry.id;
    this.watchEngine(engine);
    this.status('engine ready');
    this.emitState();
  }

  /**
   * A crashed llama-server used to leave the worker advertising 'available'
   * while every job failed — reputation craters before anyone notices. Watch
   * the child: drop the engine, tell the coordinator, and retry after 60s.
   */
  private watchEngine(engine: RunningServer): void {
    engine.child.once('exit', (code) => {
      if (this.stopped || this.engine !== engine) return;
      this.status(`engine exited (code ${code ?? 'signal'}); will restart in 60s`);
      this.engine = null;
      this.client = null;
      this.modelId = null;
      this.lastDonorState = 'paused'; // reflect immediately, not on the next heartbeat
      this.send({ t: 'models', models: [] });
      this.emitState();
      this.scheduleEngineRetry();
    });
  }

  private scheduleEngineRetry(): void {
    if (this.stopped || this.engineRetryTimer) return;
    this.engineRetryTimer = setTimeout(() => {
      this.engineRetryTimer = null;
      if (this.stopped || this.engine) return;
      this.bootstrapEngine()
        .then(() => this.send({ t: 'models', models: this.modelId ? [this.modelId] : [] }))
        .catch((e) => {
          this.status(`engine restart failed: ${(e as Error).message}`);
          this.scheduleEngineRetry();
        });
    }, 60_000);
    this.engineRetryTimer.unref?.();
  }

  private connect(): void {
    if (this.stopped) return;
    const base = this.cfg.settings.coordinator.replace(/\/+$/, '');
    const url = base.endsWith('/worker') ? base : `${base}/worker`;
    this.status(`connecting ${url}`);
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.on('open', () => {
      this.send({
        t: 'hello',
        proto: PROTOCOL_VERSION,
        nodeToken: this.cfg.nodeToken ?? undefined,
        name: this.cfg.settings.name || undefined,
        specs: {
          os: this.specs!.os,
          cpuModel: this.specs!.cpuModel,
          ramTotalMb: this.specs!.ramTotalMb,
          gpus: this.specs!.gpus,
          workerVersion: '0.1.0',
        },
        models: this.modelId ? [this.modelId] : [],
        slots: Math.max(1, this.cfg.settings.slots),
      });
    });

    ws.on('message', (raw) => {
      let m: C2W;
      try {
        m = JSON.parse(String(raw)) as C2W;
      } catch {
        return;
      }
      void this.handle(m);
    });

    ws.on('close', () => {
      this.connected = false;
      this.emitState();
      if (!this.stopped) {
        // Exponential backoff (5s doubling to a 30s cap) so a long coordinator
        // outage doesn't turn every donor into a reconnect hammer.
        const delay = Math.min(30_000, 5_000 * 2 ** this.reconnectAttempts);
        this.reconnectAttempts++;
        this.reconnectTimer = setTimeout(() => this.connect(), delay);
      }
    });
    ws.on('error', () => ws.terminate());
  }

  private send(m: W2C): void {
    if (this.ws && this.ws.readyState === this.ws.OPEN) this.ws.send(JSON.stringify(m));
  }

  private async handle(m: C2W): Promise<void> {
    switch (m.t) {
      case 'helloAck': {
        if (!this.cfg.nodeToken || this.cfg.nodeToken !== m.nodeToken) {
          this.cfg.nodeToken = m.nodeToken;
          saveConfig(this.cfg);
        }
        this.heartbeatMs = m.heartbeatMs;
        this.connected = true;
        this.reconnectAttempts = 0;
        this.status('connected to coordinator');
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = setInterval(() => this.heartbeat(), this.heartbeatMs);
        this.heartbeat();
        this.emitState();
        return;
      }
      case 'ping':
        this.send({ t: 'pong', ts: m.ts });
        return;
      case 'job':
        await this.runJob(m.jobId, m.messages, m.params, false);
        return;
      case 'probe':
        await this.runJob(m.jobId, [{ role: 'user', content: m.prompt }], { temperature: 0, max_tokens: m.maxTokens }, true);
        return;
      case 'jobCancel': {
        this.activeJobs.get(m.jobId)?.abort();
        return;
      }
      default:
        return;
    }
  }

  private heartbeat(): void {
    const g = evaluateGates({
      donating: this.cfg.settings.donating && this.engine !== null,
      idleSec: this.events.idleSeconds?.() ?? 999_999,
      idleThresholdSec: this.cfg.settings.idleMinutes * 60,
      gpuUtil: 0, // filled async below
      gpuBusyThreshold: 40,
      onBattery: this.events.onBattery?.() ?? false,
      schedule: this.cfg.settings.schedule,
    });
    void (async () => {
      const gpuUtil = g.ok || g.state === 'gpu-busy' ? await this.specs!.gpuUtil().catch(() => 0) : 0;
      const state = g.ok && gpuUtil > 40 ? ('gpu-busy' as DonorState) : g.state;
      this.lastDonorState = state;
      this.send({
        t: 'heartbeat',
        state,
        gpuUtil,
        vramFreeMb: Math.max(0, (this.specs?.vramTotalMb ?? 0) - 2_000),
        idleSec: this.events.idleSeconds?.() ?? 999_999,
        onBattery: this.events.onBattery?.() ?? false,
        jobsInFlight: this.activeJobs.size,
        tokensServedTotal: this.tokensServed,
      });
      this.emitState();
    })();
  }

  private async runJob(jobId: string, messages: { role: 'system' | 'user' | 'assistant'; content: string }[], params: { temperature?: number; top_p?: number; max_tokens?: number; stop?: string[] }, isProbe: boolean): Promise<void> {
    if (!this.client) {
      this.send({ t: 'jobReject', jobId, reason: 'engine not ready' });
      return;
    }
    if (this.activeJobs.size >= Math.max(1, this.cfg.settings.slots)) {
      this.send({ t: 'jobReject', jobId, reason: 'no free slot' });
      return;
    }
    // Accepting then generating: coordinator keys on jobAccept to start its clock.
    this.send({ t: 'jobAccept', jobId });
    const ac = new AbortController();
    this.activeJobs.set(jobId, ac);
    const started = Date.now();
    try {
      const r = await this.client.chat(messages, params, (delta) => this.send({ t: 'gen', jobId, delta }), ac.signal);
      this.jobsDone++;
      this.tokensServed += r.completionTokens;
      this.send({ t: 'gen', jobId, done: true, usage: { promptTokens: r.promptTokens, completionTokens: r.completionTokens }, msTotal: r.msTotal });
      this.status(`${isProbe ? 'probe' : 'job'} ${jobId.slice(0, 8)} done: ${r.completionTokens} tok in ${(r.msTotal / 1000).toFixed(1)}s`);
    } catch (e) {
      if (ac.signal.aborted) {
        // Cancelled: report what we have (already streamed), no done.
        this.send({ t: 'gen', jobId, delta: '', done: true, error: 'cancelled', msTotal: Date.now() - started });
      } else {
        this.send({ t: 'gen', jobId, delta: '', done: true, error: (e as Error).message, msTotal: Date.now() - started });
      }
    } finally {
      this.activeJobs.delete(jobId);
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.engineRetryTimer) clearTimeout(this.engineRetryTimer);
    for (const ac of this.activeJobs.values()) ac.abort();
    this.ws?.close();
    this.engine?.child.kill();
    this.engine = null;
    this.client = null;
    this.writeStatusFile();
  }

  /** For the settings UI. */
  describe(): {
    models: string[];
    current: string | null;
    coordinator: string;
    settings: WorkerSettings;
  } {
    return {
      models: MODEL_CATALOG.map((m) => m.id),
      current: this.modelId,
      coordinator: this.cfg.settings.coordinator,
      settings: this.cfg.settings,
    };
  }
}

export { catalogEntry };

// Headless dev run: `node core.mjs --dev` donates from the terminal.
if (process.argv.includes('--dev')) {
  const core = new WorkerCore({
    onStatus: (l) => console.log('[worker]', l),
    onState: (s) => console.log('[state]', JSON.stringify(s)),
  });
  core.start().catch((e) => {
    console.error('[worker] fatal:', e);
    process.exit(1);
  });
  const shutdown = () => {
    core.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
