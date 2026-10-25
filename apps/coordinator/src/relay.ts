// Job relay: the lifecycle of one generation request from the public API to
// a worker node and back. Handles accept timeouts, node retry before first
// token, streaming, cancellation, and per-node failure accounting.

import { randomUUID } from 'node:crypto';
import type { ChatMessage, ChatParams, Usage, W2C } from '@masscompute/protocol';
import type { NodeConn, Registry } from './registry.js';
import { estimateTokens, schedule } from './scheduler.js';
import type { Metrics } from './metrics.js';
import type { Store } from './store.js';
import { applyEvent, isQuarantined, REP_QUARANTINE, type RepEventKind } from './reputation.js';

export interface RunJobInput {
  model: string;
  messages: ChatMessage[];
  params: ChatParams;
  /** Synthetic verification probe: no user attached, temp forced 0. */
  isProbe?: boolean;
  /** Pin the job to this exact node (probes): no scheduling, no retry. */
  onlyToken?: string;
  maxTokensOverride?: number;
  onDelta?: (text: string) => void;
  signal?: AbortSignal;
}

export interface RunJobResult {
  ok: boolean;
  text: string;
  usage: Usage;
  error?: string;
  nodeToken?: string;
  msTotal?: number;
  cancelled?: boolean;
}

interface PendingJob {
  jobId: string;
  conn: NodeConn;
  resolve: (r: RunJobResult) => void;
  onDelta?: (text: string) => void;
  text: string;
  streamed: boolean;
  usage: Usage;
  startedAt: number;
  accepted: boolean;
  settled: boolean;
}

export class Relay {
  private pending = new Map<string, PendingJob>();
  /** Jobs the COORDINATOR cancelled (caller abort / timeout). A worker
   * reporting error 'cancelled' is only neutral if its job is in this set —
   * otherwise nodes could dodge failure accounting. */
  private cancelledHere = new Set<string>();

  constructor(
    private registry: Registry,
    private metrics: Metrics,
    private store: Store,
    private cfg: { jobAcceptTimeoutMs: number; jobTimeoutMs: number },
  ) {}

  async run(input: RunJobInput): Promise<RunJobResult> {
    // Probe traffic is internal bookkeeping — keep it out of the public
    // request counters so /stats reflects real API usage.
    if (!input.isProbe) this.metrics.requestsTotal++;
    let picks: string[];
    let reason: string;
    if (input.onlyToken) {
      // Verification probes MUST be answered by the exact node under test.
      picks = [input.onlyToken];
      reason = 'ok';
    } else {
      const nodes = this.registry.all().map((n) => ({
        token: n.token,
        models: n.models,
        state: n.state,
        jobsInFlight: n.jobsInFlight,
        slots: n.slots,
        rep: n.rep,
      }));
      ({ picks, reason } = schedule(input.model, nodes));
    }
    if (picks.length === 0) {
      if (!input.isProbe) this.metrics.requestsFailed++;
      return {
        ok: false,
        text: '',
        usage: { promptTokens: 0, completionTokens: 0 },
        error:
          reason === 'no-model'
            ? `no nodes are serving model "${input.model}"`
            : `grid has no free capacity for "${input.model}" (${reason})`,
      };
    }

    for (const pick of picks) {
      const conn = this.registry.get(pick);
      if (!conn) continue;
      const r = await this.attempt(conn, input);
      // Stop on success, client cancellation, or any failure after bytes
      // were streamed (retrying mid-answer would garble the response).
      if (r.ok || r.cancelled || r.text !== '') return r;
    }
    if (!input.isProbe) this.metrics.requestsFailed++;
    return {
      ok: false,
      text: '',
      usage: { promptTokens: 0, completionTokens: 0 },
      error: 'all candidate nodes failed before producing output',
    };
  }

  private attempt(conn: NodeConn, input: RunJobInput): Promise<RunJobResult> {
    const jobId = randomUUID();
    const startedAt = Date.now();
    return new Promise<RunJobResult>((resolve) => {
      const p: PendingJob = {
        jobId,
        conn,
        resolve,
        onDelta: input.onDelta,
        text: '',
        streamed: false,
        usage: { promptTokens: 0, completionTokens: 0 },
        startedAt,
        accepted: false,
        settled: false,
      };
      this.pending.set(jobId, p);

      const settle = (r: RunJobResult) => {
        if (p.settled) return;
        p.settled = true;
        clearTimeout(acceptTimer);
        clearTimeout(deadline);
        this.pending.delete(jobId);
        resolve(r);
      };

      const acceptTimer = setTimeout(() => {
        if (!p.accepted) {
          this.repEvent(conn, 'reject-spam');
          settle({ ok: false, text: '', usage: { promptTokens: 0, completionTokens: 0 }, error: 'node did not accept the job in time' });
        }
      }, this.cfg.jobAcceptTimeoutMs);

      const deadline = setTimeout(() => {
        if (!p.settled) {
          this.cancelJob(p, 'job timed out');
        }
      }, this.cfg.jobTimeoutMs);

      const params: ChatParams = input.isProbe ? { temperature: 0, max_tokens: input.maxTokensOverride ?? 48 } : { ...input.params };

      const onAbort = () => {
        if (!p.settled) this.cancelJob(p, 'cancelled');
      };
      input.signal?.addEventListener('abort', onAbort, { once: true });

      const msg = input.isProbe
        ? { t: 'probe', jobId, model: input.model, prompt: input.messages[0]?.content ?? '', maxTokens: params.max_tokens ?? 48 }
        : { t: 'job', jobId, model: input.model, messages: input.messages, params };
      if (!conn.send(msg)) {
        settle({ ok: false, text: '', usage: { promptTokens: 0, completionTokens: 0 }, error: 'node socket closed' });
      }
    });
  }

