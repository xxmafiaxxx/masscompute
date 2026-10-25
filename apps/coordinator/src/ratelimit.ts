// Sliding-window request rate limiter (per key or per IP).

export class RateLimiter {
  private hits = new Map<string, number[]>();

  constructor(
    private max: number,
    private windowMs: number,
  ) {}

  allow(subject: string, now = Date.now()): boolean {
    const arr = (this.hits.get(subject) ?? []).filter((t) => now - t < this.windowMs);
    if (arr.length >= this.max) {
      this.hits.set(subject, arr);
      return false;
    }
    arr.push(now);
    this.hits.set(subject, arr);
    return true;
  }

  /** Periodic sweep so the map does not grow forever. */
  sweep(now = Date.now()): void {
    for (const [k, arr] of this.hits) {
      const keep = arr.filter((t) => now - t < this.windowMs);
      if (keep.length === 0) this.hits.delete(k);
      else this.hits.set(k, keep);
    }
  }
}
