// masscompute CLI: the headless donor. `npm i -g` this package and the
// whole donor module is one command:
//
//   masscompute                    start donating (foreground)
//   masscompute doctor             hardware / engine / coordinator checks
//   masscompute status             last-known state of a running donor
//   masscompute set <key> <value>  configure (name, slots, model, schedule…)
//   masscompute autostart          donate on login (HKCU Run / systemd user / LaunchAgent)
//   masscompute autostart --remove
//
// Pure helpers (settings parsing, autostart assets, state-file reading) are
// exported for the test suite.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { MODEL_CATALOG, catalogEntry } from '@masscompute/protocol';
import { configDir, dataDir, type WorkerSettings } from './core/config.js';
import { WorkerCore } from './core/index.js';

const pExecFile = promisify(execFile);

export const WORKER_VERSION = '0.2.0';

// ---- settings: `set` verb ----

const SCHEDULE_RE = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/;

/** Validate + coerce one `masscompute set` assignment. Pure; unit-tested. */
export function parseSetting(key: string, rawValue: string): { patch: Partial<WorkerSettings>; error?: string } {
  const value = rawValue.trim();
  switch (key) {
    case 'name':
      return { patch: { name: value.slice(0, 64) } };
    case 'donating':
      return /^(on|true|1|yes)$/i.test(value)
        ? { patch: { donating: true } }
        : /^(off|false|0|no)$/i.test(value)
          ? { patch: { donating: false } }
          : { patch: {}, error: 'donating is on/off' };
    case 'model': {
      if (value === 'auto') return { patch: { modelTier: 'auto' } };
      if (!catalogEntry(value)) return { patch: {}, error: `unknown model "${value}" (see masscompute models)` };
      return { patch: { modelTier: value } };
    }
    case 'slots': {
      const n = Number.parseInt(value, 10);
      if (!Number.isInteger(n) || n < 1 || n > 16) return { patch: {}, error: 'slots must be 1..16' };
      return { patch: { slots: n } };
    }
    case 'idleMinutes': {
      const n = Number.parseInt(value, 10);
      if (!Number.isInteger(n) || n < 0 || n > 1_000) return { patch: {}, error: 'idleMinutes must be 0..1000' };
      return { patch: { idleMinutes: n } };
    }
    case 'schedule': {
      if (value === 'off' || value === 'always' || value === 'null') return { patch: { schedule: null } };
      if (!SCHEDULE_RE.test(value) || !validClock(value)) return { patch: {}, error: 'schedule must be HH:MM-HH:MM (e.g. 22:00-07:00), or off' };
      return { patch: { schedule: value.replace(/\s/g, '') } };
    }
    case 'coordinator': {
      if (!/^wss?:\/\//.test(value) && !/^https?:\/\//.test(value)) return { patch: {}, error: 'coordinator must be a ws:// or wss:// URL' };
      return { patch: { coordinator: value } };
    }
    case 'vramCapGb': {
      const n = Number.parseInt(value, 10);
      if (!Number.isInteger(n) || n < 0 || n > 512) return { patch: {}, error: 'vramCapGb must be 0..512 (0 = no cap)' };
      return { patch: { vramCapGb: n } };
    }
    default:
      return { patch: {}, error: `unknown setting "${key}" (settable: ${SETTING_KEYS.join(', ')})` };
  }
}

function validClock(s: string): boolean {
  const m = SCHEDULE_RE.exec(s);
  if (!m) return false;
  return [Number(m[1]), Number(m[3])].every((v) => v < 24) && [Number(m[2]), Number(m[4])].every((v) => v < 60);
}

export const SETTING_KEYS = ['name', 'donating', 'model', 'slots', 'idleMinutes', 'schedule', 'coordinator', 'vramCapGb'] as const;

// ---- state file (written by the running core) ----

export interface DonorStateFile {
  pid: number;
  donorState: string;
  model: string | null;
  engineUp: boolean;
  connected: boolean;
  coordinator: string;
  name: string | null;
  nodeToken: string | null;
  jobsDone: number;
  tokensServed: number;
  updatedAt: number;
}

export function readStateFile(dir = configDir()): DonorStateFile | null {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
    if (typeof raw?.pid !== 'number') return null;
    return raw as DonorStateFile;
  } catch {
    return null;
  }
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ---- autostart: donate on login, per OS, all WITHOUT admin rights ----

export interface AutostartSpec {
  os: 'windows' | 'macos' | 'linux';
  /** Absolute path to the node binary running THIS process. */
  nodePath: string;
  /** Absolute path to the bundled entry (dist/masscompute.mjs). */
  entryPath: string;
}

/** Pure per-OS autostart asset builders. Unit-tested. */
export function autostartAsset(spec: AutostartSpec): { kind: 'reg' | 'systemd' | 'launchd'; target: string; content: string; enableCmd: string[] } {
  if (spec.os === 'windows') {
    // HKCU Run key: no elevation, executes at user login.
    const value = `"${spec.nodePath}" "${spec.entryPath}"`;
    return {
      kind: 'reg',
      target: 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run\\MassCompute',
      content: value,
      enableCmd: ['reg', 'add', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', 'MassCompute', '/t', 'REG_SZ', '/d', value, '/f'],
    };
  }
  if (spec.os === 'linux') {
    const unit = [
      '[Unit]',
      'Description=MassCompute donor — donate spare GPU time',
      'After=network-online.target',
      '',
      '[Service]',
      `ExecStart=${spec.nodePath} ${spec.entryPath}`,
      'Restart=on-failure',
      'RestartSec=10',
      '',
      '[Install]',
      'WantedBy=default.target',
      '',
    ].join('\n');
    return {
      kind: 'systemd',
      target: '~/.config/systemd/user/masscompute.service',
      content: unit,
      enableCmd: ['systemctl', '--user', 'enable', '--now', 'masscompute.service'],
    };
  }
  const plist = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key><string>app.masscompute.worker</string>',
    '  <key>ProgramArguments</key>',
    '  <array>',
    `    <string>${spec.nodePath}</string>`,
    `    <string>${spec.entryPath}</string>`,
    '  </array>',
    '  <key>RunAtLoad</key><true/>',
    '  <key>KeepAlive</key><true/>',
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
  return {
    kind: 'launchd',
    target: '~/Library/LaunchAgents/app.masscompute.worker.plist',
    content: plist,
    enableCmd: ['launchctl', 'load', `${os.homedir()}/Library/LaunchAgents/app.masscompute.worker.plist`],
  };
}

function entryPath(): string {
  // Bundled: dist/masscompute.mjs sits next to nothing else; resolve from
  // this module's location so it works from repo builds AND global installs.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidate = path.join(here, 'masscompute.mjs');
  return fs.existsSync(candidate) ? candidate : path.join(here, 'core.mjs');
}

function thisOs(): 'windows' | 'macos' | 'linux' {
  return process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux';
}

// ---- verbs ----

async function cmdDoctor(): Promise<void> {
  const core = new WorkerCore();
  console.log(`masscompute ${WORKER_VERSION} — node ${process.version} (${thisOs()})`);
  const hw = await core.hardwareSummary();
  console.log(`\nhardware: ${hw.cpuModel}`);
  console.log(`          ${hw.ramTotalMb} MB RAM`);
  if (hw.gpus.length === 0) {
    console.log('          no usable GPU detected — donor will run the test tier on CPU');
  } else {
    for (const g of hw.gpus) console.log(`          ${g.name} — ${g.vramTotalMb} MB VRAM (${g.backend})`);
    console.log(`          backend: ${hw.backend}, total ${hw.vramTotalMb} MB`);
  }
  console.log(`\nmodel:    ${hw.model} ${hw.modelReady ? '(downloaded, hash-verified)' : '(will download on first run)'}`);
  console.log(`engine:   ${hw.engineBinaryReady ? 'ready' : 'will download on first run'} — ${hw.engineBinary}`);

  const s = readStateFile();
  if (s && pidAlive(s.pid)) console.log(`\ndonor:    RUNNING (pid ${s.pid}, ${s.donorState})`);
  else console.log('\ndonor:    not running (start with: masscompute)');

  const base = core.settings.coordinator.replace(/\/+$/, '').replace(/^ws/, 'http').replace(/\/worker$/, '');
  try {
    const res = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(5_000) });
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean };
    console.log(`grid:     ${res.ok && body.ok ? 'reachable' : 'UNEXPECTED RESPONSE'} — ${base}`);
  } catch {
    console.log(`grid:     UNREACHABLE — ${base} (check your connection or: masscompute set coordinator ws://…)`);
  }
  console.log(`\nconfig:   ${path.join(configDir(), 'worker.json')} · data: ${dataDir()}`);
}

