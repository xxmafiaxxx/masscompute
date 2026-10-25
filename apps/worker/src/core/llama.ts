// llama.cpp engine: download the pinned release binary per platform, run
// llama-server bound to 127.0.0.1 with a random API key, health-check it.

import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { exec, spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import { dataDir } from './config.js';

const pExec = promisify(exec);
const nodeRequire = createRequire(import.meta.url);

export const LLAMA_TAG = 'b11057';

const ASSETS: Record<string, { file: string; extract: (name: string) => string | null }> = {
  'win32-x64': {
    file: `llama-${LLAMA_TAG}-bin-win-vulkan-x64.zip`,
    extract: (n) => (n === 'llama-server.exe' ? n : null),
  },
  'linux-x64': {
    file: `llama-${LLAMA_TAG}-bin-ubuntu-vulkan-x64.tar.gz`,
    extract: (n) => (n.endsWith('llama-server') ? n : null),
  },
  'darwin-arm64': {
    file: `llama-${LLAMA_TAG}-bin-macos-arm64.tar.gz`,
    extract: (n) => (n.endsWith('llama-server') ? n : null),
  },
  'darwin-x64': {
    file: `llama-${LLAMA_TAG}-bin-macos-x64.tar.gz`,
    extract: (n) => (n.endsWith('llama-server') ? n : null),
  },
};

export function llamaKey(): string {
  return `lk_${randomBytes(16).toString('hex')}`;
}

function binDir(): string {
  return path.join(dataDir(), 'bin', LLAMA_TAG);
}

export function llamaServerPath(): string {
  const exe = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';
  return path.join(binDir(), exe);
}

async function hasTool(cmd: string, args: string[]): Promise<boolean> {
  const { execFile } = await import('node:child_process');
  const p = promisify(execFile);
  try {
    await p(cmd, args, { timeout: 5000, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

export async function ensureLlamaServer(onStatus?: (s: string) => void): Promise<string> {
  const exe = llamaServerPath();
  if (fs.existsSync(exe)) return exe;
  const key = `${process.platform}-${process.arch}`;
  const asset = ASSETS[key];
  if (!asset) throw new Error(`no pinned llama.cpp build for ${key}`);
  onStatus?.(`downloading llama.cpp ${LLAMA_TAG} engine…`);
  fs.mkdirSync(binDir(), { recursive: true });
  const url = `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_TAG}/${asset.file}`;
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`engine download failed: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const archive = path.join(binDir(), asset.file);
  fs.writeFileSync(archive, buf);

  onStatus?.('extracting engine…');
  if (asset.file.endsWith('.zip')) {
    if (process.platform !== 'win32' && (await hasTool('unzip', ['-v']))) {
      await pExec(`unzip -o ${JSON.stringify(archive)} -d ${JSON.stringify(binDir())}`, { windowsHide: true });
    } else {
      // Windows: PowerShell Expand-Archive
      await pExec(`powershell -NoProfile -Command "Expand-Archive -Force -LiteralPath '${archive}' -DestinationPath '${binDir()}'"`, { windowsHide: true, timeout: 120_000 });
    }
  } else {
    await pExec(`tar -xzf ${JSON.stringify(archive)} -C ${JSON.stringify(binDir())}`, { windowsHide: true });
  }
  // Locate the binary whatever the archive layout is.
  const found = findFile(binDir(), path.basename(exe));
  if (!found) throw new Error('llama-server not found in archive');
  if (found !== exe) fs.renameSync(found, exe);
  if (process.platform !== 'win32') fs.chmodSync(exe, 0o755);
  fs.rmSync(archive, { force: true });
  return exe;
}

function findFile(dir: string, name: string): string | null {
  for (const e of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (e.isFile() && e.name === name) {
      const p = path.join(e.parentPath ?? e.path, e.name);
      // Skip build-scripts copies; prefer top-level-ish paths.
      if (!p.includes('scripts')) return p;
    }
  }
  return null;
}

export interface RunningServer {
  port: number;
  apiKey: string;
  child: ChildProcess;
}

export async function startLlamaServer(modelPath: string, opts: { port: number; apiKey: string; contextSize: number; gpuLayers: number; vramCapMb?: number }, onLog?: (line: string) => void): Promise<RunningServer> {
  const exe = llamaServerPath();
  const args = [
    '-m',
    modelPath,
    '--host',
    '127.0.0.1',
    '--port',
    String(opts.port),
    '--api-key',
    opts.apiKey,
    '-c',
    String(opts.contextSize),
    '-ngl',
    String(opts.gpuLayers),
    '--parallel',
    '1',
  ];
  const child = spawn(exe, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  child.stdout?.on('data', (d) => onLog?.(String(d).trim()));
  child.stderr?.on('data', (d) => onLog?.(String(d).trim()));
  // Health poll until ready (model load can take a while on big tiers).
  // NOTE: no exit-event promise here — a rejection with no attached handler
  // is an unhandledRejection that kills the worker once the engine dies at
  // ANY later point. Polling exitCode is un-crashable by construction.
  const base = `http://127.0.0.1:${opts.port}`;
  const started = Date.now();
  for (;;) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`llama-server exited immediately (code ${child.exitCode ?? child.signalCode})`);
    }
    await new Promise((r) => setTimeout(r, 500));
    try {
      const res = await fetch(`${base}/health`, { headers: { authorization: `Bearer ${opts.apiKey}` }, signal: AbortSignal.timeout(2000) });
      if (res.ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() - started > 300_000) {
      child.kill();
      throw new Error('llama-server failed to become healthy within 5 minutes');
    }
  }
  return { port: opts.port, apiKey: opts.apiKey, child };
}

export async function randomPort(): Promise<number> {
  const net = nodeRequire('node:net') as typeof import('node:net');
  return new Promise<number>((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

export function engineFingerprint(exe: string): string {
  return createHash('sha256').update(`${exe}:${fs.statSync(exe).size}`).digest('hex').slice(0, 16);
}
