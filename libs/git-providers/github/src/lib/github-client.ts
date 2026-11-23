import { ProviderApiError } from '@acra/git-providers-core';
import { assertSafeOutboundUrl, type OutboundPolicy } from '@acra/security';

export class GitHubApiError extends ProviderApiError {
  constructor(status: number, message: string) {
    super(status, message);
    this.name = 'GitHubApiError';
  }
}

export interface GitHubClientOptions {
  /** REST base, e.g. https://api.github.com or https://ghe.example.com/api/v3 */
  readonly apiBaseUrl: string;
  /** Supplies a bearer token per request (app JWT or installation token). Never logged. */
  readonly token: () => Promise<string>;
  readonly policy: OutboundPolicy;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  readonly maxRetries?: number;
  readonly fetchImpl?: typeof fetch;
}

const API_VERSION = '2022-11-28';
const MAX_PAGES = 50;

/**
 * Minimal GitHub REST/GraphQL client with the same outbound controls as the GitLab client
 * (ADR-027): SSRF policy on the base URL, no redirects, timeouts, bounded retries (429, 5xx,
 * secondary rate limits), response size caps, and pagination that only follows `Link` URLs on the
 * same origin.
 */
export class GitHubClient {
  private readonly base: URL;
  private readonly fetchImpl: typeof fetch;
  private validated: Promise<unknown> | undefined;

  constructor(private readonly options: GitHubClientOptions) {
    this.base = new URL(options.apiBaseUrl.replace(/\/+$/, '') + '/');
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** GraphQL endpoint: api.github.com/graphql, or <host>/api/graphql for GitHub Enterprise Server. */
  private get graphqlUrl(): URL {
    const path = this.base.pathname.replace(/\/$/, '');
    return new URL(path.endsWith('/api/v3') ? `${path.slice(0, -3)}graphql` : `${path}/graphql`, this.base.origin);
  }

  async get<T>(path: string, query: Record<string, string | number> = {}): Promise<T> {
    return (await this.json('GET', this.url(path, query))) as T;
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    return (await this.json('POST', this.url(path), body)) as T;
  }

  async patch<T>(path: string, body: unknown): Promise<T> {
    return (await this.json('PATCH', this.url(path), body)) as T;
  }

  async paginate<T>(
    path: string,
    query: Record<string, string | number> = {},
    pick?: (page: unknown) => T[],
  ): Promise<T[]> {
    const items: T[] = [];
    let next: URL | null = this.url(path, { ...query, per_page: 100 });
    for (let page = 0; next && page < MAX_PAGES; page++) {
      const response = await this.request('GET', next);
      const body = JSON.parse(await readCapped(response, this.options.maxResponseBytes ?? 20_000_000)) as unknown;
      items.push(...(pick ? pick(body) : (body as T[])));
      next = this.nextLink(response.headers.get('link'));
    }
    return items;
  }

  async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const body = (await this.json('POST', this.graphqlUrl, { query, variables })) as {
      data?: T;
      errors?: Array<{ message?: string }>;
    };
    if (body.errors?.length)
      throw new GitHubApiError(200, `GitHub GraphQL error: ${(body.errors[0]?.message ?? 'unknown').slice(0, 300)}`);
    if (!body.data) throw new GitHubApiError(200, 'GitHub GraphQL returned no data');
    return body.data;
  }

