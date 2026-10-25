// Pinned model catalog. Every entry is an open-weight instruct model from
// Hugging Face with an immutable commit revision and per-file sha256 pins
// verified by the worker after download. Donors never run unpinned models.

import type { CatalogEntry } from './messages.js';

function entry(
  id: string,
  label: string,
  tier: CatalogEntry['tier'],
  hfRepo: string,
  revision: string,
  vramMinMb: number,
  cpuCapable: boolean,
  contextDefault: number,
  description: string,
  files: [name: string, sha256: string, bytes: number][],
): CatalogEntry {
  return {
    id,
    label,
    tier,
    hfRepo,
    revision,
    files: files.map(([name, sha256, bytes]) => ({ name, sha256, bytes })),
    totalBytes: files.reduce((n, [, , b]) => n + b, 0),
    vramMinMb,
    cpuCapable,
    contextDefault,
    description,
  };
}

export const MODEL_CATALOG: CatalogEntry[] = [
  entry(
    'smollm2-135m-q8',
    'SmolLM2 135M (test tier)',
    'test',
    'bartowski/SmolLM2-135M-Instruct-GGUF',
    '09816acd5d99df7be770d85ea30822623dab342c',
    0,
    true,
    2048,
    'Tiny smoke-test model. Proves a donor node end-to-end on CPU in minutes; not for real use.',
    [['SmolLM2-135M-Instruct-Q8_0.gguf', '5a1395716f7913741cc51d98581b9b1228d80987a9f7d3664106742eb06bba83', 144_811_360]],
  ),
  entry(
    'qwen2.5-3b-q4km',
    'Qwen2.5 3B Instruct',
    'small',
    'Qwen/Qwen2.5-3B-Instruct-GGUF',
    '7dabda4d13d513e3e842b20f0d435c732f172cbe',
    3200,
    true,
    8192,
    'Small, fast chat model. Fits ~4GB+ GPUs and runs tolerably on CPU.',
    [['qwen2.5-3b-instruct-q4_k_m.gguf', '626b4a6678b86442240e33df819e00132d3ba7dddfe1cdc4fbb18e0a9615c62d', 2_104_932_768]],
  ),
  entry(
    'qwen2.5-7b-q4km',
    'Qwen2.5 7B Instruct',
    'mid',
    'Qwen/Qwen2.5-7B-Instruct-GGUF',
    'bb5d59e06d9551d752d08b292a50eb208b07ab1f',
    5500,
    false,
    8192,
    'The grid workhorse. Needs ~6GB+ free VRAM.',
    [
      ['qwen2.5-7b-instruct-q4_k_m-00001-of-00002.gguf', 'dfce12e3862a5283ccfb88221b48480e58745165de856439950d0f22590580db', 3_993_201_344],
      ['qwen2.5-7b-instruct-q4_k_m-00002-of-00002.gguf', '539cf93f78e887edea1c04e2d7d8cdaca9d01dae9c9025bcb8accbe29df3d72a', 689_872_288],
    ],
  ),
  entry(
    'qwen2.5-14b-q4km',
    'Qwen2.5 14B Instruct',
    'large',
    'Qwen/Qwen2.5-14B-Instruct-GGUF',
    'b466e1f8c07172155743e8e1307507d8a4f91fbd',
    9500,
    false,
    8192,
    'Big tier for donors with 10GB+ free VRAM.',
    [
      ['qwen2.5-14b-instruct-q4_k_m-00001-of-00003.gguf', 'a09ea5e7b1eafb1b30b241726c3cc3c905c96f14ad41e246ffa5f44e53904f68', 3_991_999_872],
      ['qwen2.5-14b-instruct-q4_k_m-00002-of-00003.gguf', '21b9457d079680d284e90ef69607c4b2d8ef64a09d4729cb7b5e1357bdba41ae', 3_989_373_504],
      ['qwen2.5-14b-instruct-q4_k_m-00003-of-00003.gguf', 'c8d37006760a387a35216e070e6664d7da927f10be8eb870fef2e3d4833d9976', 1_006_737_120],
    ],
  ),
];

export const DEFAULT_MODEL_ID = 'qwen2.5-3b-q4km';

export function catalogEntry(id: string): CatalogEntry | undefined {
  return MODEL_CATALOG.find((m) => m.id === id);
}

export function urlForFile(e: CatalogEntry, f: { name: string }): string {
  return `https://huggingface.co/${e.hfRepo}/resolve/${e.revision}/${f.name}`;
}
