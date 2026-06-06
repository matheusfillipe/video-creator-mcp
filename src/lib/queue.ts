export interface LimiterStatus {
  active: number;
  queued: number;
}

/**
 * Caps the number of concurrently running async tasks. Excess calls wait until a slot frees,
 * preserving FIFO order. Every CPU-heavy engine job funnels through one shared instance so the
 * host is never starved by parallel renders.
 */
export class Limiter {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly maxConcurrent: number) {}

  status(): LimiterStatus {
    return { active: this.active, queued: this.waiting.length };
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.maxConcurrent) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.active += 1;
    try {
      return await fn();
    } finally {
      this.active -= 1;
      const next = this.waiting.shift();
      if (next) next();
    }
  }
}
