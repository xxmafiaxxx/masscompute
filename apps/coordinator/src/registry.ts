// In-memory registry of connected worker nodes.

import type { DonorState, NodeSpecs, W2C } from '@masscompute/protocol';
import type { WebSocket } from 'ws';
import { initialRep } from './reputation.js';
import type { NodeRow } from './store.js';

export interface NodeEventCounts {
  jobsDone: number;
  jobsFailed: number;
}

export class NodeConn {
  readonly token: string;
  name: string | null;
  specs: NodeSpecs;
  models = new Set<string>();
  slots = 1;
  state: DonorState | 'warming' = 'warming';
  jobsInFlight = 0;
  lastHeartbeatAt = 0;
  connectedAt = Date.now();
  /** Reputation 0..1 (persisted across sessions via store). */
  rep: number;
  repEvents: number;
  sessionTokens = 0;
  sessionJobs = 0;
  /** Failed jobs this session (crashes, rejects). */
  sessionFailures = 0;

  constructor(
    readonly ws: WebSocket,
    row: NodeRow | undefined,
    hello: Extract<W2C, { t: 'hello' }>,
    token: string,
  ) {
    this.token = token;
    this.specs = hello.specs;
    this.slots = Math.max(1, Math.min(16, hello.slots));
    this.name = hello.name ?? row?.name ?? null;
    this.models = new Set(hello.models);
    const seed = initialRep();
    this.rep = row?.rep ?? seed.rep;
    this.repEvents = row?.repEvents ?? seed.events;
    this.lastHeartbeatAt = Date.now();
  }

  send(m: unknown): boolean {
    if (this.ws.readyState !== this.ws.OPEN) return false;
    this.ws.send(JSON.stringify(m));
    return true;
  }
}

export class Registry {
  private byToken = new Map<string, NodeConn>();

  register(conn: NodeConn): NodeConn {
    const prev = this.byToken.get(conn.token);
    if (prev && prev.ws !== conn.ws) {
      // Same node identity reconnected (old socket should already be closing).
      prev.ws.close();
    }
    this.byToken.set(conn.token, conn);
    return conn;
  }

  unregister(conn: NodeConn): void {
    if (this.byToken.get(conn.token) === conn) this.byToken.delete(conn.token);
  }

  get(token: string): NodeConn | undefined {
    return this.byToken.get(token);
  }

  all(): NodeConn[] {
    return [...this.byToken.values()];
  }

  nodesServing(model: string): NodeConn[] {
    return this.all().filter((n) => n.models.has(model));
  }

  snapshot(): Array<{
    /** Never expose the full token publicly: /stats is unauthenticated, and
     * a leaked token lets anyone impersonate the node at /worker. */
    tokenPrefix: string;
    name: string | null;
    state: string;
    models: string[];
    slots: number;
    jobsInFlight: number;
    rep: number;
    gpus: string[];
    os: string;
    sessionTokens: number;
  }> {
    return this.all().map((n) => ({
      tokenPrefix: n.token.slice(0, 8),
      name: n.name,
      state: n.state,
      models: [...n.models],
      slots: n.slots,
      jobsInFlight: n.jobsInFlight,
      rep: round2(n.rep),
      gpus: n.specs.gpus.map((g) => g.name),
      os: n.specs.os,
      sessionTokens: n.sessionTokens,
    }));
  }
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}
