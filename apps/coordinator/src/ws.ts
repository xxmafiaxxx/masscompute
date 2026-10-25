// Worker WebSocket endpoint at /worker. Workers dial OUT to this; the
// coordinator never opens connections to donor machines.

import { randomBytes } from 'node:crypto';
import type { W2C } from '@masscompute/protocol';
import { MODEL_CATALOG, PROTOCOL_VERSION } from '@masscompute/protocol';
import type { WebSocket } from 'ws';
import { WebSocketServer } from 'ws';
import type { Config } from './config.js';
import type { Metrics } from './metrics.js';
import type { ProbeRunner } from './probes.js';
import { NodeConn, type Registry } from './registry.js';
import type { Relay } from './relay.js';
import type { Store } from './store.js';

interface Deps {
  registry: Registry;
  relay: Relay;
  store: Store;
  metrics: Metrics;
  probes: ProbeRunner;
  config: Config;
}

export function attachWorkerWs(server: import('node:http').Server, deps: Deps): WebSocketServer {
  const wss = new WebSocketServer({ server, path: '/worker' });
  const { registry, relay, store, config } = deps;

  wss.on('connection', (ws: WebSocket) => {
    let conn: NodeConn | null = null;
    let lastFrameAt = Date.now();
    let helloTimer: NodeJS.Timeout | undefined;

    const dropIfSilent = () => {
      if (Date.now() - lastFrameAt > config.workerSilentMs) ws.terminate();
    };
    const silenceTimer = setInterval(dropIfSilent, 15_000);

    helloTimer = setTimeout(() => {
      if (!conn) ws.close(4001, 'expected hello');
    }, 5_000);

    ws.on('message', (raw) => {
      lastFrameAt = Date.now();
      let m: unknown;
      try {
        m = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (typeof m !== 'object' || m === null || !('t' in m)) return;
      const msg = m as W2C;

      if (!conn) {
        if (msg.t !== 'hello') return;
        if (msg.proto !== PROTOCOL_VERSION) {
          ws.close(4002, 'protocol version mismatch; update the worker');
          return;
        }
        const token = msg.nodeToken ?? `nd_${randomBytes(16).toString('hex')}`;
        // Identity takeover guard: if a live connection already holds this
        // token, refuse the newcomer instead of silently replacing it.
        // (A stale socket stops heartbeating and the silence timer reaps it,
        // after which a reconnecting worker gets back in.)
        const prev = registry.get(token);
        if (prev && Date.now() - prev.lastHeartbeatAt < 15_000) {
          ws.close(4003, 'node identity already connected');
          return;
        }
        const row = store.getNode(token);
        conn = new NodeConn(ws, row, msg, token);
        registry.register(conn);
        store.upsertNode({
          token,
          name: conn.name,
          firstSeen: row?.firstSeen ?? Date.now(),
          lastSeen: Date.now(),
          tokensTotal: row?.tokensTotal ?? 0,
          verifiedTokens: row?.verifiedTokens ?? 0,
          jobsDone: row?.jobsDone ?? 0,
          jobsFailed: row?.jobsFailed ?? 0,
          rep: conn.rep,
          repEvents: conn.repEvents,
        });
        conn.send({ t: 'helloAck', proto: PROTOCOL_VERSION, nodeToken: token, catalog: MODEL_CATALOG, heartbeatMs: config.heartbeatMs });
        if (helloTimer) clearTimeout(helloTimer);
        return;
      }

      switch (msg.t) {
        case 'heartbeat':
          conn.state = msg.state;
          conn.lastHeartbeatAt = Date.now();
          // The worker owns its queue count; trust it so a lost gen.done
          // cannot wedge this node's slot accounting forever.
          conn.jobsInFlight = msg.jobsInFlight;
          // Heartbeat path must NEVER go through upsertNode: it carries zeros
          // for the lifetime counters and the JSON fallback store replaces
          // whole rows (wiping tokens/jobs every 5s). touchNode is the
          // presence/rep-only update.
          store.touchNode(conn.token, conn.name, conn.rep, conn.repEvents);
          break;
        case 'models':
          conn.models = new Set(msg.models);
          break;
        case 'slots':
          conn.slots = Math.max(1, Math.min(16, msg.slots));
          break;
        case 'benchmark':
        case 'pong':
          break;
        case 'jobAccept':
        case 'jobReject':
        case 'gen':
          relay.handle(conn, msg);
          break;
        default:
          break;
      }
      deps.probes.tick();
    });

    ws.on('close', () => {
      if (helloTimer) clearTimeout(helloTimer);
      clearInterval(silenceTimer);
      if (conn) {
        relay.failAllForNode(conn);
        registry.unregister(conn);
      }
    });

    ws.on('error', () => ws.terminate());
  });

  return wss;
}
