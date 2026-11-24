/**
 * In-memory sliding-window limiter for sign-in and password-setup attempts, keyed by client IP and
 * by e-mail. It complements the per-account lockout stored in the database (which survives
 * restarts and works across instances). Cluster-wide rate limiting arrives in Phase 8.
 */
export class AttemptLimiter {
  private readonly attempts = new Map<string, number[]>();

  constructor(
    private readonly maxAttempts: number,
    private readonly windowMs: number,
    private readonly maxKeys = 50_000,
  ) {}

  /** Records an attempt; returns false when the key is over its budget (the attempt is refused). */
  tryConsume(key: string, now = Date.now()): boolean {
    const recent = (this.attempts.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.maxAttempts) {
      this.attempts.set(key, recent);
      return false;
    }
    recent.push(now);
    this.attempts.set(key, recent);
    if (this.attempts.size > this.maxKeys) this.prune(now);
    return true;
  }

  reset(key: string): void {
    this.attempts.delete(key);
  }

  private prune(now: number): void {
    for (const [key, times] of this.attempts) {
      if (times.every((t) => now - t >= this.windowMs)) this.attempts.delete(key);
    }
    // Still too many distinct keys (spray attack): drop the oldest entries.
    for (const key of this.attempts.keys()) {
      if (this.attempts.size <= this.maxKeys) break;
      this.attempts.delete(key);
    }
  }
}
