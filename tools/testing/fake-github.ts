import { createVerify, generateKeyPairSync, type KeyObject, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { type AddressInfo } from 'node:net';

/**
 * In-memory fake of the GitHub REST v3 + GraphQL subset used by the GitHub adapter, served over
 * real HTTP on 127.0.0.1. It verifies app JWTs (RS256) against the app's public key, issues
 * installation tokens and enforces their repository scoping, validates review-comment positions
 * against the PR patch (422 like GitHub), and paginates with `Link` headers.
 */
export interface FakeGhFile {
  filename: string;
  previous_filename?: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
}

export interface FakeGhPull {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  draft: boolean;
  head: { sha: string; ref: string };
  base: { sha: string; ref: string };
  mergeBase: string;
  files: FakeGhFile[];
}

export interface FakeGhThread {
  id: string;
  isResolved: boolean;
  comment: { databaseId: number; body: string; login: string; path: string; line: number; commitId: string };
}

export interface FakeGhRepo {
  id: number;
  full_name: string;
  default_branch: string;
  html_url: string;
  installationId: number;
  pulls: Map<number, FakeGhPull>;
  files: Map<string, string>;
  threads: FakeGhThread[];
  issueComments: Array<{ id: number; body: string; login: string }>;
}

export class FakeGitHub {
  readonly appId = '12345';
  readonly slug = 'acra-review';
  readonly privateKeyPem: string;
  private readonly publicKey: KeyObject;
  readonly repos = new Map<string, FakeGhRepo>();
  readonly installations = new Map<number, { account: { login: string; type: string } }>();
  readonly tokens = new Map<string, { installationId: number; repositoryIds?: number[]; permissions: unknown }>();
  readonly requests: Array<{ method: string; path: string }> = [];
  rateLimitNext = 0;
  baseUrl = '';
  private server: Server | undefined;
  private nextId = 5000;

  constructor() {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    this.privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    this.publicKey = publicKey;
  }

  async start(): Promise<this> {
    this.server = createServer((req, res) => {
      this.handle(req, res).catch((error: unknown) => send(res, 500, { message: String(error) }));
    });
    await new Promise<void>((resolve) => this.server?.listen(0, '127.0.0.1', resolve));
    this.baseUrl = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  addInstallation(id: number, login: string): void {
    this.installations.set(id, { account: { login, type: 'Organization' } });
  }

  addRepo(fullName: string, installationId: number, id = this.nextId++): FakeGhRepo {
    const repo: FakeGhRepo = {
      id,
      full_name: fullName,
      default_branch: 'main',
      html_url: `https://github.example/${fullName}`,
      installationId,
      pulls: new Map(),
      files: new Map(),
      threads: [],
      issueComments: [],
    };
    this.repos.set(fullName, repo);
    return repo;
  }

  addPull(repo: FakeGhRepo, pull: Partial<FakeGhPull> & { number: number }): FakeGhPull {
    const full: FakeGhPull = {
      title: 'Change',
      body: '',
      state: 'open',
      merged: false,
      draft: false,
      head: { sha: 'b'.repeat(40), ref: 'feature' },
      base: { sha: 'a'.repeat(40), ref: 'main' },
      mergeBase: 'a'.repeat(40),
      files: [],
      ...pull,
    };
    repo.pulls.set(pull.number, full);
    return full;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', this.baseUrl);
    const method = req.method ?? 'GET';
    this.requests.push({ method, path: url.pathname });
    if (this.rateLimitNext > 0) {
      this.rateLimitNext--;
      res.setHeader('retry-after', '0');
      return send(res, 429, { message: 'rate limited' });
    }
    const bearer = /^Bearer (.+)$/.exec(req.headers['authorization'] ?? '')?.[1] ?? '';
    const body = method === 'POST' || method === 'PATCH' ? await readJson(req) : {};
    const p = url.pathname;
    let m: RegExpExecArray | null;

    // ---- App (JWT) endpoints ----
    if (p.startsWith('/app')) {
      if (!this.verifyJwt(bearer)) return send(res, 401, { message: 'A JSON web token could not be decoded' });
      if (method === 'GET' && p === '/app') return send(res, 200, { id: Number(this.appId), slug: this.slug });
      if ((m = /^\/app\/installations\/(\d+)$/.exec(p)) && method === 'GET') {
        const installation = this.installations.get(Number(m[1]));
        return installation
          ? send(res, 200, { id: Number(m[1]), ...installation })
          : send(res, 404, { message: 'Not Found' });
      }
      if ((m = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(p)) && method === 'POST') {
        const installationId = Number(m[1]);
        if (!this.installations.has(installationId)) return send(res, 404, { message: 'Not Found' });
        const token = `ghs_${randomBytes(18).toString('hex')}`;
        const repositoryIds = body['repository_ids'] as number[] | undefined;
        this.tokens.set(token, {
          installationId,
          ...(repositoryIds ? { repositoryIds } : {}),
          permissions: body['permissions'],
        });
        return send(res, 201, { token, expires_at: new Date(Date.now() + 3_600_000).toISOString() });
      }
      return send(res, 404, { message: 'Not Found' });
    }

    // ---- Installation-token endpoints ----
    const grant = this.tokens.get(bearer);
    if (!grant) return send(res, 401, { message: 'Bad credentials' });
    const canAccess = (repo: FakeGhRepo) =>
      repo.installationId === grant.installationId && (!grant.repositoryIds || grant.repositoryIds.includes(repo.id));

    if (method === 'GET' && p === '/installation/repositories') {
      const repos = [...this.repos.values()]
        .filter(canAccess)
        .map((r) => ({ id: r.id, full_name: r.full_name, default_branch: r.default_branch, html_url: r.html_url }));
      return paginate(res, url, repos, (items, total) => ({ total_count: total, repositories: items }));
    }

    if (method === 'POST' && p === '/graphql') return this.graphql(res, body, canAccess);

    if (!(m = /^\/repos\/([^/]+)\/([^/]+)(\/.*)$/.exec(p))) return send(res, 404, { message: 'Not Found' });
    const repo = this.repos.get(`${decodeURIComponent(m[1] ?? '')}/${decodeURIComponent(m[2] ?? '')}`);
    if (!repo || !canAccess(repo)) return send(res, 404, { message: 'Not Found' });
    const rest = m[3] ?? '';

    if ((m = /^\/contents\/(.+)$/.exec(rest)) && method === 'GET') {
      const content = repo.files.get(`${url.searchParams.get('ref')}:${decodeURIComponent(m[1] ?? '')}`);
      if (content === undefined) return send(res, 404, { message: 'Not Found' });
      res.writeHead(200, { 'content-type': 'application/vnd.github.raw' });
      return void res.end(content);
    }
    if ((m = /^\/compare\/([0-9a-f]+)\.\.\.([0-9a-f]+)$/.exec(rest)) && method === 'GET') {
      const pull = [...repo.pulls.values()].find((pr) => pr.base.sha === m?.[1] && pr.head.sha === m?.[2]);
      return pull
        ? send(res, 200, { merge_base_commit: { sha: pull.mergeBase } })
        : send(res, 404, { message: 'Not Found' });
    }
    if ((m = /^\/issues\/comments\/(\d+)$/.exec(rest)) && method === 'PATCH') {
      const comment = repo.issueComments.find((c) => c.id === Number(m?.[1]));
      if (!comment) return send(res, 404, { message: 'Not Found' });
      comment.body = String(body['body']);
      return send(res, 200, { id: comment.id, body: comment.body, user: { login: comment.login } });
    }
    if ((m = /^\/issues\/(\d+)\/comments$/.exec(rest))) {
      if (!repo.pulls.has(Number(m[1]))) return send(res, 404, { message: 'Not Found' });
      if (method === 'GET')
        return paginate(
          res,
          url,
          repo.issueComments.map((c) => ({ id: c.id, body: c.body, user: { login: c.login } })),
        );
      if (method === 'POST') {
        const comment = { id: this.nextId++, body: String(body['body']), login: `${this.slug}[bot]` };
        repo.issueComments.push(comment);
        return send(res, 201, { id: comment.id, body: comment.body, user: { login: comment.login } });
      }
    }

    if (!(m = /^\/pulls\/(\d+)(\/.*)?$/.exec(rest))) return send(res, 404, { message: 'Not Found' });
    const pull = repo.pulls.get(Number(m[1]));
    if (!pull) return send(res, 404, { message: 'Not Found' });
    const sub = m[2] ?? '';

    if (method === 'GET' && sub === '') {
      return send(res, 200, {
        number: pull.number,
        title: pull.title,
        body: pull.body,
        state: pull.state,
        merged: pull.merged,
        draft: pull.draft,
        html_url: `${repo.html_url}/pull/${pull.number}`,
        head: pull.head,
        base: pull.base,
      });
    }
    if (method === 'GET' && sub === '/files') return paginate(res, url, pull.files);
    if (method === 'POST' && sub === '/comments') {
      const error = this.validatePosition(pull, body);
      if (error) return send(res, 422, { message: 'Validation Failed', errors: [error] });
      const id = this.nextId++;
      repo.threads.push({
        id: `PRRT_${id}`,
        isResolved: false,
        comment: {
          databaseId: id,
          body: String(body['body']),
          login: this.slug,
          path: String(body['path']),
          line: Number(body['line']),
          commitId: String(body['commit_id']),
        },
      });
      return send(res, 201, { id, node_id: `PRRC_${id}`, body: body['body'] });
    }
    return send(res, 404, { message: 'Not Found' });
  }

  private graphql(res: ServerResponse, body: Record<string, unknown>, canAccess: (repo: FakeGhRepo) => boolean): void {
    const query = String(body['query'] ?? '');
    const variables = (body['variables'] ?? {}) as Record<string, unknown>;
    if (query.includes('resolveReviewThread')) {
      const thread = [...this.repos.values()]
        .filter(canAccess)
        .flatMap((r) => r.threads)
        .find((t) => t.id === variables['threadId']);
      if (!thread) return send(res, 200, { errors: [{ message: 'Could not resolve to a node' }] });
      thread.isResolved = true;
      return send(res, 200, { data: { resolveReviewThread: { thread: { id: thread.id, isResolved: true } } } });
    }
    const repo = this.repos.get(`${String(variables['owner'])}/${String(variables['name'])}`);
    if (!repo || !canAccess(repo)) return send(res, 200, { data: { repository: null } });
    const nodes = repo.threads.map((t) => ({
      id: t.id,
      isResolved: t.isResolved,
      comments: {
        nodes: [{ databaseId: t.comment.databaseId, body: t.comment.body, author: { login: t.comment.login } }],
      },
    }));
    return send(res, 200, {
      data: {
        repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } } },
      },
    });
  }

  /** GitHub accepts RIGHT-side comments only on lines present in the PR patch at the head commit. */
  private validatePosition(pull: FakeGhPull, body: Record<string, unknown>): string | null {
    if (body['commit_id'] !== pull.head.sha) return 'commit_id is not the head of the pull request';
    const file = pull.files.find((f) => f.filename === body['path']);
    if (!file?.patch) return 'path is not part of the diff';
    const line = Number(body['line']);
    let current = 0;
    for (const text of file.patch.split('\n')) {
      const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
      if (header) {
        current = Number(header[1]);
        continue;
      }
      if (text.startsWith('-')) continue;
      if (text.startsWith('+') || text.startsWith(' ')) {
        if (current === line) return null;
        current++;
      }
    }
    return 'line must be part of the diff';
  }

  private verifyJwt(token: string): boolean {
    const [header, payload, signature] = token.split('.');
    if (!header || !payload || !signature) return false;
    const ok = createVerify('RSA-SHA256')
      .update(`${header}.${payload}`)
      .verify(this.publicKey, Buffer.from(signature, 'base64url'));
    if (!ok) return false;
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString()) as {
      iss: string;
      exp: number;
      iat: number;
    };
    const now = Math.floor(Date.now() / 1000);
    return claims.iss === this.appId && claims.exp > now && claims.exp - claims.iat <= 600;
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function paginate(
  res: ServerResponse,
  url: URL,
  items: unknown[],
  wrap?: (items: unknown[], total: number) => unknown,
): void {
  const perPage = Number(url.searchParams.get('per_page') ?? 30);
  const page = Number(url.searchParams.get('page') ?? 1);
  const slice = items.slice((page - 1) * perPage, page * perPage);
  if (page * perPage < items.length) {
    const next = new URL(url);
    next.searchParams.set('page', String(page + 1));
    res.setHeader('link', `<${next.toString()}>; rel="next"`);
  }
  send(res, 200, wrap ? wrap(slice, items.length) : slice);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
