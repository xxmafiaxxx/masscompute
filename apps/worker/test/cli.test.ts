// CLI unit tests: settings parsing truth table, per-OS autostart assets,
// state-file round-trip. Pure functions — no processes spawned.

import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { autostartAsset, parseSetting, readStateFile, SETTING_KEYS, pidAlive } from '../src/cli.js';

describe('parseSetting (masscompute set)', () => {
  it('accepts the documented keys', () => {
    expect(parseSetting('name', '  Raul-Desktop ')).toEqual({ patch: { name: 'Raul-Desktop' } });
    expect(parseSetting('donating', 'ON')).toEqual({ patch: { donating: true } });
    expect(parseSetting('donating', 'no')).toEqual({ patch: { donating: false } });
    expect(parseSetting('model', 'auto')).toEqual({ patch: { modelTier: 'auto' } });
    expect(parseSetting('slots', '4')).toEqual({ patch: { slots: 4 } });
    expect(parseSetting('idleMinutes', '30')).toEqual({ patch: { idleMinutes: 30 } });
    expect(parseSetting('schedule', '22:00 - 07:00')).toEqual({ patch: { schedule: '22:00-07:00' } });
    expect(parseSetting('schedule', 'off')).toEqual({ patch: { schedule: null } });
    expect(parseSetting('vramCapGb', '0')).toEqual({ patch: { vramCapGb: 0 } });
    expect(parseSetting('coordinator', 'wss://grid.example.com')?.patch.coordinator).toBe('wss://grid.example.com');
  });

  it('rejects garbage with a reason', () => {
    expect(parseSetting('donating', 'maybe')?.error).toBeTruthy();
    expect(parseSetting('model', 'gpt-5')?.error).toContain('unknown model');
    expect(parseSetting('slots', '0')?.error).toBeTruthy();
    expect(parseSetting('slots', '99')?.error).toBeTruthy();
    expect(parseSetting('slots', 'two')?.error).toBeTruthy();
    expect(parseSetting('idleMinutes', '-1')?.error).toBeTruthy();
    expect(parseSetting('schedule', '25:00-07:00')?.error).toBeTruthy();
    expect(parseSetting('schedule', '2200-0700')?.error).toBeTruthy();
    expect(parseSetting('coordinator', 'ftp://grid')?.error).toBeTruthy();
    expect(parseSetting('flavor', 'vanilla')?.error).toContain('unknown setting');
  });

  it('settable keys all parse a sample value (docs stay honest)', () => {
    const samples: Record<string, string> = {
      name: 'x',
      donating: 'on',
      model: 'auto',
      slots: '2',
      idleMinutes: '15',
      schedule: 'off',
      coordinator: 'wss://grid.example.com',
      vramCapGb: '0',
    };
    for (const k of SETTING_KEYS) expect(parseSetting(k, samples[k]!)?.error).toBeUndefined();
  });
});

describe('autostart assets', () => {
  const spec = {
    nodePath: '/usr/bin/node',
    entryPath: '/opt/masscompute/dist/masscompute.mjs',
  };

  it('windows: HKCU Run key with quoted paths, no admin needed', () => {
    const a = autostartAsset({ os: 'windows', nodePath: 'C:\\Program Files\\nodejs\\node.exe', entryPath: 'C:\\mc\\dist\\masscompute.mjs' });
    expect(a.kind).toBe('reg');
    expect(a.target).toContain('CurrentVersion\\Run');
    expect(a.content).toContain('"C:\\Program Files\\nodejs\\node.exe"');
    expect(a.content).toContain('"C:\\mc\\dist\\masscompute.mjs"');
    expect(a.enableCmd[0]).toBe('reg');
    expect(a.enableCmd).toContain('/f');
  });

  it('linux: systemd user unit with Restart, no root', () => {
    const a = autostartAsset({ ...spec, os: 'linux' });
    expect(a.kind).toBe('systemd');
    expect(a.content).toContain('[Service]');
    expect(a.content).toContain(`ExecStart=${spec.nodePath} ${spec.entryPath}`);
    expect(a.content).toContain('Restart=on-failure');
    expect(a.enableCmd.join(' ')).toContain('--user');
  });

  it('macos: LaunchAgent plist with RunAtLoad', () => {
    const a = autostartAsset({ ...spec, os: 'macos' });
    expect(a.kind).toBe('launchd');
    expect(a.content).toContain('<key>RunAtLoad</key>');
    expect(a.content).toContain(`<string>${spec.entryPath}</string>`);
    expect(a.enableCmd[0]).toBe('launchctl');
  });
});

describe('state file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-cli-'));
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('round-trips and rejects junk', () => {
    expect(readStateFile(dir)).toBeNull();
    fs.writeFileSync(path.join(dir, 'state.json'), 'not json');
    expect(readStateFile(dir)).toBeNull();
    const state = { pid: 1, donorState: 'available', model: 'm', engineUp: true, connected: true, coordinator: 'wss://x', name: null, nodeToken: null, jobsDone: 2, tokensServed: 9, updatedAt: Date.now() };
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state));
    expect(readStateFile(dir)?.jobsDone).toBe(2);
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ nope: true }));
    expect(readStateFile(dir)).toBeNull();
  });

  it('pidAlive: own pid yes, nonsense no', () => {
    expect(pidAlive(process.pid)).toBe(true);
    expect(pidAlive(999_999_999)).toBe(false);
  });
});
