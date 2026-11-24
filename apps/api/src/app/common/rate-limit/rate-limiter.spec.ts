import { RateLimiter, type RateLimitStore } from './rate-limiter';

class MemoryStore implements RateLimitStore {
  readonly counts = new Map<string, number>();
  fail = false;
  hit(key: string, windowMs: number) {
    if (this.fail) return Promise.reject(new Error('redis down'));
    const count = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, count);
    return Promise.resolve({ count, ttlMs: windowMs });
  }
  reset(key: string) {
    this.counts.delete(key);
    return Promise.resolve();
  }
}

describe('RateLimiter', () => {
  it('allows up to the limit per key, then refuses with the time until reset', async () => {
    const limiter = new RateLimiter(new MemoryStore());
    const results = [];
    for (let i = 0; i < 4; i++) results.push(await limiter.consume('user', 'u1', 3, 60_000));
    expect(results.map((r) => r.allowed)).toEqual([true, true, true, false]);
    expect(results.map((r) => r.remaining)).toEqual([2, 1, 0, 0]);
    expect(results[3]?.resetMs).toBe(60_000);
    expect((await limiter.consume('user', 'u2', 3, 60_000)).allowed).toBe(true);
  });

  it('keeps buckets separate and can reset a key', async () => {
    const store = new MemoryStore();
    const limiter = new RateLimiter(store);
    await limiter.consume('login-email', 'a@x', 1, 60_000);
    expect((await limiter.consume('login-email', 'a@x', 1, 60_000)).allowed).toBe(false);
    expect((await limiter.consume('login-ip', 'a@x', 1, 60_000)).allowed).toBe(true);
    await limiter.reset('login-email', 'a@x');
    expect((await limiter.consume('login-email', 'a@x', 1, 60_000)).allowed).toBe(true);
  });

  it('falls back to in-memory limits when the store is unavailable (never fails open completely)', async () => {
    const store = new MemoryStore();
    store.fail = true;
    const limiter = new RateLimiter(store);
    expect((await limiter.consume('anonymous', 'ip', 2, 60_000)).allowed).toBe(true);
    expect((await limiter.consume('anonymous', 'ip', 2, 60_000)).allowed).toBe(true);
    expect((await limiter.consume('anonymous', 'ip', 2, 60_000)).allowed).toBe(false);
  });
});