  /** Raw file contents; null on 404; stops reading beyond maxBytes. */
  async raw(
    path: string,
    query: Record<string, string | number>,
    maxBytes: number,
  ): Promise<{ data: Buffer; tooLarge: boolean } | null> {
    let response: Response;
    try {
      response = await this.request('GET', this.url(path, query), undefined, 'application/vnd.github.raw+json');
    } catch (error) {
      if (error instanceof GitHubApiError && error.status === 404) return null;
      throw error;
    }
    if (Number(response.headers.get('content-length') ?? '0') > maxBytes) {
      await response.body?.cancel();
      return { data: Buffer.alloc(0), tooLarge: true };
    }
    const chunks: Buffer[] = [];
    let size = 0;
    const reader = response.body?.getReader();
    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        return { data: Buffer.alloc(0), tooLarge: true };
      }
      chunks.push(Buffer.from(value));
    }
    return { data: Buffer.concat(chunks), tooLarge: false };
  }

  private url(path: string, query: Record<string, string | number> = {}): URL {
    const url = new URL(path.replace(/^\//, ''), this.base);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
    return url;
  }

  /** Follows rel="next" only within the configured API origin (a Link header must not redirect the token). */
  private nextLink(header: string | null): URL | null {
    const match = header
      ?.split(',')
      .map((part) => /<([^>]+)>;\s*rel="next"/.exec(part.trim()))
      .find(Boolean);
    if (!match?.[1]) return null;
    const next = new URL(match[1]);
    if (next.origin !== this.base.origin)
      throw new GitHubApiError(0, 'Pagination link points to another host; refusing to follow');
    return next;
  }

  private async json(method: string, url: URL, body?: unknown): Promise<unknown> {
    const response = await this.request(method, url, body);
    const text = await readCapped(response, this.options.maxResponseBytes ?? 20_000_000);
    return text.length === 0 ? null : (JSON.parse(text) as unknown);
  }

  private async request(
    method: string,
    url: URL,
    body?: unknown,
    accept = 'application/vnd.github+json',
  ): Promise<Response> {
    this.validated ??= assertSafeOutboundUrl(this.base.toString(), this.options.policy);
    await this.validated;
    const maxRetries = this.options.maxRetries ?? 3;

    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method,
          redirect: 'manual',
          signal: AbortSignal.timeout(this.options.timeoutMs ?? 30_000),
          headers: {
            authorization: `Bearer ${await this.options.token()}`,
            accept,
            'x-github-api-version': API_VERSION,
            'user-agent': 'acra-review-bot',
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      } catch (error) {
        if (attempt < maxRetries) {
          await delay(backoff(attempt));
          continue;
        }
        throw new GitHubApiError(0, `GitHub request failed: ${error instanceof Error ? error.name : 'network error'}`);
      }

      if (response.status >= 300 && response.status < 400) {
        throw new GitHubApiError(response.status, 'GitHub responded with a redirect; refusing to follow it');
      }
      const rateLimited =
        response.status === 429 || (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0');
      if ((rateLimited || [502, 503, 504].includes(response.status)) && attempt < maxRetries) {
        await response.body?.cancel();
        await delay(retryDelay(response.headers) ?? backoff(attempt));
        continue;
      }
      if (!response.ok) {
        const detail = await readCapped(response, 10_000).catch(() => '');
        throw new GitHubApiError(
          rateLimited ? 429 : response.status,
          `GitHub ${method} ${routeOf(url)} → ${response.status}: ${errorMessage(detail)}`,
        );
      }
      return response;
    }
  }
}

async function readCapped(response: Response, maxBytes: number): Promise<string> {
  if (Number(response.headers.get('content-length') ?? '0') > maxBytes)
    throw new GitHubApiError(response.status, 'GitHub response too large');
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > maxBytes) throw new GitHubApiError(response.status, 'GitHub response too large');
  return buffer.toString('utf8');
}

function errorMessage(body: string): string {
  try {
    const parsed = JSON.parse(body) as { message?: unknown; errors?: unknown };
    return `${String(parsed.message ?? '')}${parsed.errors ? ` ${JSON.stringify(parsed.errors)}` : ''}`.slice(0, 300);
  } catch {
    return body.slice(0, 300);
  }
}

/** Route shape only: owner/repo names and file paths may be sensitive. */
function routeOf(url: URL): string {
  return url.pathname.replace(/\/repos\/[^/]+\/[^/]+/, '/repos/…').replace(/\/contents\/.*/, '/contents/…');
}

function retryDelay(headers: Headers): number | null {
  const retryAfter = headers.get('retry-after');
  if (retryAfter !== null && Number.isFinite(Number(retryAfter))) return Math.min(30_000, Number(retryAfter) * 1000);
  const reset = Number(headers.get('x-ratelimit-reset'));
  if (Number.isFinite(reset) && reset > 0) return Math.min(30_000, Math.max(0, reset * 1000 - Date.now()));
  return null;
}

function backoff(attempt: number): number {
  return Math.min(8_000, 500 * 2 ** attempt);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
