import { ProviderApiError } from '@acra/git-providers-core';
import { assertSafeOutboundUrl, type OutboundPolicy } from '@acra/security';

export interface GitLabClientOptions {
  /** Instance root, e.g. https://gitlab.com (validated against the outbound policy). */
  readonly baseUrl: string;
  /** Access token with `api` scope. Sent only to `baseUrl`; never logged. */
  readonly token: string;
  readonly policy: OutboundPolicy;
  readonly timeoutMs?: number;
  /** Cap for JSON responses. Default 20 MB. */
  readonly maxResponseBytes?: number;
  /** Retries for 429/502/503/504. Default 3. */
  readonly maxRetries?: number;
  readonly fetchImpl?: typeof fetch;
}

/** Error from the GitLab API. The message never contains the token or request body. */
export class GitLabApiError extends ProviderApiError {
  constructor(status: number, message: string) {
    super(status, message);
    this.name = 'GitLabApiError';
  }
}

const RETRYABLE = new Set([429, 502, 503, 504]);
const MAX_PAGES = 50;

/**
 * Minimal typed client for GitLab REST v4 (ADR-027). Deliberately small instead of a full SDK so
 * every outbound request is under our control:
 *  - the base URL passes the SSRF policy before the first request (https, allowlisted host,
 *    public addresses only unless private networks are explicitly allowed);
 *  - redirects are not followed (a redirect could point the token at another host);
 *  - per-request timeout, bounded retries honouring Retry-After, response size caps.
 */
export class GitLabClient {
  private readonly apiBase: string;
  private readonly fetchImpl: typeof fetch;
  private validated: Promise<unknown> | undefined;

  constructor(private readonly options: GitLabClientOptions) {
    this.apiBase = `${options.baseUrl.replace(/\/+$/, '')}/api/v4`;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async get<T>(path: string, query: Record<string, string | number> = {}): Promise<T> {
    return (await this.send('GET', path, query)).json() as Promise<T>;
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    return (await this.send('POST', path, {}, body)).json() as Promise<T>;
  }

  async put<T>(path: string, body: unknown, query: Record<string, string | number> = {}): Promise<T> {
    return (await this.send('PUT', path, query, body)).json() as Promise<T>;
  }

  /** Follows `x-next-page` (per_page=100) up to 50 pages. */
  async paginate<T>(path: string, query: Record<string, string | number> = {}): Promise<T[]> {
    const items: T[] = [];
    let page: string | null = '1';
    for (let count = 0; page && count < MAX_PAGES; count++) {
      const response = await this.send('GET', path, { ...query, per_page: 100, page });
      items.push(...((await response.json()) as T[]));
      page = response.headers.get('x-next-page') || null;
    }
    return items;
  }

  /** Raw body (e.g. file contents). Returns null on 404; stops reading beyond `maxBytes`. */
  async raw(
    path: string,
    query: Record<string, string | number>,
    maxBytes: number,
  ): Promise<{ data: Buffer; tooLarge: boolean } | null> {
    let response: Response;
    try {
      response = await this.request('GET', path, query, undefined);
    } catch (error) {
      if (error instanceof GitLabApiError && error.status === 404) return null;
      throw error;
    }
    const declared = Number(response.headers.get('content-length') ?? '0');
    if (declared > maxBytes) {
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

  private async send(
    method: string,
    path: string,
    query: Record<string, string | number>,
    body?: unknown,
  ): Promise<{ json(): Promise<unknown>; headers: Headers }> {
    const response = await this.request(method, path, query, body);
    const text = await readCapped(response, this.options.maxResponseBytes ?? 20_000_000);
    return {
      headers: response.headers,
      json: () => Promise.resolve(text.length === 0 ? null : (JSON.parse(text) as unknown)),
    };
  }

  private async request(
    method: string,
    path: string,
    query: Record<string, string | number>,
    body: unknown,
  ): Promise<Response> {
    this.validated ??= assertSafeOutboundUrl(this.options.baseUrl, this.options.policy);
    await this.validated;

    const url = new URL(`${this.apiBase}${path}`);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
    const maxRetries = this.options.maxRetries ?? 3;

    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method,
          redirect: 'manual',
          signal: AbortSignal.timeout(this.options.timeoutMs ?? 30_000),
          headers: {
            'PRIVATE-TOKEN': this.options.token,
            accept: 'application/json',
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
        throw new GitLabApiError(0, `GitLab request failed: ${error instanceof Error ? error.name : 'network error'}`);
      }

      if (response.status >= 300 && response.status < 400) {
        throw new GitLabApiError(response.status, 'GitLab responded with a redirect; refusing to follow it');
      }
      if (RETRYABLE.has(response.status) && attempt < maxRetries) {
        await response.body?.cancel();
        await delay(retryAfterMs(response.headers.get('retry-after')) ?? backoff(attempt));
        continue;
      }
      if (!response.ok) {
        const detail = await readCapped(response, 10_000).catch(() => '');
        throw new GitLabApiError(
          response.status,
          `GitLab ${method} ${redactPath(path)} → ${response.status}: ${errorMessage(detail)}`,
        );
      }
      return response;
    }
  }
}

async function readCapped(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (declared > maxBytes) throw new GitLabApiError(response.status, 'GitLab response too large');
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > maxBytes) throw new GitLabApiError(response.status, 'GitLab response too large');
  return buffer.toString('utf8');
}

function errorMessage(body: string): string {
  try {
    const parsed = JSON.parse(body) as { message?: unknown; error?: unknown };
    const message = parsed.message ?? parsed.error;
    return (typeof message === 'string' ? message : JSON.stringify(message ?? '')).slice(0, 300);
  } catch {
    return body.slice(0, 300);
  }
}

/** File paths may be sensitive; keep only the route shape in error messages. */
function redactPath(path: string): string {
  return path.replace(/\/repository\/files\/[^/]+/, '/repository/files/…');
}

function retryAfterMs(header: string | null): number | null {
  if (header === null) return null;
  const seconds = Number(header);
  return Number.isFinite(seconds) ? Math.min(30_000, Math.max(0, seconds * 1000)) : null;
}

function backoff(attempt: number): number {
  return Math.min(8_000, 500 * 2 ** attempt);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
