// MassCompute coordinator entrypoint.

import fs from 'node:fs';
import path from 'node:path';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { loadConfig } from './config.js';
import { Metrics } from './metrics.js';
import { ProbeRunner } from './probes.js';
import { applyEvent } from './reputation.js';
import { RateLimiter } from './ratelimit.js';
import { Registry } from './registry.js';
import { Relay } from './relay.js';
import { registerRoutes } from './routes.js';
import { openStore } from './store.js';
import { attachWorkerWs } from './ws.js';

const config = loadConfig();
const store = openStore(config.dataDir);
const registry = new Registry();
const metrics = new Metrics();
const relay = new Relay(registry, metrics, store, config);
const probes = new ProbeRunner(registry, relay, (conn, v) => {
  // Verification outcomes land in the same reputation EWMA as job outcomes.
  const kinds = { match: 'probe-match', mismatch: 'probe-mismatch', unverifiable: 'probe-unverifiable' } as const;
  const s = applyEvent({ rep: conn.rep, events: conn.repEvents }, kinds[v]);
  conn.rep = s.rep;
  conn.repEvents = s.events;
  store.setNodeRep(conn.token, s.rep, s.events);
}, config);

// trustProxy: on fly.io every request arrives via the fly proxy, so req.ip
// would otherwise be the proxy address — collapsing ALL anonymous callers
// into one shared rate-limit + quota bucket.
const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' }, bodyLimit: 2_000_000, trustProxy: true });
await app.register(cors, { origin: true });

registerRoutes(app, {
  registry,
  relay,
  store,
  metrics,
  probes,
  config,
  reqLimiter: new RateLimiter(Number(process.env.RATE_REQ_PER_MIN ?? 30), 60_000),
  keyLimiter: new RateLimiter(5, 3_600_000),
});

// Web dashboard — must register before listen() (Fastify plugin boot rules).
if (config.webDir && fs.existsSync(path.resolve(config.webDir))) {
  await app.register(fastifyStatic, { root: path.resolve(config.webDir), prefix: '/', decorateReply: true });
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/v1') || req.url.startsWith('/api') || req.url.startsWith('/stats') || req.url.startsWith('/leaderboard') || req.url.startsWith('/keys')) {
      return reply.code(404).send({ error: { message: 'not found' } });
    }
    const index = path.join(path.resolve(config.webDir!), 'index.html');
    if (fs.existsSync(index)) return reply.type('text/html').send(fs.readFileSync(index));
    return reply.code(404).send({ error: { message: 'not found' } });
  });
}

// Housekeeping sweep: dead-socket detection + limiter memory + probe tick.
setInterval(() => {
  probes.tick();
  const now = Date.now();
  for (const n of registry.all()) {
    if (now - n.lastHeartbeatAt > config.workerSilentMs * 2) {
      n.ws.terminate();
    }
  }
}, 15_000);

const port = config.port;
await app.listen({ port, host: '0.0.0.0' });
// Fastify owns the request listener; attach the WS upgrade path to its server.
const fastifyServer = app.server;
attachWorkerWs(fastifyServer, { registry, relay, store, metrics, probes, config });

const shutdown = () => {
  app.close().finally(() => {
    store.close();
    process.exit(0);
  });
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

app.log.info(`MassCompute coordinator listening on :${port} (web: ${config.webDir ?? 'bundled-when-built'})`);

