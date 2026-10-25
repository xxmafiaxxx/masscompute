import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { WebSocket } from 'ws';
import { MODEL_CATALOG, PROTOCOL_VERSION, catalogEntry, urlForFile } from '@masscompute/protocol';
import { initialRep, applyEvent, isQuarantined, shouldProbe, REP_QUARANTINE, REP_PROBATION } from '../src/reputation.js';
import { schedule, estimateTokens } from '../src/scheduler.js';
import { normalize, trigramSimilarity, verdict, SIM_MATCH_THRESHOLD } from '../src/verify.js';
import { RateLimiter } from '../src/ratelimit.js';
import { JsonStore, SqliteStore, type NodeRow } from '../src/store.js';
import { NodeConn, Registry } from '../src/registry.js';

describe('protocol catalog', () => {
  it('has pinned revisions and sha256 for every file', () => {
    for (const m of MODEL_CATALOG) {
      expect(m.revision).toMatch(/^[0-9a-f]{40}$/);
      expect(m.files.length).toBeGreaterThan(0);
      for (const f of m.files) {
        expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(f.bytes).toBeGreaterThan(0);
      }
      expect(m.totalBytes).toBe(m.files.reduce((n, f) => n + f.bytes, 0));
    }
  });

  it('resolves catalog entries and HF URLs', () => {
    expect(catalogEntry('qwen2.5-3b-q4km')?.hfRepo).toBe('Qwen/Qwen2.5-3B-Instruct-GGUF');
    expect(catalogEntry('nope')).toBeUndefined();
    const e = catalogEntry('qwen2.5-3b-q4km')!;
    expect(urlForFile(e, e.files[0]!)).toContain('/resolve/7dabda4d13d513e3e842b20f0d435c732f172cbe/');
  });

  it('protocol version is 1', () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });
});

describe('reputation', () => {
  it('starts new nodes at probation', () => {
    const s = initialRep();
    expect(s.rep).toBeLessThan(REP_PROBATION);
    expect(s.rep).toBeGreaterThan(REP_QUARANTINE);
  });

  it('good events climb asymptotically toward 1', () => {
    let s = initialRep();
    for (let i = 0; i < 200; i++) s = applyEvent(s, 'job-success');
    expect(s.rep).toBeGreaterThan(0.95);
  });

  it('probe mismatches crater reputation into quarantine', () => {
    let s = initialRep();
    for (let i = 0; i < 10; i++) s = applyEvent(s, 'probe-mismatch');
    expect(isQuarantined(s)).toBe(true);
  });

  it('a healthy node recovers from a couple of failures but not from sabotage', () => {
    let s = initialRep();
    s = applyEvent(s, 'job-failure');
    s = applyEvent(s, 'job-failure');
    expect(isQuarantined(s)).toBe(false);
    let bad = initialRep();
    for (let i = 0; i < 6; i++) bad = applyEvent(bad, 'reject-spam');
    expect(isQuarantined(bad)).toBe(true);
  });

  it('unverifiable probes are a no-op', () => {
    const s = initialRep();
    expect(applyEvent(s, 'probe-unverifiable')).toEqual(s);
  });

  it('probationary nodes are probed 4x more often', () => {
    const prob = initialRep();
    let trusted = prob;
    for (let i = 0; i < 100; i++) trusted = applyEvent(trusted, 'job-success');
    const now = 1_000_000;
    const base = 600_000;
    expect(shouldProbe(prob, base, now, now - 200_000)).toBe(true); // 200k >= base/4
    expect(shouldProbe(trusted, base, now, now - 200_000)).toBe(false); // 200k < base
    expect(shouldProbe(trusted, base, now, now - base)).toBe(true);
  });
});

