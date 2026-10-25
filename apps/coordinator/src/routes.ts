// Public API routes: OpenAI-compatible chat completions (SSE + plain),
// model listing, cluster stats, leaderboard, and key issuance.

import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { DEFAULT_MODEL_ID, MODEL_CATALOG, catalogEntry } from '@masscompute/protocol';
import type { Config } from './config.js';
import type { Metrics } from './metrics.js';
import type { ProbeRunner } from './probes.js';
import type { RateLimiter } from './ratelimit.js';
import type { Registry } from './registry.js';
import type { Relay } from './relay.js';
import { issueKey, quotaUsed, recordUsage, resolveKey } from './keys.js';
import { sha256, type Store } from './store.js';
import { estimateTokens } from './scheduler.js';

export interface RouteDeps {
  registry: Registry;
  relay: Relay;
  store: Store;
  metrics: Metrics;
  probes: ProbeRunner;
  config: Config;
  reqLimiter: RateLimiter;
  keyLimiter: RateLimiter;
}

const MAX_PROMPT_CHARS = 48_000;
const MAX_MESSAGE_CHARS = 32_000;
const MAX_MAX_TOKENS = 2_048;

interface ChatBody {
  model?: string;
  messages?: Array<{ role?: string; content?: string }>;
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stop?: string[];
}

