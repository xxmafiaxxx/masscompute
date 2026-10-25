// Persistence: API keys + quotas, node identity + lifetime stats.
// node:sqlite when available (Node >=22.13), JSON-file fallback otherwise.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface NodeRow {
  token: string;
  name: string | null;
  firstSeen: number;
  lastSeen: number;
  tokensTotal: number;
  /** Tokens counted toward the leaderboard (served while reputable). */
  verifiedTokens: number;
  jobsDone: number;
  jobsFailed: number;
  rep: number;
  repEvents: number;
}

export interface KeyRow {
  keyHash: string;
  name: string | null;
  createdAt: number;
}

interface SqlStore {
  upsertNode(r: NodeRow): void;
  /** Heartbeat-path update: refresh presence/rep WITHOUT touching lifetime counters. */
  touchNode(token: string, name: string | null, rep: number, events: number): void;
  getNode(token: string): NodeRow | undefined;
  addNodeTokens(token: string, tokens: number, verified: number, done: boolean, failed: boolean): void;
  setNodeRep(token: string, rep: number, events: number): void;
  insertKey(r: KeyRow): void;
  getKey(keyHash: string): KeyRow | undefined;
  deleteKey(keyHash: string): void;
  /** Release the underlying file handle (flushes pending debounced writes). */
  close(): void;
  addKeyUsage(keyHash: string, day: string, tokens: number): void;
  getKeyUsage(keyHash: string, day: string): number;
  addIpUsage(ip: string, day: string, tokens: number): void;
  getIpUsage(ip: string, day: string): number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS nodes (
  token TEXT PRIMARY KEY, name TEXT, first_seen INTEGER, last_seen INTEGER,
  tokens_total INTEGER DEFAULT 0, verified_tokens INTEGER DEFAULT 0,
  jobs_done INTEGER DEFAULT 0, jobs_failed INTEGER DEFAULT 0,
  rep REAL DEFAULT 1.0, rep_events INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS api_keys (
  key_hash TEXT PRIMARY KEY, name TEXT, created_at INTEGER
);
CREATE TABLE IF NOT EXISTS usage_daily (
  subject TEXT, day TEXT, tokens INTEGER, PRIMARY KEY (subject, day)
);
`;

// Exported for tests: both backends must behave identically.
export class JsonStore implements SqlStore {
  private data: {
    nodes: Map<string, NodeRow>;
    keys: Map<string, KeyRow>;
    usage: Map<string, number>; // `${subject}|${day}` -> tokens
  } = { nodes: new Map(), keys: new Map(), usage: new Map() };
  /** Heartbeats arrive every few seconds per node; coalesce their flushes. */
  private touchTimer: NodeJS.Timeout | null = null;
  constructor(private file: string) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      this.data.nodes = new Map(raw.nodes ?? []);
      this.data.keys = new Map(raw.keys ?? []);
      this.data.usage = new Map(raw.usage ?? []);
    } catch {
      /* first boot */
    }
  }
  private flush(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(
      tmp,
      JSON.stringify({
        nodes: [...this.data.nodes],
        keys: [...this.data.keys],
        usage: [...this.data.usage],
      }),
    );
    fs.renameSync(tmp, this.file);
  }
  upsertNode(r: NodeRow): void {
    this.data.nodes.set(r.token, { ...r });
    this.flush();
  }
  touchNode(token: string, name: string | null, rep: number, events: number): void {
    const r = this.data.nodes.get(token);
    if (!r) return;
    if (name) r.name = name;
    r.rep = rep;
    r.repEvents = events;
    r.lastSeen = Date.now();
    if (!this.touchTimer) {
      this.touchTimer = setTimeout(() => {
        this.touchTimer = null;
        this.flush();
      }, 500);
      this.touchTimer.unref?.();
    }
  }
  getNode(token: string): NodeRow | undefined {
    return this.data.nodes.get(token);
  }
  close(): void {
    if (this.touchTimer) {
      clearTimeout(this.touchTimer);
      this.touchTimer = null;
      this.flush();
    }
  }
  addNodeTokens(token: string, tokens: number, verified: number, done: boolean, failed: boolean): void {
    const r = this.data.nodes.get(token);
    if (!r) return;
    r.tokensTotal += tokens;
    r.verifiedTokens += verified;
    if (done) r.jobsDone++;
    if (failed) r.jobsFailed++;
    r.lastSeen = Date.now();
    this.flush();
  }
  setNodeRep(token: string, rep: number, events: number): void {
    const r = this.data.nodes.get(token);
    if (!r) return;
    r.rep = rep;
    r.repEvents = events;
    this.flush();
  }
  insertKey(r: KeyRow): void {
    this.data.keys.set(r.keyHash, { ...r });
    this.flush();
  }
  getKey(keyHash: string): KeyRow | undefined {
    return this.data.keys.get(keyHash);
  }
  deleteKey(keyHash: string): void {
    if (this.data.keys.delete(keyHash)) this.flush();
  }
  private use(subject: string, day: string, add?: number): number {
    const k = `${subject}|${day}`;
    if (add) {
      this.data.usage.set(k, (this.data.usage.get(k) ?? 0) + add);
      this.flush();
    }
    return this.data.usage.get(k) ?? 0;
  }
  addKeyUsage(keyHash: string, day: string, tokens: number): void {
    this.use(`k:${keyHash}`, day, tokens);
  }
  getKeyUsage(keyHash: string, day: string): number {
    return this.use(`k:${keyHash}`, day);
  }
  addIpUsage(ip: string, day: string, tokens: number): void {
    this.use(`i:${ip}`, day, tokens);
  }
  getIpUsage(ip: string, day: string): number {
    return this.use(`i:${ip}`, day);
  }
}

export class SqliteStore implements SqlStore {
  private db: import('node:sqlite').DatabaseSync;
  constructor(file: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const getBuiltin = (process as unknown as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule;
    if (typeof getBuiltin !== 'function') throw new Error('node too old for node:sqlite');
    const { DatabaseSync } = getBuiltin('node:sqlite') as typeof import('node:sqlite');
    this.db = new DatabaseSync(file);
    this.db.exec(SCHEMA);
  }
  upsertNode(r: NodeRow): void {
    this.db
      .prepare(
        `INSERT INTO nodes (token,name,first_seen,last_seen,tokens_total,verified_tokens,jobs_done,jobs_failed,rep,rep_events)
         VALUES (?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(token) DO UPDATE SET name=excluded.name, last_seen=excluded.last_seen`,
      )
      .run(r.token, r.name, r.firstSeen, r.lastSeen, r.tokensTotal, r.verifiedTokens, r.jobsDone, r.jobsFailed, r.rep, r.repEvents);
  }
  touchNode(token: string, name: string | null, rep: number, events: number): void {
    this.db.prepare('UPDATE nodes SET name=COALESCE(?, name), rep=?, rep_events=?, last_seen=? WHERE token=?').run(name, rep, events, Date.now(), token);
  }
  getNode(token: string): NodeRow | undefined {
    const r = this.db.prepare('SELECT * FROM nodes WHERE token=?').get(token) as Record<string, unknown> | undefined;
    if (!r) return undefined;
    return {
      token: r.token as string,
      name: (r.name as string | null) ?? null,
      firstSeen: r.first_seen as number,
      lastSeen: r.last_seen as number,
      tokensTotal: r.tokens_total as number,
      verifiedTokens: r.verified_tokens as number,
      jobsDone: r.jobs_done as number,
      jobsFailed: r.jobs_failed as number,
      rep: r.rep as number,
      repEvents: r.rep_events as number,
    };
  }
  addNodeTokens(token: string, tokens: number, verified: number, done: boolean, failed: boolean): void {
    this.db
      .prepare(
        `UPDATE nodes SET tokens_total=tokens_total+?, verified_tokens=verified_tokens+?,
         jobs_done=jobs_done+?, jobs_failed=jobs_failed+?, last_seen=? WHERE token=?`,
      )
      .run(tokens, verified, done ? 1 : 0, failed ? 1 : 0, Date.now(), token);
  }
  setNodeRep(token: string, rep: number, events: number): void {
    this.db.prepare('UPDATE nodes SET rep=?, rep_events=? WHERE token=?').run(rep, events, token);
  }
  insertKey(r: KeyRow): void {
    this.db.prepare('INSERT OR IGNORE INTO api_keys (key_hash,name,created_at) VALUES (?,?,?)').run(r.keyHash, r.name, r.createdAt);
  }
  getKey(keyHash: string): KeyRow | undefined {
    const r = this.db.prepare('SELECT * FROM api_keys WHERE key_hash=?').get(keyHash) as Record<string, unknown> | undefined;
    if (!r) return undefined;
    return { keyHash: r.key_hash as string, name: (r.name as string | null) ?? null, createdAt: r.created_at as number };
  }
  deleteKey(keyHash: string): void {
    this.db.prepare('DELETE FROM api_keys WHERE key_hash=?').run(keyHash);
  }
  close(): void {
    this.db.close();
  }
  private use(subject: string, day: string, add?: number): number {
    if (add) {
      this.db
        .prepare('INSERT INTO usage_daily (subject,day,tokens) VALUES (?,?,?) ON CONFLICT(subject,day) DO UPDATE SET tokens=tokens+?')
        .run(subject, day, add, add);
    }
    const r = this.db.prepare('SELECT tokens FROM usage_daily WHERE subject=? AND day=?').get(subject, day) as { tokens: number } | undefined;
    return r?.tokens ?? 0;
  }
  addKeyUsage(keyHash: string, day: string, tokens: number): void {
    this.use(`k:${keyHash}`, day, tokens);
  }
  getKeyUsage(keyHash: string, day: string): number {
    return this.use(`k:${keyHash}`, day);
  }
  addIpUsage(ip: string, day: string, tokens: number): void {
    this.use(`i:${ip}`, day, tokens);
  }
  getIpUsage(ip: string, day: string): number {
    return this.use(`i:${ip}`, day);
  }
}

export interface Store extends SqlStore {}

export function openStore(dataDir: string): Store {
  const file = path.join(dataDir, 'coordinator.db');
  try {
    return new SqliteStore(file);
  } catch {
    return new JsonStore(path.join(dataDir, 'coordinator.json'));
  }
}

export function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

export function todayUTC(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}
