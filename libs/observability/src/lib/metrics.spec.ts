import { bearerMatches, MetricsRegistry } from './metrics';

describe('MetricsRegistry', () => {
  it('renders counters, gauges and histograms in Prometheus text format', async () => {
    const registry = new MetricsRegistry('t_');
    const requests = registry.counter('requests_total', 'Requests.', ['method', 'status']);
    const depth = registry.gauge('queue_jobs', 'Jobs.', ['queue', 'state']);
    const latency = registry.histogram('latency_seconds', 'Latency.', ['route'], [0.1, 1]);
    requests.inc({ method: 'GET', status: '200' });
    requests.inc({ method: 'GET', status: '200' }, 2);
    depth.set({ queue: 'reviews', state: 'waiting' }, 4);
    latency.observe({ route: '/a' }, 0.05);
    latency.observe({ route: '/a' }, 0.5);
    latency.observe({ route: '/a' }, 3);

    const text = await registry.render();
    expect(text).toContain('# TYPE t_requests_total counter');
    expect(text).toContain('t_requests_total{method="GET",status="200"} 3');
    expect(text).toContain('t_queue_jobs{queue="reviews",state="waiting"} 4');
    expect(text).toContain('t_latency_seconds_bucket{route="/a",le="0.1"} 1');
    expect(text).toContain('t_latency_seconds_bucket{route="/a",le="1"} 2');
    expect(text).toContain('t_latency_seconds_bucket{route="/a",le="+Inf"} 3');
    expect(text).toContain('t_latency_seconds_count{route="/a"} 3');
    expect(text).toContain('t_process_resident_memory_bytes');
    expect(text.endsWith('\n')).toBe(true);
  });

  it('escapes label values and rejects invalid names, duplicates and negative counts', () => {
    const registry = new MetricsRegistry('t_');
    const counter = registry.counter('c', 'C.', ['v']);
    counter.inc({ v: 'a"b\\c\nd' });
    expect(counter.render()).toContain('t_c{v="a\\"b\\\\c\\nd"} 1');
    expect(() => registry.counter('c', 'again')).toThrow(/Duplicate/);
    expect(() => registry.counter('bad-name', 'x')).toThrow(/Invalid/);
    expect(() => counter.inc({}, -1)).toThrow();
  });

  it('refreshes gauges through collectors and survives a failing collector', async () => {
    const registry = new MetricsRegistry('t_');
    const gauge = registry.gauge('g', 'G.');
    registry.onCollect(() => gauge.set({}, 7));
    registry.onCollect(() => Promise.reject(new Error('redis down')));
    expect(await registry.render()).toContain('t_g 7');
  });
});

describe('bearerMatches', () => {
  it('accepts only the exact bearer token', () => {
    expect(bearerMatches('Bearer secret-token', 'secret-token')).toBe(true);
    expect(bearerMatches('Bearer secret-tokem', 'secret-token')).toBe(false);
    expect(bearerMatches('secret-token', 'secret-token')).toBe(false);
    expect(bearerMatches(undefined, 'secret-token')).toBe(false);
    expect(bearerMatches('Bearer ', undefined)).toBe(false);
  });
});
