// Hardware probe: detect GPUs + backend across Windows/macOS/Linux.
// Falls back to CPU-only when nothing usable is found; never throws.

import { execFile } from 'node:child_process';
import os from 'node:os';
import { promisify } from 'node:util';
import type { GpuInfo, NodeSpecs } from '@masscompute/protocol';

const pExecFile = promisify(execFile);

export interface ProbeResult extends NodeSpecs {
  /** Best usable backend for llama.cpp. */
  backend: GpuInfo['backend'];
  /** Total VRAM across usable GPUs, MB (0 for CPU). */
  vramTotalMb: number;
  /** function returning current max GPU util % (0-100); stub 0 when unknown. */
  gpuUtil: () => Promise<number>;
}

function run(cmd: string, args: string[], timeoutMs = 8000): Promise<string | null> {
  return pExecFile(cmd, args, { timeout: timeoutMs, windowsHide: true })
    .then((r) => r.stdout)
    .catch(() => null);
}

/** wmic /format:csv — null when wmic itself is missing (Win11 24H2+). */
export function parseWmicCsv(out: string | null): Array<{ name: string; rawBytes: number }> | null {
  if (out === null) return null;
  const lines = out.split('\n').map((l) => l.trim()).filter(Boolean);
  const header = lines.find((l) => /^Node,/i.test(l));
  // Columns are discovered from the header row (wmic puts `Node` first;
  // order is locale-independent).
  const cols = (header ?? 'Node,AdapterRAM,Name').split(',').map((s) => s.trim().toLowerCase());
  const nameCol = cols.indexOf('name');
  const ramCol = cols.indexOf('adapterram');
  return lines
    .filter((l) => l !== header)
    .map((l) => {
      const parts = l.split(',').map((s) => s.trim());
      return { name: parts[nameCol] ?? '', rawBytes: Number.parseInt(parts[ramCol] ?? '0', 10) || 0 };
    });
}

/** PowerShell ConvertTo-Csv output for the fixed query: "Name","AdapterRAM". */
export function parseCimCsv(out: string | null): Array<{ name: string; rawBytes: number }> {
  if (!out) return [];
  const lines = out.split('\n').map((l) => l.trim()).filter(Boolean);
  return lines
    .slice(1) // header row: "Name","AdapterRAM"
    .map((l) => {
      const parts = l.split('","').map((s) => s.replace(/^"/, '').replace(/"$/, ''));
      return { name: parts[0] ?? '', rawBytes: Number.parseInt(parts[1] ?? '0', 10) || 0 };
    });
}

export async function probe(): Promise<ProbeResult> {
  const osName: NodeSpecs['os'] = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux';
  const cpuModel = os.cpus()[0]?.model?.trim() ?? 'unknown CPU';
  const ramTotalMb = Math.round(os.totalmem() / (1024 * 1024));
  const base = { os: osName, cpuModel, ramTotalMb, workerVersion: '0.1.0' };
  const noop = async () => 0;

  if (osName === 'windows') {
    // NVIDIA: nvidia-smi gives names, VRAM, and live utilization.
    const smi = await run('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits']);
    if (smi) {
      const gpus: GpuInfo[] = smi
        .split('\n')
        .map((l) => l.split(',').map((s) => s.trim()))
        .filter((p) => p.length >= 2 && p[0])
        .map((p) => ({ name: p[0]!, vramTotalMb: Number.parseInt(p[1] ?? '0', 10) || 0, backend: 'cuda' as const }));
      if (gpus.length > 0) {
        return {
          ...base,
          gpus,
          backend: 'cuda',
          vramTotalMb: gpus.reduce((n, g) => n + g.vramTotalMb, 0),
          gpuUtil: async () => {
            const out = await run('nvidia-smi', ['--query-gpu=utilization.gpu', '--format=csv,noheader,nounits']);
            if (!out) return 0;
            return Math.max(...out.split('\n').map((l) => Number.parseInt(l.trim(), 10) || 0));
          },
        };
      }
    }
    // AMD/Intel/anything: llama.cpp Vulkan build handles them all. WMI
    // AdapterRAM saturates at 4GB (32-bit UINT) — treat the reading as a
    // floor and default unknowns to 8GB. wmic died with Windows 11 24H2, so
    // fall back to PowerShell CIM when it is gone.
    let gpuRows: Array<{ name: string; rawBytes: number }> | null = parseWmicCsv(
      await run('wmic', ['path', 'win32_VideoController', 'get', 'Name,AdapterRAM', '/format:csv']),
    );
    if (gpuRows === null) {
      gpuRows = parseCimCsv(
        await run('powershell', [
          '-NoProfile',
          '-Command',
          'Get-CimInstance Win32_VideoController | Select-Object Name,AdapterRAM | ConvertTo-Csv -NoTypeInformation',
        ]),
      );
    }
    const gpus: GpuInfo[] = (gpuRows ?? [])
      .map(({ name, rawBytes }) => {
        const mb = rawBytes > 0 && rawBytes < 3_800_000 ? Math.round(rawBytes / (1024 * 1024)) : 8192;
        return { name, vramTotalMb: mb, backend: 'vulkan' as const };
      })
      .filter((g) => g.name && !/basic|virtual|remote/i.test(g.name));
    if (gpus.length > 0) {
      return { ...base, gpus, backend: 'vulkan', vramTotalMb: gpus.reduce((n, g) => n + g.vramTotalMb, 0), gpuUtil: noop };
    }
    return { ...base, gpus: [], backend: 'cpu', vramTotalMb: 0, gpuUtil: noop };
  }

  if (osName === 'macos') {
    // Apple Silicon: unified memory serves as VRAM for Metal.
    const isArm = process.arch === 'arm64';
    if (isArm) {
      const chip = (await run('sysctl', ['-n', 'machdep.cpu.brand_string']))?.trim() ?? 'Apple Silicon';
      return {
        ...base,
        gpus: [{ name: chip, vramTotalMb: Math.round(ramTotalMb * 0.65), backend: 'metal' }],
        backend: 'metal',
        vramTotalMb: Math.round(ramTotalMb * 0.65),
        gpuUtil: noop,
      };
    }
    return { ...base, gpus: [], backend: 'cpu', vramTotalMb: 0, gpuUtil: noop };
  }

  // Linux: NVIDIA via smi, else Vulkan fallback for AMD/Intel.
  const smi = await run('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits']);
  if (smi) {
    const gpus: GpuInfo[] = smi
      .split('\n')
      .map((l) => l.split(',').map((s) => s.trim()))
      .filter((p) => p.length >= 2 && p[0])
      .map((p) => ({ name: p[0]!, vramTotalMb: Number.parseInt(p[1] ?? '0', 10) || 0, backend: 'cuda' as const }));
    if (gpus.length > 0) return { ...base, gpus, backend: 'cuda', vramTotalMb: gpus.reduce((n, g) => n + g.vramTotalMb, 0), gpuUtil: noop };
  }
  const lspci = await run('lspci', []);
  const vga = (lspci ?? '').split('\n').filter((l) => /VGA|3D controller|Display/i.test(l));
  if (vga.length > 0 && !/intel.*uhd/i.test(lspci ?? '')) {
    const gpus = vga.map((l) => ({ name: l.replace(/^[^:]*:\s*/, '').trim(), vramTotalMb: 8192, backend: 'vulkan' as const }));
    return { ...base, gpus, backend: 'vulkan', vramTotalMb: 8192, gpuUtil: noop };
  }
  return { ...base, gpus: [], backend: 'cpu', vramTotalMb: 0, gpuUtil: noop };
}