export function registerRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { registry, relay, store, metrics, config } = deps;

  app.get('/healthz', async () => ({ ok: true, uptimeSec: metrics.snapshot().uptimeSec }));

  app.get('/v1/models', async () => {
    const counts = new Map<string, number>();
    for (const n of registry.all()) {
      if (n.state !== 'available') continue;
      for (const m of n.models) counts.set(m, (counts.get(m) ?? 0) + 1);
    }
    return {
      object: 'list',
      data: MODEL_CATALOG.map((m) => ({
        id: m.id,
        object: 'model',
        created: 1_700_000_000,
        owned_by: 'masscompute-grid',
        masscompute: { label: m.label, tier: m.tier, nodesServing: counts.get(m.id) ?? 0 },
      })),
    };
  });

  app.post<{ Body: ChatBody }>('/v1/chat/completions', async (req, reply) => {
    const ip = req.ip;
    if (!deps.reqLimiter.allow(ip)) {
      return reply.code(429).send({ error: { message: 'rate limit exceeded; get an API key or slow down', type: 'rate_limit' } });
    }
    const keyCtx = resolveKey(store, bearer(req.headers.authorization), ip, config.keyDailyTokens, config.anonDailyTokens);
    const used = quotaUsed(store, keyCtx);
    if (used >= keyCtx.dailyLimit) {
      return reply.code(429).send({
        error: {
          message: `daily quota exhausted (${used}/${keyCtx.dailyLimit} completion tokens). ${keyCtx.keyHash ? 'quota resets at midnight UTC' : 'get a free API key at /keys for a 60x larger quota'}`,
          type: 'quota',
        },
      });
    }

    const body = req.body ?? {};
    const v = validateChat(body);
    if (!v.ok) return reply.code(400).send({ error: { message: v.error, type: 'invalid_request' } });
    const { messages, params, stream } = v;
    const model = body.model ?? DEFAULT_MODEL_ID;
    const entry = catalogEntry(model);
    if (!entry) {
      return reply.code(400).send({ error: { message: `unknown model "${model}"; see GET /v1/models`, type: 'invalid_request' } });
    }

    const promptChars = messages.reduce((n, m) => n + m.content.length, 0);
    const id = `chatcmc-${randomUUID().replace(/-/g, '').slice(0, 24)}`;
    const created = Math.floor(Date.now() / 1000);
    const abort = new AbortController();
    // Cancel downstream work only when the CLIENT disconnects. (req.raw
    // 'close' fires when Fastify finishes reading the body — watching it
    // would abort every job before it starts.)
    reply.raw.on('close', () => {
      if (!reply.raw.writableEnded) abort.abort();
    });

    if (stream) {
      reply.hijack();
      const res = reply.raw;
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      const send = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
      send({
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
      });
      let r: Awaited<ReturnType<Relay['run']>>;
      try {
        r = await relay.run({
          model,
          messages,
          params,
          signal: abort.signal,
          onDelta: (d) => send({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { content: d }, finish_reason: null }] }),
        });
      } catch (e) {
        // The reply is hijacked — Fastify's error handler can't help here.
        res.write(`data: ${JSON.stringify({ error: { message: (e as Error).message ?? 'grid error', type: 'grid_error' } })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      recordUsage(store, keyCtx, r.usage.completionTokens);
      if (!r.ok && r.text === '') {
        res.write(`data: ${JSON.stringify({ error: { message: r.error ?? 'grid error', type: 'grid_error' } })}\n\n`);
      } else {
        send({
          id,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [{ index: 0, delta: {}, finish_reason: r.cancelled ? 'length' : 'stop' }],
          usage: { prompt_tokens: r.usage.promptTokens, completion_tokens: r.usage.completionTokens, total_tokens: r.usage.promptTokens + r.usage.completionTokens },
          masscompute: { node: r.nodeToken?.slice(0, 8) ?? null, verified: true },
        });
      }
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    const r = await relay.run({ model, messages, params, signal: abort.signal });
    recordUsage(store, keyCtx, r.usage.completionTokens);
    if (!r.ok && r.text === '') {
      const code = r.error?.includes('no nodes') || r.error?.includes('no free capacity') ? 503 : 502;
      return reply.code(code).send({ error: { message: r.error ?? 'grid error', type: 'grid_error' } });
    }
    return {
      id,
      object: 'chat.completion',
      created,
      model,
      choices: [{ index: 0, message: { role: 'assistant', content: r.text }, finish_reason: r.cancelled ? 'length' : 'stop' }],
      usage: { prompt_tokens: r.usage.promptTokens, completion_tokens: r.usage.completionTokens, total_tokens: r.usage.promptTokens + r.usage.completionTokens },
      masscompute: { node: r.nodeToken?.slice(0, 8) ?? null },
    };
  });

  app.get('/stats', async () => {
    const nodes = registry.snapshot();
    const byState: Record<string, number> = {};
    for (const n of nodes) byState[n.state] = (byState[n.state] ?? 0) + 1;
    const modelNodes: Record<string, number> = {};
    for (const n of nodes) if (n.state === 'available') for (const m of n.models) modelNodes[m] = (modelNodes[m] ?? 0) + 1;
    return {
      metrics: metrics.snapshot(),
      nodes: {
        online: nodes.length,
        available: byState['available'] ?? 0,
        byState,
        detail: nodes,
      },
      models: modelNodes,
      probes: { sent: deps.probes.probesSent, recentVerdicts: deps.probes.lastVerdicts.slice(-10) },
      relay: { jobsInFlight: relay.inFlight() },
      quotas: { keyDailyTokens: config.keyDailyTokens, anonDailyTokens: config.anonDailyTokens },
      promptCharsLimit: MAX_PROMPT_CHARS,
    };
  });

  app.get('/leaderboard', async () => {
    const live = new Map(registry.all().map((n) => [n.token, n]));
    const rows = new Map<string, { name: string; verifiedTokens: number; tokensTotal: number; online: boolean; rep: number }>();
    for (const n of registry.all()) {
      rows.set(n.token, {
        name: n.name ?? `node-${n.token.slice(0, 8)}`,
        verifiedTokens: 0,
        tokensTotal: n.sessionTokens,
        online: true,
        rep: Math.round(n.rep * 100) / 100,
      });
    }
    // Lifetime totals from the store for nodes seen ever (online or not).
    // JSON store has no listAll; SQLite covers it via nodes table — for the
    // JSON fallback the leaderboard shows live sessions only. Acceptable v1.
    const sqlAny = store as unknown as { db?: { prepare(q: string): { all(): Array<Record<string, unknown>> } } };
    if (sqlAny.db) {
      try {
        for (const raw of sqlAny.db.prepare('SELECT * FROM nodes ORDER BY verified_tokens DESC LIMIT 200').all()) {
          const token = raw.token as string;
          const existing = rows.get(token);
          const verified = raw.verified_tokens as number;
          const total = raw.tokens_total as number;
          if (existing) {
            existing.verifiedTokens = Math.max(existing.verifiedTokens, verified);
            existing.tokensTotal = Math.max(existing.tokensTotal, total);
          } else {
            rows.set(token, {
              name: (raw.name as string | null) ?? `node-${token.slice(0, 8)}`,
              verifiedTokens: verified,
              tokensTotal: total,
              online: live.has(token),
              rep: Math.round((raw.rep as number) * 100) / 100,
            });
          }
        }
      } catch {
        /* JSON fallback */
      }
    }
    const list = [...rows.values()]
      .map((r) => ({ ...r, verifiedTokens: Math.max(r.verifiedTokens, 0) }))
      .sort((a, b) => b.verifiedTokens - a.verifiedTokens || b.tokensTotal - a.tokensTotal)
      .slice(0, 50);
    return { object: 'list', data: list };
  });

  app.post<{ Body: { name?: string } }>('/keys', async (req, reply) => {
    if (!deps.keyLimiter.allow(`k:${req.ip}`)) {
      return reply.code(429).send({ error: { message: 'too many key requests from this IP', type: 'rate_limit' } });
    }
    const name = typeof req.body?.name === 'string' ? req.body.name.slice(0, 64) : null;
    const key = issueKey(store, name);
    return { key, name, daily_token_quota: config.keyDailyTokens, note: 'store this key; it cannot be recovered. Revoke it anytime via POST /keys/revoke.' };
  });

  // Self-service revocation: present the key itself, no auth needed (the key
  // IS the credential — whoever holds it can kill it).
  app.post<{ Body: { key?: string } }>('/keys/revoke', async (req, reply) => {
    if (!deps.keyLimiter.allow(`k:${req.ip}`)) {
      return reply.code(429).send({ error: { message: 'too many key requests from this IP', type: 'rate_limit' } });
    }
    const key = typeof req.body?.key === 'string' ? req.body.key.trim() : '';
    if (!/^mc_[0-9a-f]{48}$/.test(key)) {
      return reply.code(400).send({ error: { message: 'send the key to revoke as { "key": "mc_…" }', type: 'invalid_request' } });
    }
    const hash = sha256(key);
    if (!store.getKey(hash)) {
      return reply.code(404).send({ error: { message: 'unknown key', type: 'not_found' } });
    }
    store.deleteKey(hash);
    return { revoked: true };
  });
}

function bearer(h: string | undefined): string | undefined {
  const m = /^Bearer\s+(.+)$/i.exec(h ?? '');
  return m?.[1];
}

function validateChat(body: ChatBody): { ok: true; messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>; params: { temperature?: number; top_p?: number; max_tokens?: number; stop?: string[] }; stream: boolean } | { ok: false; error: string } {
  if (!Array.isArray(body.messages) || body.messages.length === 0) return { ok: false, error: 'messages[] required' };
  if (body.messages.length > 64) return { ok: false, error: 'too many messages (max 64)' };
  let chars = 0;
  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [];
  for (const m of body.messages) {
    if (m.role !== 'system' && m.role !== 'user' && m.role !== 'assistant') return { ok: false, error: `invalid role "${m.role}"` };
    if (typeof m.content !== 'string' || m.content.length === 0) return { ok: false, error: 'message content must be a non-empty string' };
    if (m.content.length > MAX_MESSAGE_CHARS) return { ok: false, error: `message too long (max ${MAX_MESSAGE_CHARS} chars)` };
    chars += m.content.length;
    messages.push({ role: m.role, content: m.content });
  }
  if (chars > MAX_PROMPT_CHARS) return { ok: false, error: `prompt too long (${chars} > ${MAX_PROMPT_CHARS} chars)` };
  const params: { temperature?: number; top_p?: number; max_tokens?: number; stop?: string[] } = {};
  if (body.temperature !== undefined) {
    if (body.temperature < 0 || body.temperature > 2) return { ok: false, error: 'temperature must be 0..2' };
    params.temperature = body.temperature;
  }
  if (body.top_p !== undefined) {
    if (body.top_p <= 0 || body.top_p > 1) return { ok: false, error: 'top_p must be (0,1]' };
    params.top_p = body.top_p;
  }
  if (body.max_tokens !== undefined) {
    if (!Number.isInteger(body.max_tokens) || body.max_tokens < 1) return { ok: false, error: 'max_tokens must be a positive integer' };
    params.max_tokens = Math.min(body.max_tokens, MAX_MAX_TOKENS);
  }
  if (body.stop !== undefined) {
    if (!Array.isArray(body.stop) || body.stop.length > 4) return { ok: false, error: 'stop must be an array of up to 4 strings' };
    params.stop = body.stop.map(String).slice(0, 64);
  }
  return { ok: true, messages, params, stream: body.stream === true };
}

export { estimateTokens };
