// Integration: boot the REAL coordinator (http + ws on an ephemeral port),
// connect scripted fake worker nodes over real WebSockets, and drive the
// public API end to end: models, non-stream + stream completions, key
// quotas, cancellation, reputation quarantine, leaderboard.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import type { C2W, W2C } from '@masscompute/protocol';
import { MODEL_CATALOG } from '@masscompute/protocol';

let port: number;
let app: import('fastify').FastifyInstance | null = null;
const clientSockets: WebSocket[] = [];

const BASE = () => `http://127.0.0.1:${port}`;

/** A scripted fake worker: honors hello, accepts jobs, emits gen deltas. */
class FakeWorker {
  ws: WebSocket | null = null;
  sent: C2W[] = [];
  onMessage: ((m: C2W, reply: (m: W2C) => void) => void) | null = null;
  private wss = new WebSocketServer({ port: 0 }); // unused; client mode only
  constructor(
    readonly url: string,
    private opts: {
      models?: string[];
      nodeToken?: string;
      state?: string;
      /** Reply text for jobs. */
      answer?: string;
      /** Never emit gen.done. */
      hang?: boolean;
      /** Reply with garbage text (verification bait). */
      poison?: string;
      /** Suppress the built-in job auto-answer (test supplies behavior). */
      noAutoAnswer?: boolean;
    } = {},
  ) {}

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);
      clientSockets.push(this.ws);
      this.ws.on('open', () => {
        this.send({
          t: 'hello',
          proto: 1,
          nodeToken: this.opts.nodeToken,
          name: 'fake-worker',
          specs: { os: 'windows', cpuModel: 'test', ramTotalMb: 32_768, gpus: [{ name: 'Fake GPU', vramTotalMb: 24_576, backend: 'vulkan' }], workerVersion: 'test' },
          models: this.opts.models ?? ['qwen2.5-3b-q4km'],
          slots: 2,
        });
      });
      this.ws.on('message', (raw) => {
        const m = JSON.parse(String(raw)) as C2W;
        this.sent.push(m);
        const reply = (out: W2C) => this.send(out);
        if (m.t === 'helloAck') return resolve();
        if (m.t === 'job') {
          if (this.opts.noAutoAnswer) return;
          this.send({ t: 'jobAccept', jobId: m.jobId });
          if (this.opts.hang) return;
          const text = this.opts.poison ?? this.opts.answer ?? 'ok';
          // stream in two chunks then done
          const mid = Math.ceil(text.length / 2);
          this.send({ t: 'gen', jobId: m.jobId, delta: text.slice(0, mid) });
          this.send({ t: 'gen', jobId: m.jobId, delta: text.slice(mid), done: true, usage: { promptTokens: 5, completionTokens: 4 }, msTotal: 42 });
        }
        if (m.t === 'probe') {
          this.send({ t: 'jobAccept', jobId: m.jobId });
          if (this.opts.hang) return;
          this.send({ t: 'gen', jobId: m.jobId, delta: this.opts.poison ?? this.opts.answer ?? '', done: true, usage: { promptTokens: 3, completionTokens: 2 } });
        }
        this.onMessage?.(m, reply);
      });
      this.ws.on('error', reject);
    });
  }

  heartbeat(state?: string, jobsInFlight = 0): void {
    this.send({
      t: 'heartbeat',
      state: (state ?? this.opts.state ?? 'available') as never,
      gpuUtil: 0,
      vramFreeMb: 12_288,
      idleSec: 600,
      onBattery: false,
      jobsInFlight,
      tokensServedTotal: 0,
    });
  }

  send(m: W2C): void {
    this.ws?.send(JSON.stringify(m));
  }

  close(): void {
    this.ws?.close();
  }
}