describe('scheduler', () => {
  const mk = (token: string, over: Partial<{ state: string; jobs: number; slots: number; rep: number; models: string[] }> = {}) => ({
    token,
    models: new Set(over.models ?? ['m1']),
    state: over.state ?? 'available',
    jobsInFlight: over.jobs ?? 0,
    slots: over.slots ?? 2,
    rep: over.rep ?? 1,
  });

  it('routes to nodes hosting the model', () => {
    const d = schedule('m1', [mk('a'), mk('b', { models: ['m2'] })]);
    expect(d.picks).toEqual(['a']);
  });

  it('no-model when nobody hosts it', () => {
    expect(schedule('mX', [mk('a')]).reason).toBe('no-model');
  });

  it('no-capacity when all hosting nodes are saturated or paused', () => {
    expect(schedule('m1', [mk('a', { jobs: 2 })]).reason).toBe('no-capacity');
    expect(schedule('m1', [mk('a', { state: 'paused' })]).reason).toBe('no-capacity');
  });

  it('quarantined nodes are excluded even if they host the model', () => {
    const d = schedule('m1', [mk('a', { rep: 0.1 })]);
    expect(d.reason).toBe('all-quarantined');
  });

  it('prefers less-loaded nodes', () => {
    const picks: string[] = [];
    for (let i = 0; i < 20; i++) picks.push(...schedule('m1', [mk('busy', { jobs: 5, slots: 8, rep: 1 }), mk('free', { jobs: 0, slots: 8, rep: 1 })]).picks);
    expect(picks[0]).toBe('free');
  });

  it('an early reputation streak never permanently starves other nodes', () => {
    // One node pulled ahead (rep 1.0) while the rest sit at the new-donor
    // seed (0.65). All have equal load and host the model: the spread rule
    // says every node must keep earning traffic.
    const nodes = [mk('star', { rep: 1 }), mk('a', { rep: 0.65 }), mk('b', { rep: 0.65 })];
    const firsts: Record<string, number> = { star: 0, a: 0, b: 0 };
    for (let i = 0; i < 200; i++) firsts[schedule('m1', nodes).picks[0]!]++;
    expect(firsts.a).toBeGreaterThan(20);
    expect(firsts.b).toBeGreaterThan(20);
  });

  it('token estimate is sane', () => {
    expect(estimateTokens('')).toBe(1);
    expect(estimateTokens('abcd'.repeat(100))).toBe(100);
  });
});

describe('verification', () => {
  it('normalization strips case/punct/whitespace', () => {
    expect(normalize('  Hello,  WORLD! ')).toBe('hello world');
  });

  it('identical text scores 1', () => {
    expect(trigramSimilarity('the capital of france is paris', 'the capital of france is paris')).toBe(1);
  });

  it('disjoint text scores 0', () => {
    expect(trigramSimilarity('abcdef', 'uvwxyz')).toBe(0);
  });

  it('verdict: majority of references decides', () => {
    expect(verdict('2 3 5 7 11 13', ['2 3 5 7 11 13', 'garbage garbage'])).toBe('match');
    expect(verdict('2 3 5 7 11 13', ['garbage', 'more garbage'])).toBe('mismatch');
  });

  it('verdict: unverifiable with fewer than two references (no ground truth)', () => {
    expect(verdict('anything', [])).toBe('unverifiable');
    expect(verdict('anything', ['2 3 5 7 11 13'])).toBe('unverifiable');
  });

  it('close-but-not-identical outputs still match', () => {
    const a = 'the first ten prime numbers are 2, 3, 5, 7, 11, 13, 17, 19, 23, 29';
    const b = 'The first ten prime numbers are: 2, 3, 5, 7, 11, 13, 17, 19, 23 and 29.';
    expect(trigramSimilarity(a, b)).toBeGreaterThan(SIM_MATCH_THRESHOLD);
  });
});

describe('rate limiter', () => {
  it('allows up to max then blocks, then recovers after the window', () => {
    const rl = new RateLimiter(3, 1_000);
    expect(rl.allow('x', 0)).toBe(true);
    expect(rl.allow('x', 1)).toBe(true);
    expect(rl.allow('x', 2)).toBe(true);
    expect(rl.allow('x', 3)).toBe(false);
    expect(rl.allow('x', 1_003)).toBe(true);
  });

  it('sweeps empty entries', () => {
    const rl = new RateLimiter(1, 100);
    rl.allow('y', 0);
    expect(rl.allow('y', 5)).toBe(false);
    rl.sweep(200);
    expect(rl.allow('y', 201)).toBe(true);
  });
});