function cmdStatus(): void {
  const s = readStateFile();
  if (!s) {
    console.log('donor: never started on this machine (or no state file)');
    return;
  }
  const alive = pidAlive(s.pid);
  const age = Math.round((Date.now() - s.updatedAt) / 1000);
  console.log(`donor: ${alive ? `RUNNING (pid ${s.pid})` : 'NOT RUNNING (stale state)'}`);
  console.log(`state: ${s.donorState} · engine ${s.engineUp ? 'up' : 'down'} · ${s.connected ? 'connected' : 'disconnected'}`);
  console.log(`model: ${s.model ?? 'none'} · name: ${s.name ?? '(anonymous)'}`);
  console.log(`served this session: ${s.jobsDone} job(s), ${s.tokensServed} token(s)`);
  console.log(`grid: ${s.coordinator} · updated ${age}s ago`);
}

function cmdSet(key: string, value: string): void {
  const { patch, error } = parseSetting(key, value);
  if (error) {
    console.error(`error: ${error}`);
    process.exitCode = 1;
    return;
  }
  const core = new WorkerCore();
  core.updateSettings(patch);
  for (const [k, v] of Object.entries(patch)) console.log(`${k} = ${v}`);
  const s = readStateFile();
  if (s && pidAlive(s.pid)) console.log('\nNOTE: a donor is running — restart it (masscompute) to apply, or use the tray app which applies live.');
}