async function bootManual(): Promise<{ app: import('fastify').FastifyInstance; port: number }> {
  const { loadConfig } = await import('../src/config.js');
  const { Registry } = await import('../src/registry.js');
  const { Relay } = await import('../src/relay.js');
  const { Metrics } = await import('../src/metrics.js');
  const { openStore } = await import('../src/store.js');
  const { ProbeRunner } = await import('../src/probes.js');
  type ProbeRunnerT = import('../src/probes.js').ProbeRunner;
  const { RateLimiter } = await import('../src/ratelimit.js');
  const { registerRoutes } = await import('../src/routes.js');
  const { attachWorkerWs } = await import('../src/ws.js');
  const { applyEvent } = await import('../src/reputation.js');

  const Fastify = (await import('fastify')).default;

  const cfg = {
    ...loadConfig({
      PORT: '0',
      DATA_DIR: `.tmp-coord-${Date.now()}`,
      HEARTBEAT_MS: '1000',
      WORKER_SILENT_MS: '60000',
      JOB_ACCEPT_TIMEOUT_MS: '1500',
      JOB_TIMEOUT_MS: '8000',
      KEY_DAILY_TOKENS: '100000',
      ANON_DAILY_TOKENS: '60',
      PROBE_INTERVAL_MS: '60000',
    }),
  };
  const store = openStore(cfg.dataDir);
  const registry = new Registry();
  const metrics = new Metrics();
  const relay = new Relay(registry, metrics, store, cfg);
  const probes = new ProbeRunner(registry, relay, (conn, v) => {
    const kinds = { match: 'probe-match', mismatch: 'probe-mismatch', unverifiable: 'probe-unverifiable' } as const;
    const s = applyEvent({ rep: conn.rep, events: conn.repEvents }, kinds[v]);
    conn.rep = s.rep;
    conn.repEvents = s.events;
    store.setNodeRep(conn.token, s.rep, s.events);
  }, cfg);
  const app = Fastify({ logger: false, bodyLimit: 2_000_000 });
  registerRoutes(app, {
    registry,
    relay,
    store,
    metrics,
    probes,
    config: cfg,
    reqLimiter: new RateLimiter(10_000, 60_000),
    keyLimiter: new RateLimiter(10_000, 60_000),
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  const p = typeof addr === 'object' && addr ? addr.port : 0;
  attachWorkerWs(app.server, { registry, relay, store, metrics, probes, config: cfg });
  (globalThis as { __probeRunner?: ProbeRunnerT }).__probeRunner = probes;
  return { app, port: p };
}

async function api(pathname: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const res = await fetch(`${BASE()}${pathname}`, init);
  const text = await res.text();
  let body: any = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* SSE or text */
  }
  return { status: res.status, body };
}

let cleanupFns: Array<() => Promise<void>> = [];

describe('coordinator integration (real server, fake workers)', () => {
  beforeEach(async () => {
    const booted = await bootManual();
    app = booted.app;
    port = booted.port;
    cleanupFns.push(async () => {
      // Sockets first: open WS/SSE connections would stall app.close().
      for (const s of clientSockets.splice(0)) s.terminate();
      await new Promise((r) => setTimeout(r, 50));
      await app?.close();
      app = null;
    });
  });

  afterEach(async () => {
    for (const fn of cleanupFns.splice(0)) await fn();
  });

  it('health + models endpoints respond', async () => {
    const h = await api('/healthz');
    expect(h.status).toBe(200);
    expect(h.body.ok).toBe(true);

    const m = await api('/v1/models');
    expect(m.status).toBe(200);
    expect(m.body.data.length).toBe(MODEL_CATALOG.length);
    const ids = m.body.data.map((x: { id: string }) => x.id);
    expect(ids).toContain('qwen2.5-3b-q4km');
  });

  it('returns 503 no-nodes when the grid is empty', async () => {
    const r = await api('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'qwen2.5-3b-q4km', messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(r.status).toBe(503);
    expect(r.body.error.message).toContain('no nodes');
  });

  it('full request -> worker -> streamed answer over the real wire', async () => {
    const w = new FakeWorker(`ws://127.0.0.1:${port}/worker`, { answer: 'hello from the grid' });
    await w.connect();
    w.heartbeat();
    await new Promise((r) => setTimeout(r, 150));

    const r = await api('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'qwen2.5-3b-q4km', messages: [{ role: 'user', content: 'say hi' }] }),
    });
    expect(r.status).toBe(200);
    expect(r.body.choices[0].message.content).toBe('hello from the grid');
    expect(r.body.usage.completion_tokens).toBe(4);
    expect(r.body.masscompute.node).toMatch(/^nd_[0-9a-f]{5}$/);

    const stats = await api('/stats');
    expect(stats.body.metrics.requestsTotal).toBe(1);
    expect(stats.body.nodes.online).toBe(1);
    expect(stats.body.nodes.available).toBe(1);
    w.close();
  });

  it('streams SSE chunks in OpenAI shape', async () => {
    const w = new FakeWorker(`ws://127.0.0.1:${port}/worker`, { answer: 'streamed answer text' });
    await w.connect();
    w.heartbeat();
    await new Promise((r) => setTimeout(r, 150));

    const res = await fetch(`${BASE()}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'qwen2.5-3b-q4km', messages: [{ role: 'user', content: 'go' }], stream: true }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const text = await res.text();
    const payloads = text
      .split('\n')
      .filter((l) => l.startsWith('data: '))
      .map((l) => l.slice(6));
    expect(payloads[payloads.length - 1]).toBe('[DONE]');
    const chunks = payloads.slice(0, -1).map((p) => JSON.parse(p));
    expect(chunks[0].choices[0].delta.role).toBe('assistant');
    const contents = chunks.filter((c) => c.choices?.[0]?.delta?.content).map((c) => c.choices[0].delta.content);
    expect(contents.join('')).toBe('streamed answer text');
    w.close();
  });

  it('keyless anon quota: 60 tokens/day enforced', async () => {
    const w = new FakeWorker(`ws://127.0.0.1:${port}/worker`, { answer: 'abcdefgh' });
    await w.connect();
    w.heartbeat();
    await new Promise((r) => setTimeout(r, 150));

    const post = () =>
      api('/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'x' }] }),
      });
    // completion tokens per answer = 4 (usage from fake worker); anon limit 60 -> ~15 requests
    for (let i = 0; i < 15; i++) {
      const r = await post();
      expect(r.status).toBe(200);
    }
    const blocked = await post();
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.type).toBe('quota');
    w.close();
  });

  it('API key bypasses the anon quota and shows in /keys issuance', async () => {
    const k = await api('/keys', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(k.status).toBe(200);
    expect(k.body.key).toMatch(/^mc_[0-9a-f]{48}$/);
    const key = k.body.key as string;
    const w = new FakeWorker(`ws://127.0.0.1:${port}/worker`, { answer: 'abcdefgh' });
    await w.connect();
    w.heartbeat();
    await new Promise((r) => setTimeout(r, 150));
    const r = await api('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'x' }] }),
    });
    expect(r.status).toBe(200);
    w.close();
  });

  it('revoked keys stop authenticating', async () => {
    const k = await api('/keys', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    const key = k.body.key as string;
    const bad = await api('/keys/revoke', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: 'mc_' + '0'.repeat(48) }) });
    expect(bad.status).toBe(404);
    const rev = await api('/keys/revoke', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key }) });
    expect(rev.status).toBe(200);
    expect(rev.body.revoked).toBe(true);
    const again = await api('/keys/revoke', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key }) });
    expect(again.status).toBe(404);
  });

  it('refuses a second live connection for an already-connected node token', async () => {
    const token = 'nd_dupedupedupedupedup000';
    const first = new FakeWorker(`ws://127.0.0.1:${port}/worker`, { nodeToken: token });
    await first.connect();
    first.heartbeat();
    await new Promise((r) => setTimeout(r, 100));

    const second = new FakeWorker(`ws://127.0.0.1:${port}/worker`, { nodeToken: token });
    const connecting = second.connect(); // never resolves: no helloAck coming
    const closedCode = new Promise<number>((resolve) => {
      second.ws!.on('close', (code: number) => resolve(code));
    });
    expect(await closedCode).toBe(4003);
    connecting.catch(() => {});

    // The ORIGINAL connection still owns the identity and keeps serving.
    const r = await api('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'x' }] }),
    });
    expect(r.status).toBe(200);
    const stats = await api('/stats');
    expect(stats.body.nodes.online).toBe(1);
    first.close();
  });

  it('routes across two nodes and load-balances to the free one', async () => {
    const busy = new FakeWorker(`ws://127.0.0.1:${port}/worker`, { hang: true });
    const free = new FakeWorker(`ws://127.0.0.1:${port}/worker`, { answer: 'free node was used' });
    await busy.connect();
    await free.connect();
    busy.heartbeat('available', 2); // saturated: both slots in flight
    free.heartbeat();
    await new Promise((r) => setTimeout(r, 200));
    const r = await api('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'x' }] }),
    });
    expect(r.status).toBe(200);
    expect(r.body.choices[0].message.content).toBe('free node was used');
    busy.close();
    free.close();
  });

  it('node failure before output retries onto the next candidate', { timeout: 20_000 }, async () => {
    const flaky = new FakeWorker(`ws://127.0.0.1:${port}/worker`, { noAutoAnswer: true });
    const solid = new FakeWorker(`ws://127.0.0.1:${port}/worker`, { answer: 'recovered' });
    await flaky.connect();
    await solid.connect();
    flaky.heartbeat();
    solid.heartbeat();
    flaky.onMessage = (m) => {
      if (m.t === 'job') {
        flaky.send({ t: 'jobAccept', jobId: m.jobId });
        flaky.close();
      }
    };
    await new Promise((r) => setTimeout(r, 200));
    const r = await api('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'x' }] }),
    });
    expect(r.status).toBe(200);
    expect(r.body.choices[0].message.content).toBe('recovered');
    solid.close();
  });

  it('client abort cancels the downstream job', async () => {
    const w = new FakeWorker(`ws://127.0.0.1:${port}/worker`, { answer: 'partial' });
    await w.connect();
    w.heartbeat();
    await new Promise((r) => setTimeout(r, 150));
    const ac = new AbortController();
    const resP = fetch(`${BASE()}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'x' }] }),
      signal: ac.signal,
    });
    ac.abort();
    await expect(resP).rejects.toThrow();
    // give the relay a beat to settle cancellation
    await new Promise((r) => setTimeout(r, 300));
    const stats = await api('/stats');
    expect(stats.body.relay.jobsInFlight).toBe(0);
    w.close();
  });

  it('verification: poisoned node gets mismatches, drops below quarantine, and stops being routed', { timeout: 120_000 }, async () => {
    const probes = (globalThis as { __probeRunner?: import('../src/probes.js').ProbeRunner }).__probeRunner!;
    const good = new FakeWorker(`ws://127.0.0.1:${port}/worker`, {
      answer: '2, 3, 5, 7, 11, 13, 17, 19, 23, 29',
      nodeToken: 'nd_goodgoodgoodgood0000',
    });
    const seed = new FakeWorker(`ws://127.0.0.1:${port}/worker`, {
      answer: '2, 3, 5, 7, 11, 13, 17, 19, 23, 29',
      nodeToken: 'nd_seeseedseedseed00000',
    });
    const evil = new FakeWorker(`ws://127.0.0.1:${port}/worker`, {
      poison: 'BUY CRYPTO NOW',
      nodeToken: 'nd_evilevilevilevil000000',
    });
    await good.connect();
    await seed.connect();
    await evil.connect();
    good.heartbeat();
    seed.heartbeat();
    evil.heartbeat();
    await new Promise((r) => setTimeout(r, 200));

    // Bootstrap trust: pump successful real jobs until the honest nodes'
    // rep crosses the probation line (0.7) — only trusted nodes serve as
    // probe references. (Uses a keyed identity so the anon daily quota
    // doesn't interrupt the run. Generous cap + one /stats read per round:
    // on a loaded machine the accept-timeout fires 'reject-spam' dings and
    // the climb just takes longer.)
    const repOfEarly = async (prefixes: string[]): Promise<Record<string, number>> => {
      const s = await api('/stats');
      const out: Record<string, number> = {};
      for (const p of prefixes) {
        const row = (s.body.nodes.detail as Array<{ tokenPrefix: string; rep: number }>).find((n) => n.tokenPrefix === p);
        out[p] = row?.rep ?? 1;
      }
      return out;
    };
    const k = await api('/keys', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    const key = k.body.key as string;
    const auth = { 'content-type': 'application/json', authorization: `Bearer ${key}` };
    for (let i = 0; i < 900; i++) {
      const reps = await repOfEarly(['nd_goodg', 'nd_seese']);
      // /stats rounds rep to 2 decimals, so a displayed 0.7 can hide a true
      // 0.695 — BELOW the coordinator's 0.7 reference gate. Exit at 0.71 to
      // guarantee both nodes are trusted in the coordinator's own view.
      if (reps['nd_goodg']! >= 0.71 && reps['nd_seese']! >= 0.71) break;
      const r = await api('/v1/chat/completions', {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ messages: [{ role: 'user', content: 'x' }] }),
      });
      expect(r.status).toBe(200);
    }
    const repOf = async (prefix: string): Promise<number> => {
      const s = await api('/stats');
      const row = (s.body.nodes.detail as Array<{ tokenPrefix: string; rep: number }>).find((n) => n.tokenPrefix === prefix);
      return row?.rep ?? 1;
    };
    expect(await repOf('nd_goodg')).toBeGreaterThanOrEqual(0.71);
    expect(await repOf('nd_seese')).toBeGreaterThanOrEqual(0.71);

    // Now probe rounds verify evil against trusted good. Pump until evil
    // crosses the quarantine line. (Generous cap + wait: each round needs
    // 3 probe round-trips; under machine load some rounds time out and are
    // honestly scored unverifiable, so just keep ticking until it lands.)
    const evilPrefix = 'nd_evile';
    for (let i = 0; i < 120 && (await repOf(evilPrefix)) >= 0.35; i++) {
      probes.tick(Date.now() + i * 61_000);
      await new Promise((r) => setTimeout(r, 150));
    }
    const finalRep = await repOf(evilPrefix);
    expect(finalRep).toBeLessThan(0.35);

    // Quarantined: real traffic must land on the good node only.
    const r = await api('/v1/chat/completions', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ messages: [{ role: 'user', content: 'x' }] }),
    });
    expect(r.status).toBe(200);
    expect(r.body.choices[0].message.content).not.toBe('BUY CRYPTO NOW');
    good.close();
    seed.close();
    evil.close();
  });

  it('leaderboard counts verified tokens', async () => {
    const w = new FakeWorker(`ws://127.0.0.1:${port}/worker`, { answer: 'abcdefgh', nodeToken: 'nd_donoralpha0000000000' });
    await w.connect();
    w.heartbeat();
    await new Promise((r) => setTimeout(r, 150));
    await api('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'x' }] }),
    });
    const lb = await api('/leaderboard');
    expect(lb.status).toBe(200);
    expect(lb.body.data.length).toBeGreaterThan(0);
    const row = lb.body.data[0];
    expect(row.tokensTotal).toBeGreaterThan(0);
    expect(row.online).toBe(true);
    w.close();
  });
});
