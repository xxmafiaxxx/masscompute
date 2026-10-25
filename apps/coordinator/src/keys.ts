// API keys + daily token quotas. Keys are free; they exist to make abuse
// revocable and quotas fair. Anonymous callers get a much smaller IP quota.

import { randomBytes } from 'node:crypto';
import type { Store } from './store.js';
import { sha256, todayUTC } from './store.js';

export interface KeyContext {
  /** null for anonymous callers. */
  keyHash: string | null;
  subject: string; // 'key:<hash>' | 'ip:<ip>'
  dailyLimit: number;
}

export function issueKey(store: Store, name: string | null): string {
  const key = `mc_${randomBytes(24).toString('hex')}`;
  store.insertKey({ keyHash: sha256(key), name, createdAt: Date.now() });
  return key;
}

export function resolveKey(store: Store, bearer: string | undefined, ip: string, keyDailyTokens: number, anonDailyTokens: number): KeyContext {
  if (bearer && /^[a-z]{2}_[0-9a-f]{48}$/.test(bearer) && store.getKey(sha256(bearer))) {
    return { keyHash: sha256(bearer), subject: `key:${sha256(bearer)}`, dailyLimit: keyDailyTokens };
  }
  return { keyHash: null, subject: `ip:${ip}`, dailyLimit: anonDailyTokens };
}

export function quotaUsed(store: Store, ctx: KeyContext, day = todayUTC()): number {
  const [kind, id] = splitSubject(ctx.subject);
  return kind === 'key' ? store.getKeyUsage(id, day) : store.getIpUsage(id, day);
}

export function recordUsage(store: Store, ctx: KeyContext, tokens: number, day = todayUTC()): void {
  const [kind, id] = splitSubject(ctx.subject);
  if (kind === 'key') store.addKeyUsage(id, day, tokens);
  else store.addIpUsage(id, day, tokens);
}

function splitSubject(subject: string): ['key' | 'ip', string] {
  const kind = subject.startsWith('key:') ? 'key' : 'ip';
  return [kind, subject.slice(kind.length + 1)];
}