function cmdModels(): void {
  for (const m of MODEL_CATALOG) console.log(`${m.id.padEnd(20)} ${(m.vramMinMb / 1000).toFixed(1)}GB+ VRAM · ${m.description}`);
  console.log(`\ndefault: auto (biggest tier that fits your hardware)`);
}

async function cmdAutostart(remove: boolean): Promise<void> {
  const osName = thisOs();
  const asset = autostartAsset({ os: osName, nodePath: process.execPath, entryPath: entryPath() });
  if (osName === 'windows') {
    if (remove) {
      await pExecFile('reg', ['delete', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', 'MassCompute', '/f'], { windowsHide: true }).catch(() => {});
      console.log('autostart removed (HKCU Run key)');
      return;
    }
    await pExecFile('reg', asset.enableCmd.slice(1), { windowsHide: true });
    console.log(`autostart installed: ${asset.target}`);
    console.log(`runs at login: ${asset.content}`);
    return;
  }
  const file = asset.target.replace('~', os.homedir());
  if (remove) {
    if (asset.kind === 'systemd') await pExecFile('systemctl', ['--user', 'disable', '--now', 'masscompute.service'], {}).catch(() => {});
    if (asset.kind === 'launchd') await pExecFile('launchctl', ['unload', file], {}).catch(() => {});
    fs.rmSync(file, { force: true });
    console.log(`autostart removed (${file})`);
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, asset.content);
  await pExecFile(asset.enableCmd[0]!, asset.enableCmd.slice(1), {}).catch((e) => {
    console.error(`note: could not enable immediately (${e.message.split('\n')[0]}); the unit will start at next login`);
  });
  console.log(`autostart installed: ${file}`);
}

function cmdRun(): void {
  // Single-donor lock: two donors on one machine double-claim the GPU.
  const s = readStateFile();
  if (s && pidAlive(s.pid) && s.pid !== process.pid && !process.argv.includes('--force')) {
    console.error(`a donor is already running (pid ${s.pid}). Stop it first, or run: masscompute --force`);
    process.exit(1);
  }
  const shutdown = (signal: string) => {
    console.log(`\n[${signal}] stopping…`);
    core.stop();
    process.exit(0);
  };
  const core = new WorkerCore({
    onStatus: (l) => console.log('[worker]', l),
    onState: (st) => console.log('[state]', JSON.stringify(st)),
  });
  console.log(`masscompute ${WORKER_VERSION} — donating spare GPU time. Ctrl+C to stop.`);
  console.log(`settings: ${path.join(configDir(), 'worker.json')} (masscompute set <key> <value>)`);
  core.start().catch((e) => {
    console.error('[worker] fatal:', e);
    process.exit(1);
  });
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

const HELP = `masscompute ${WORKER_VERSION} — donate spare GPU time to the grid

  masscompute                      start donating (foreground)
  masscompute doctor               check hardware, engine, grid reachability
  masscompute status               last-known state of the donor
  masscompute set <key> <value>    configure: ${SETTING_KEYS.join(', ')}
  masscompute models               list hostable model tiers
  masscompute autostart            donate automatically at login
  masscompute autostart --remove   remove the login autostart
  masscompute --force              start even if another donor pid is live
  masscompute help                 this text
`;

export async function main(argv: string[]): Promise<void> {
  const [verb, ...rest] = argv.filter((a) => a !== '--force' && !a.startsWith('--dev'));
  switch (verb ?? 'run') {
    case 'run':
      cmdRun();
      return;
    case 'doctor':
      await cmdDoctor();
      return;
    case 'status':
      cmdStatus();
      return;
    case 'set':
      if (rest.length !== 2) {
        console.error('usage: masscompute set <key> <value>');
        process.exitCode = 1;
        return;
      }
      cmdSet(rest[0]!, rest[1]!);
      return;
    case 'models':
      cmdModels();
      return;
    case 'autostart':
      await cmdAutostart(rest.includes('--remove'));
      return;
    case 'help':
    case '--help':
    case '-h':
      console.log(HELP);
      return;
    case 'version':
    case '--version':
      console.log(WORKER_VERSION);
      return;
    default:
      console.error(`unknown command "${verb}"\n`);
      console.log(HELP);
      process.exitCode = 1;
      return;
  }
}

// Used by the tray app's --dev flag too (same default verb).
if (process.argv.includes('--dev') || (process.argv[1] && path.basename(process.argv[1]) === path.basename(entryPath()))) {
  void main(process.argv.slice(2)).catch((e) => {
    console.error('fatal:', e);
    process.exit(1);
  });
}
