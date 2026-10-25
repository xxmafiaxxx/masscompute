// Persisted worker configuration + node identity.
// Lives OUTSIDE the repo: %APPDATA%/masscompute/ (win), ~/.config/masscompute (linux), ~/Library/Application Support/masscompute (mac).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface WorkerSettings {
  /** Public leaderboard name. */
  name: string;
  /** Manual donate toggle. */
  donating: boolean;
  /** 'auto' picks the biggest tier that fits; or a catalog id. */
  modelTier: 'auto' | string;
  /** Idle minutes before the node accepts work. */
  idleMinutes: number;
  /** Local active window 'HH:MM-HH:MM' or null for always. */
  schedule: string | null;
  /** Cap on VRAM the engine may use, GB (0 = no cap). */
  vramCapGb: number;
  /** Coordinator URL (ws:// or wss:// + /worker path appended by client). */
  coordinator: string;
  /** Max concurrent requests offered to the grid. */
  slots: number;
}

export interface WorkerConfig {
  settings: WorkerSettings;
  nodeToken: string | null;
}

export const DEFAULT_SETTINGS: WorkerSettings = {
  name: '',
  donating: true,
  modelTier: process.env.MASSCOMPUTE_MODEL ?? 'auto',
  idleMinutes: 15,
  schedule: null,
  vramCapGb: 0,
  coordinator: process.env.MASSCOMPUTE_COORDINATOR ?? 'wss://masscompute.fly.dev',
  slots: 2,
};

export function configDir(): string {
  const base =
    process.platform === 'win32'
      ? path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'masscompute')
      : process.platform === 'darwin'
        ? path.join(os.homedir(), 'Library', 'Application Support', 'masscompute')
        : path.join(os.homedir(), '.config', 'masscompute');
  return process.env.MASSCOMPUTE_CONFIG_DIR ?? base;
}

export function dataDir(): string {
  return process.env.MASSCOMPUTE_DATA_DIR ?? path.join(configDir(), 'data');
}

export function loadConfig(): WorkerConfig {
  const file = path.join(configDir(), 'worker.json');
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      settings: { ...DEFAULT_SETTINGS, ...(raw.settings ?? {}) },
      nodeToken: raw.nodeToken ?? null,
    };
  } catch {
    return { settings: { ...DEFAULT_SETTINGS }, nodeToken: null };
  }
}

export function saveConfig(cfg: WorkerConfig): void {
  const dir = configDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'worker.json'), JSON.stringify(cfg, null, 2));
}
