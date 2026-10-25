// Live cluster metrics: rolling token throughput + counters.

export class Metrics {
  private window: Array<{ ts: number; tokens: number }> = [];
  requestsTotal = 0;
  requestsFailed = 0;
  tokensTotal = 0;
  tokensVerified = 0;
  startedAt = Date.now();

  recordTokens(tokens: number, verified: number, now = Date.now()): void {
    this.tokensTotal += tokens;
    this.tokensVerified += verified;
    this.window.push({ ts: now, tokens });
    this.trim(now);
  }

  tokensPerSecond(now = Date.now()): number {
    this.trim(now);
    const cutoff = now - 60_000;
    const sum = this.window.filter((w) => w.ts >= cutoff).reduce((n, w) => n + w.tokens, 0);
    return Math.round((sum / 60) * 10) / 10;
  }

  snapshot() {
    return {
      tokensTotal: this.tokensTotal,
      tokensVerified: this.tokensVerified,
      tokensPerSecond: this.tokensPerSecond(),
      requestsTotal: this.requestsTotal,
      requestsFailed: this.requestsFailed,
      uptimeSec: Math.floor((Date.now() - this.startedAt) / 1000),
    };
  }

  private trim(now: number): void {
    if (this.window.length > 5000) this.window = this.window.filter((w) => now - w.ts < 120_000);
  }
}
