/**
 * Minimal Prometheus metrics (text exposition format 0.0.4) without dependencies.
 *
 * Label values come from a small, fixed set chosen by the code (route templates, statuses, provider
 * names), never from request data such as URLs or ids, so cardinality stays bounded.
 */

export type Labels = Readonly<Record<string, string>>;

const NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;

function escapeLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

function labelKey(labelNames: readonly string[], labels: Labels): string {
  return labelNames.map((name) => labels[name] ?? '').join('\u0000');
}

function renderLabels(labelNames: readonly string[], values: readonly string[], extra = ''): string {
  const parts = labelNames.map((name, i) => `${name}="${escapeLabel(values[i] ?? '')}"`);
  if (extra) parts.push(extra);
  return parts.length > 0 ? `{${parts.join(',')}}` : '';
}

abstract class Metric {
  constructor(
    readonly name: string,
    readonly help: string,
    readonly labelNames: readonly string[],
  ) {
    if (!NAME.test(name)) throw new Error(`Invalid metric name ${name}`);
  }
  abstract render(): string[];
}

export class Counter extends Metric {
  private readonly values = new Map<string, { labels: string[]; value: number }>();

  inc(labels: Labels = {}, amount = 1): void {
    if (amount < 0) throw new Error('Counters only increase');
    const key = labelKey(this.labelNames, labels);
    const entry = this.values.get(key) ?? { labels: this.labelNames.map((n) => labels[n] ?? ''), value: 0 };
    entry.value += amount;
    this.values.set(key, entry);
  }

  render(): string[] {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    for (const { labels, value } of this.values.values()) {
      lines.push(`${this.name}${renderLabels(this.labelNames, labels)} ${value}`);
    }
    return lines;
  }
}

export class Gauge extends Metric {
  private readonly values = new Map<string, { labels: string[]; value: number }>();

  set(labels: Labels, value: number): void {
    this.values.set(labelKey(this.labelNames, labels), { labels: this.labelNames.map((n) => labels[n] ?? ''), value });
  }

  render(): string[] {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} gauge`];
    for (const { labels, value } of this.values.values()) {
      lines.push(`${this.name}${renderLabels(this.labelNames, labels)} ${value}`);
    }
    return lines;
  }
}

export class Histogram extends Metric {
  private readonly values = new Map<string, { labels: string[]; buckets: number[]; sum: number; count: number }>();

  constructor(
    name: string,
    help: string,
    labelNames: readonly string[],
    readonly buckets: readonly number[],
  ) {
    super(name, help, labelNames);
    if (buckets.some((b, i) => i > 0 && b <= (buckets[i - 1] ?? 0))) throw new Error('Buckets must increase');
  }

  observe(labels: Labels, value: number): void {
    const key = labelKey(this.labelNames, labels);
    const entry = this.values.get(key) ?? {
      labels: this.labelNames.map((n) => labels[n] ?? ''),
      buckets: this.buckets.map(() => 0),
      sum: 0,
      count: 0,
    };
    this.buckets.forEach((bound, i) => {
      if (value <= bound) entry.buckets[i] = (entry.buckets[i] ?? 0) + 1;
    });
    entry.sum += value;
    entry.count += 1;
    this.values.set(key, entry);
  }

  render(): string[] {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const { labels, buckets, sum, count } of this.values.values()) {
      this.buckets.forEach((bound, i) => {
        lines.push(`${this.name}_bucket${renderLabels(this.labelNames, labels, `le="${bound}"`)} ${buckets[i] ?? 0}`);
      });
      lines.push(`${this.name}_bucket${renderLabels(this.labelNames, labels, 'le="+Inf"')} ${count}`);
      lines.push(`${this.name}_sum${renderLabels(this.labelNames, labels)} ${sum}`);
      lines.push(`${this.name}_count${renderLabels(this.labelNames, labels)} ${count}`);
    }
    return lines;
  }
}

/** A set of metrics rendered together. `collect` hooks refresh gauges right before each scrape. */
export class MetricsRegistry {
  private readonly metrics: Metric[] = [];
  private readonly collectors: Array<() => Promise<void> | void> = [];

  constructor(private readonly prefix = 'acra_') {}

  counter(name: string, help: string, labelNames: readonly string[] = []): Counter {
    return this.add(new Counter(`${this.prefix}${name}`, help, labelNames));
  }

  gauge(name: string, help: string, labelNames: readonly string[] = []): Gauge {
    return this.add(new Gauge(`${this.prefix}${name}`, help, labelNames));
  }

  histogram(name: string, help: string, labelNames: readonly string[], buckets: readonly number[]): Histogram {
    return this.add(new Histogram(`${this.prefix}${name}`, help, labelNames, buckets));
  }

  onCollect(collector: () => Promise<void> | void): void {
    this.collectors.push(collector);
  }

  /** Prometheus text format. A failing collector never breaks the scrape (its gauges stay stale). */
  async render(): Promise<string> {
    await Promise.all(this.collectors.map(async (collect) => Promise.resolve(collect()).catch(() => undefined)));
    const process = this.processMetrics();
    return `${[...this.metrics.flatMap((m) => m.render()), ...process].join('\n')}\n`;
  }

  private add<T extends Metric>(metric: T): T {
    if (this.metrics.some((m) => m.name === metric.name)) throw new Error(`Duplicate metric ${metric.name}`);
    this.metrics.push(metric);
    return metric;
  }

  private processMetrics(): string[] {
    const memory = globalThis.process?.memoryUsage?.();
    const uptime = globalThis.process?.uptime?.() ?? 0;
    return [
      `# HELP ${this.prefix}process_uptime_seconds Process uptime.`,
      `# TYPE ${this.prefix}process_uptime_seconds gauge`,
      `${this.prefix}process_uptime_seconds ${Math.round(uptime)}`,
      `# HELP ${this.prefix}process_resident_memory_bytes Resident set size.`,
      `# TYPE ${this.prefix}process_resident_memory_bytes gauge`,
      `${this.prefix}process_resident_memory_bytes ${memory?.rss ?? 0}`,
      `# HELP ${this.prefix}process_heap_used_bytes V8 heap in use.`,
      `# TYPE ${this.prefix}process_heap_used_bytes gauge`,
      `${this.prefix}process_heap_used_bytes ${memory?.heapUsed ?? 0}`,
    ];
  }
}

/** Default latency buckets in seconds (HTTP requests). */
export const HTTP_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10] as const;
/** Buckets in seconds for AI reviews (seconds to many minutes). */
export const REVIEW_BUCKETS = [1, 5, 15, 30, 60, 120, 300, 600, 1200] as const;

/** Constant-time comparison of a bearer token (for /metrics). */
export function bearerMatches(header: string | undefined, token: string | undefined): boolean {
  if (!token || typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const presented = header.slice(7);
  if (presented.length !== token.length) return false;
  let diff = 0;
  for (let i = 0; i < token.length; i++) diff |= presented.charCodeAt(i) ^ token.charCodeAt(i);
  return diff === 0;
}