describe('store', () => {
  const row = (over: Partial<NodeRow> = {}): NodeRow => ({
    token: 'nd_testtoken00000000000000000000',
    name: 'tester',
    firstSeen: 1_000,
    lastSeen: 1_000,
    tokensTotal: 5_000,
    verifiedTokens: 3_000,
    jobsDone: 12,
    jobsFailed: 2,
    rep: 0.9,
    repEvents: 4,
    ...over,
  });

  it('touchNode refreshes presence/rep WITHOUT wiping lifetime counters (JSON fallback)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-store-'));
    try {
      const store = new JsonStore(path.join(dir, 'coord.json'));
      store.upsertNode(row());
      store.addNodeTokens('nd_testtoken00000000000000000000', 100, 50, true, false);
      store.touchNode('nd_testtoken00000000000000000000', 'tester', 0.8, 5);
      const r = store.getNode('nd_testtoken00000000000000000000')!;
      expect(r.tokensTotal).toBe(5_100);
      expect(r.verifiedTokens).toBe(3_050);
      expect(r.jobsDone).toBe(13);
      expect(r.jobsFailed).toBe(2);
      expect(r.rep).toBe(0.8);
      expect(r.repEvents).toBe(5);
      expect(r.lastSeen).toBeGreaterThan(1_000);
      // Persistence survives a reload.
      const reloaded = new JsonStore(path.join(dir, 'coord.json'));
      expect(reloaded.getNode('nd_testtoken00000000000000000000')?.tokensTotal).toBe(5_100);
      store.close();
      reloaded.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('touchNode behaves the same on the sqlite backend', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-store-'));
    const store = new SqliteStore(path.join(dir, 'coord.db'));
    try {
      store.upsertNode(row());
      store.touchNode('nd_testtoken00000000000000000000', null, 0.7, 6);
      const r = store.getNode('nd_testtoken00000000000000000000')!;
      expect(r.tokensTotal).toBe(5_000);
      expect(r.jobsDone).toBe(12);
      expect(r.rep).toBe(0.7);
      expect(r.repEvents).toBe(6);
      expect(r.name).toBe('tester'); // COALESCE keeps the old name on null
      store.insertKey({ keyHash: 'abc', name: null, createdAt: 1 });
      store.deleteKey('abc');
      expect(store.getKey('abc')).toBeUndefined();
    } finally {
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('deleteKey revokes', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-store-'));
    try {
      const store = new JsonStore(path.join(dir, 'coord.json'));
      store.insertKey({ keyHash: 'h1', name: null, createdAt: 1 });
      expect(store.getKey('h1')).toBeDefined();
      store.deleteKey('h1');
      expect(store.getKey('h1')).toBeUndefined();
      store.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('registry', () => {
  const fakeWs = { readyState: 1, OPEN: 1, send: () => true, close: () => {} } as unknown as WebSocket;
  const hello = {
    t: 'hello' as const,
    proto: 1,
    specs: { os: 'windows' as const, cpuModel: 'test', ramTotalMb: 16_384, gpus: [{ name: 'GPU', vramTotalMb: 8_192, backend: 'vulkan' as const }], workerVersion: 'test' },
    models: ['m1'],
    slots: 2,
  };

  it('public snapshot never exposes the full node token', () => {
    const reg = new Registry();
    const token = 'nd_abcdef1234567890abcdef1234567890';
    reg.register(new NodeConn(fakeWs as never, undefined, { ...hello, name: 'n' } as never, token));
    const snap = reg.snapshot();
    expect(snap).toHaveLength(1);
    expect(JSON.stringify(snap[0])).not.toContain(token);
    expect(snap[0]!.tokenPrefix).toBe('nd_abcde');
  });
});
