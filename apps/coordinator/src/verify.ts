// Output verification: the coordinator periodically sends synthetic probe
// jobs (temp 0, small budgets) to each node plus reference nodes serving the
// same model, then compares. Pure comparison functions are unit-tested.

export interface ProbeSpec {
  prompt: string;
  maxTokens: number;
}

/** Deterministic-ish probe bank: short prompts with verifiable answers. */
export const PROBE_BANK: ProbeSpec[] = [
  { prompt: 'List the first ten prime numbers, comma-separated, nothing else.', maxTokens: 48 },
  { prompt: 'What is 17 times 23? Answer with the number only.', maxTokens: 16 },
  { prompt: 'Name the capital of France in one word.', maxTokens: 8 },
  { prompt: 'Spell the word "triangle" backwards. Answer with only the result.', maxTokens: 12 },
  { prompt: 'Count from 1 to 10, one number per line, then stop.', maxTokens: 48 },
];

export function nextProbe(seed: number): ProbeSpec {
  return PROBE_BANK[Math.abs(seed) % PROBE_BANK.length]!;
}

/** Lowercase, strip punctuation/whitespace — token models differ in spacing. */
export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .join(' ');
}

/** Character-trigram Jaccard similarity, 0..1. Cheap and dependency-free. */
export function trigramSimilarity(a: string, b: string): number {
  const ta = trigrams(normalize(a));
  const tb = trigrams(normalize(b));
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const g of ta) if (tb.has(g)) inter++;
  return inter / (ta.size + tb.size - inter);
}

function trigrams(s: string): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i + 3 <= s.length; i++) out.add(s.slice(i, i + 3));
  return out;
}

export const SIM_MATCH_THRESHOLD = 0.55;

export type ProbeVerdict = 'match' | 'mismatch' | 'unverifiable';

/**
 * Majority rule over trusted references: with fewer than two successful
 * references there is no ground truth (a lone ref would let one bad node
 * frame one good node in a 2-node grid), so the round is unverifiable.
 * Otherwise the target matches if at least half the references agree.
 */
export function verdict(target: string, references: string[], threshold = SIM_MATCH_THRESHOLD): ProbeVerdict {
  if (references.length < 2) return 'unverifiable';
  const agreeing = references.filter((r) => trigramSimilarity(target, r) >= threshold).length;
  return agreeing >= Math.ceil(references.length / 2) ? 'match' : 'mismatch';
}
