// Donor gates: decide whether this machine donates right now, and why not.
// Pure logic (testable) + environment inputs supplied by the host (Electron
// powerMonitor in the app, stubs in headless dev).

import type { DonorState } from '@masscompute/protocol';

export interface GateInputs {
  donating: boolean; // manual toggle
  idleSec: number;
  idleThresholdSec: number;
  gpuUtil: number; // 0-100
  gpuBusyThreshold: number; // e.g. 40
  onBattery: boolean;
  schedule: string | null; // 'HH:MM-HH:MM' local, null = always
  now?: Date;
}

export interface GateResult {
  state: DonorState;
  ok: boolean;
}

export function evaluateGates(g: GateInputs): GateResult {
  if (!g.donating) return { state: 'paused', ok: false };
  if (g.onBattery) return { state: 'on-battery', ok: false };
  if (!inSchedule(g.schedule, g.now ?? new Date())) return { state: 'schedule-off', ok: false };
  if (g.gpuUtil > g.gpuBusyThreshold) return { state: 'gpu-busy', ok: false };
  if (g.idleSec < g.idleThresholdSec) return { state: 'idle-wait', ok: false };
  return { state: 'available', ok: true };
}

export function inSchedule(schedule: string | null, now: Date): boolean {
  if (!schedule) return true;
  const m = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/.exec(schedule.trim());
  if (!m) return true; // unparsable schedule = fail open (donate)
  const cur = now.getHours() * 60 + now.getMinutes();
  const from = Number(m[1]) * 60 + Number(m[2]);
  const to = Number(m[3]) * 60 + Number(m[4]);
  if (from === to) return true;
  if (from < to) return cur >= from && cur < to;
  // overnight window (e.g. 22:00-07:00)
  return cur >= from || cur < to;
}
