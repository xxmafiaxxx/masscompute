// Model manager: download pinned GGUFs from Hugging Face with resume +
// sha256 verification, then pick the tier that fits the machine.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { pipeline } from 'node:stream/promises';
import { MODEL_CATALOG, urlForFile, type CatalogEntry } from '@masscompute/protocol';
import { dataDir } from './config.js';

export function modelDir(entry: CatalogEntry): string {
  return path.join(dataDir(), 'models', entry.id);
}

function partPath(entry: CatalogEntry, name: string): string {
  return path.join(modelDir(entry), `${name}.part`);
}

function finalPath(entry: CatalogEntry, name: string): string {
  return path.join(modelDir(entry), name);
}

/** sha256 of a file, streamed — shards run to 4GB, never buffer them whole. */
export async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(fs.createReadStream(file), hash);
  return hash.digest('hex');
}

const MAX_ATTEMPTS = 8;

/**
 * Stream a URL to disk with HTTP Range resume + sha256 verification.
 * Network drops retry from the .part (up to MAX_ATTEMPTS); a server that
 * ignores the Range header (200 instead of 206) restarts from zero so the
 * file can never be silently corrupted by a bad append. Exported for tests.
 */
export async function downloadFile(url: string, dest: string, part: string, sha256: string, bytes: number, onProgress?: (done: number, total: number) => void): Promise<void> {
  fs.mkdirSync(path.dirname(part), { recursive: true });
  if (fs.existsSync(part) && fs.statSync(part).size > bytes) fs.rmSync(part, { force: true });

  let lastErr: unknown = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    let offset = fs.existsSync(part) ? fs.statSync(part).size : 0;
    if (offset >= bytes) {
      lastErr = null;
      break;
    }
    onProgress?.(offset, bytes);
    let out: fs.WriteStream | null = null;
    try {
      const resumed = offset > 0;
      const res = await fetch(url, { headers: resumed ? { range: `bytes=${offset}-` } : {}, redirect: 'follow' });
      if (!res.ok && res.status !== 206) throw new Error(`download failed: HTTP ${res.status} for ${url}`);
      const body = res.body;
      if (!body) throw new Error('empty download body');
      // Some servers answer a Range request with a full 200 body; appending
      // that to the .part would duplicate bytes. Truncate and start over.
      const truncate = resumed && res.status === 200;
      if (truncate) offset = 0;
      const sink = fs.createWriteStream(part, { flags: truncate ? 'w' : 'a' });
      out = sink;
      let lastReport = offset;
      const reader = (body as unknown as ReadableStream<Uint8Array>).getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        offset += value.byteLength;
        // Respect backpressure: multi-GB writes must not buffer in memory.
        if (!sink.write(value)) await once(sink, 'drain');
        if (offset - lastReport > 8_000_000) {
          lastReport = offset;
          onProgress?.(offset, bytes);
        }
      }
      await new Promise<void>((resolve, reject) => {
        sink.end(() => resolve());
        sink.once('error', reject);
      });
      if (offset < bytes) throw new Error(`connection closed early at ${offset}/${bytes}`);
      lastErr = null;
      break;
    } catch (e) {
      lastErr = e;
      out?.destroy();
      await new Promise((r) => setTimeout(r, 1_000 + attempt * 2_000));
    }
  }
  if (lastErr) throw lastErr;

  const size = fs.existsSync(part) ? fs.statSync(part).size : 0;
  if (size < bytes) throw new Error(`download incomplete: ${size}/${bytes}`);
  onProgress?.(bytes, bytes);

  const got = await sha256File(part);
  if (got !== sha256) {
    fs.rmSync(part, { force: true });
    throw new Error(`sha256 mismatch for ${path.basename(dest)}: got ${got.slice(0, 16)}… expected ${sha256.slice(0, 16)}…`);
  }
  fs.renameSync(part, dest);
}

/** Ensure every file of the model is present and hash-verified. */
export async function ensureModel(entry: CatalogEntry, onStatus?: (s: string) => void): Promise<string> {
  fs.mkdirSync(modelDir(entry), { recursive: true });
  for (const f of entry.files) {
    const dest = finalPath(entry, f.name);
    if (fs.existsSync(dest) && fs.statSync(dest).size === f.bytes) continue;
    onStatus?.(`downloading ${f.name} (${(f.bytes / 1e9).toFixed(2)} GB)`);
    await downloadFile(urlForFile(entry, f), dest, partPath(entry, f.name), f.sha256, f.bytes, (done, total) => {
      onStatus?.(`downloading ${f.name}: ${(done / 1e9).toFixed(2)}/${(total / 1e9).toFixed(2)} GB`);
    });
  }
  return modelDir(entry);
}

export function modelReady(entry: CatalogEntry): boolean {
  return entry.files.every((f) => fs.existsSync(finalPath(entry, f.name)) && fs.statSync(finalPath(entry, f.name)).size === f.bytes);
}

export function firstShardPath(entry: CatalogEntry): string {
  return finalPath(entry, entry.files[0]!.name);
}

/**
 * Pick the model this machine should host: biggest tier that fits the VRAM
 * budget (with headroom for context), CPU-capable models as fallback.
 */
export function pickModel(vramTotalMb: number, requested: string | 'auto'): CatalogEntry {
  if (requested !== 'auto') {
    const e = MODEL_CATALOG.find((m) => m.id === requested);
    if (e) return e;
  }
  const budgetMb = Math.max(0, vramTotalMb - 1500); // headroom for KV/overhead
  const fits = MODEL_CATALOG.filter((m) => m.vramMinMb > 0 && m.vramMinMb <= budgetMb).sort((a, b) => b.totalBytes - a.totalBytes);
  if (fits[0]) return fits[0];
  return MODEL_CATALOG.find((m) => m.cpuCapable && m.tier === 'test') ?? MODEL_CATALOG[0]!;
}