  /** Called by the WS layer for every worker->coordinator message. */
  handle(conn: NodeConn, m: W2C): void {
    switch (m.t) {
      case 'jobAccept': {
        const p = this.pending.get(m.jobId);
        if (p && p.conn === conn) {
          p.accepted = true;
          conn.jobsInFlight++;
        }
        return;
      }
      case 'jobReject': {
        const p = this.pending.get(m.jobId);
        if (p && p.conn === conn) {
          p.resolve({ ok: false, text: '', usage: { promptTokens: 0, completionTokens: 0 }, error: `node rejected: ${m.reason}` });
          p.settled = true;
          this.pending.delete(m.jobId);
        }
        return;
      }
      case 'gen': {
        const p = this.pending.get(m.jobId);
        if (!p || p.conn !== conn || p.settled) return;
        if (m.delta !== undefined && m.delta !== '') {
          p.text += m.delta;
          p.streamed = true;
          p.onDelta?.(m.delta);
        }
        if (m.done) {
          const usage: Usage = {
            promptTokens: m.usage?.promptTokens ?? p.usage.promptTokens,
            completionTokens: m.usage?.completionTokens ?? estimateTokens(p.text),
          };
          if (p.accepted) conn.jobsInFlight = Math.max(0, conn.jobsInFlight - 1);
          conn.sessionJobs++;
          const neutralCancel = m.error === 'cancelled' && this.cancelledHere.delete(m.jobId);
          this.account(conn, p, usage, m.error == null || neutralCancel);
          p.settled = true;
          this.pending.delete(m.jobId);
          p.resolve({
            ok: !m.error,
            text: p.text,
            usage,
            error: m.error,
            nodeToken: conn.token,
            msTotal: m.msTotal ?? Date.now() - p.startedAt,
          });
        }
        return;
      }
      default:
        return;
    }
  }

  /** Client abort or timeout: tell the node to stop, bill what was delivered. */
  cancelJob(p: PendingJob, reason: string): void {
    if (p.settled) return;
    this.cancelledHere.add(p.jobId);
    // Workers normally confirm with gen.done error='cancelled', which deletes
    // the entry; expire it regardless so a silent worker cannot leak memory.
    const expire = setTimeout(() => this.cancelledHere.delete(p.jobId), this.cfg.jobTimeoutMs + 60_000);
    expire.unref?.();
    p.conn.send({ t: 'jobCancel', jobId: p.jobId });
    if (p.accepted) p.conn.jobsInFlight = Math.max(0, p.conn.jobsInFlight - 1);
    const tokens = estimateTokens(p.text);
    this.metrics.recordTokens(tokens, 0);
    this.store.addNodeTokens(p.conn.token, tokens, 0, false, false);
    p.settled = true;
    this.pending.delete(p.jobId);
    p.resolve({
      ok: false,
      cancelled: true,
      text: p.text,
      usage: { promptTokens: 0, completionTokens: tokens },
      error: reason,
      nodeToken: p.conn.token,
    });
  }

  /** A node disconnected: settle anything still pending on it (retry-eligible). */
  failAllForNode(conn: NodeConn): void {
    for (const p of [...this.pending.values()]) {
      if (p.conn !== conn || p.settled) continue;
      this.repEvent(conn, 'job-failure');
      p.settled = true;
      this.pending.delete(p.jobId);
      p.resolve({
        ok: false,
        text: p.text,
        usage: { promptTokens: 0, completionTokens: estimateTokens(p.text) },
        error: 'node disconnected',
      });
    }
  }

  inFlight(): number {
    return this.pending.size;
  }

  /** Count usage toward metrics/store + fire the reputation event. */
  private account(conn: NodeConn, p: PendingJob, usage: Usage, success: boolean): void {
    const tokens = usage.promptTokens + usage.completionTokens;
    conn.sessionTokens += tokens;
    const verified = isQuarantined({ rep: conn.rep, events: conn.repEvents }) ? 0 : usage.completionTokens;
    this.metrics.recordTokens(tokens, verified);
    this.store.addNodeTokens(conn.token, tokens, verified, success, !success);
    this.repEvent(conn, success ? 'job-success' : 'job-failure');
  }

  private repEvent(conn: NodeConn, kind: RepEventKind): void {
    const s = applyEvent({ rep: conn.rep, events: conn.repEvents }, kind);
    conn.rep = s.rep;
    conn.repEvents = s.events;
    this.store.setNodeRep(conn.token, s.rep, s.events);
  }
}

export { REP_QUARANTINE };
