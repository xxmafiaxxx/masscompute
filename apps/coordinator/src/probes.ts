// ProbeRunner: periodic verification of donor nodes. For each node up for a
// probe, send the same deterministic prompt (temp 0) to the node AND to its
// two highest-reputation peers serving the same model, then compare.

import type { NodeConn, Registry } from './registry.js';
import type { Relay } from './relay.js';
import { REP_PROBATION, shouldProbe } from './reputation.js';
import { nextProbe, verdict, type ProbeVerdict } from './verify.js';

interface ProbeRound {
  targetToken: string;
  model: string;
  prompt: string;
  maxTokens: number;
  results: Map<string, string>; // nodeToken -> output ('' still counts once settled)
  settled: Map<string, boolean>;
  refTokens: string[];
  timer: NodeJS.Timeout;
}

export class ProbeRunner {
  private rounds = new Map<string, ProbeRound>(); // roundId -> round
  private lastProbeAt = new Map<string, number>();
  probesSent = 0;
  lastVerdicts: Array<{ node: string; verdict: ProbeVerdict; at: number }> = [];

  constructor(
    private registry: Registry,
    private relay: Relay,
    private onVerdict: (conn: NodeConn, v: ProbeVerdict) => void,
    private cfg: { probeIntervalMs: number; jobTimeoutMs: number },
  ) {}

  /** Call on every heartbeat sweep (cheap; internal cadence per node). */
  tick(now = Date.now()): void {
    for (const conn of this.registry.all()) {
      if (conn.state !== 'available' && conn.state !== 'warming') continue;
      if (conn.models.size === 0) continue;
      const last = this.lastProbeAt.get(conn.token) ?? 0;
      const repState = { rep: conn.rep, events: conn.repEvents };
      if (!shouldProbe(repState, this.cfg.probeIntervalMs, now, last)) continue;
      // One model per round: the first the node serves (deterministic enough).
      const model = [...conn.models][0];
      if (!model) continue;
      this.lastProbeAt.set(conn.token, now);
      this.fireRound(conn, model, now);
    }
  }

  private fireRound(target: NodeConn, model: string, now: number): void {
    // References must be TRUSTED nodes (above probation, earned via real job
    // successes). Otherwise two equal-rep nodes would judge each other and
    // both crater. A grid with no trusted node serving the model yet is
    // honestly unverifiable.
    const refs = this.registry
      .nodesServing(model)
      .filter((n) => n.token !== target.token && n.rep >= REP_PROBATION)
      .sort((a, b) => b.rep - a.rep)
      .slice(0, 2);
    if (refs.length < 2) {
      // verdict() needs >=2 references for ground truth — a lone-ref round
      // would burn donor GPU time and still come back unverifiable.
      this.record(target, 'unverifiable', now);
      return;
    }
    const spec = nextProbe(target.token.length + this.probesSent + Math.floor(now / 60_000));
    const roundId = `${target.token}:${now}`;
    const round: ProbeRound = {
      targetToken: target.token,
      model,
      prompt: spec.prompt,
      maxTokens: spec.maxTokens,
      results: new Map(),
      settled: new Map(),
      refTokens: refs.map((r) => r.token),
      timer: setTimeout(() => this.settle(roundId), this.cfg.jobTimeoutMs + 5_000),
    };
    this.rounds.set(roundId, round);
    for (const conn of [target, ...refs]) {
      void this.relay
        .run({
          model,
          messages: [{ role: 'user', content: round.prompt }],
          params: { temperature: 0, max_tokens: round.maxTokens },
          isProbe: true,
          onlyToken: conn.token,
        })
        .then((r) => {
          if (round.results.has(conn.token)) return; // settled already
          round.results.set(conn.token, r.ok ? r.text : `\u0000fail:${r.error ?? ''}`);
          round.settled.set(conn.token, true);
          this.maybeSettle(roundId);
        });
      this.probesSent++;
    }
  }

  private maybeSettle(roundId: string): void {
    const round = this.rounds.get(roundId);
    if (!round) return;
    const all = [round.targetToken, ...round.refTokens];
    if (all.every((t) => round.settled.get(t))) this.settle(roundId);
  }

  private settle(roundId: string): void {
    const round = this.rounds.get(roundId);
    if (!round) return;
    this.rounds.delete(roundId);
    clearTimeout(round.timer);
    const target = this.registry.get(round.targetToken);
    if (!target) return;
    const targetOut = round.results.get(round.targetToken);
    if (targetOut === undefined || targetOut.startsWith('\u0000fail:')) return; // no signal
    const refOuts = round.refTokens.map((t) => round.results.get(t)).filter((o): o is string => typeof o === 'string' && !o.startsWith('\u0000fail:'));
    const v = verdict(targetOut, refOuts);
    this.onVerdict(target, v);
    this.record(target, v, Date.now());
  }

  /** lastVerdicts feeds the PUBLIC /stats endpoint — keep tokens prefixed. */
  private record(target: NodeConn, v: ProbeVerdict, at: number): void {
    this.lastVerdicts.push({ node: target.token.slice(0, 8), verdict: v, at });
    if (this.lastVerdicts.length > 100) this.lastVerdicts.shift();
  }
}
