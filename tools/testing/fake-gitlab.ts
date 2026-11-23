import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { type AddressInfo } from 'node:net';

/**
 * In-memory fake of the GitLab REST API v4 subset used by the GitLab adapter. A real HTTP server on
 * 127.0.0.1, so the adapter is exercised end to end (headers, pagination, status codes) without
 * network access or a real GitLab. Behaviour mirrors GitLab where it matters for correctness:
 * token auth, `x-next-page` pagination, 404s, rejection of inline positions not in the diff.
 */
export interface FakeDiff {
  old_path: string;
  new_path: string;
  new_file?: boolean;
  renamed_file?: boolean;
  deleted_file?: boolean;
  diff: string;
  too_large?: boolean;
  collapsed?: boolean;
}

export interface FakeNote {
  id: number;
  body: string;
  author: { id: number; username: string };
  resolvable: boolean;
  resolved: boolean;
  position?: Record<string, unknown>;
}

export interface FakeDiscussion {
  id: string;
  notes: FakeNote[];
}

export interface FakeMergeRequest {
  iid: number;
  title: string;
  description: string;
  source_branch: string;
  target_branch: string;
  state: 'opened' | 'closed' | 'merged' | 'locked';
  draft: boolean;
  diff_refs: { base_sha: string; start_sha: string; head_sha: string } | null;
  diffs: FakeDiff[];
  discussions: FakeDiscussion[];
}

export interface FakeGitLabState {
  token: string;
  projectId: number;
  pathWithNamespace: string;
  defaultBranch: string;
  bot: { id: number; username: string };
  mergeRequests: Map<number, FakeMergeRequest>;
  /** key: `${sha}:${path}` */
  files: Map<string, string>;
  hooks: Array<{ id: number; url: string; token?: string; merge_requests_events: boolean }>;
  /** Respond 429 to the next N requests (rate-limit simulation). */
  rateLimitNext: number;
  requests: Array<{ method: string; path: string }>;
}

export class FakeGitLab {
  readonly state: FakeGitLabState;
  private server: Server | undefined;
  private nextId = 1000;
  baseUrl = '';

  constructor(overrides: Partial<FakeGitLabState> = {}) {
    this.state = {
      token: 'glpat-test-token',
      projectId: 42,
      pathWithNamespace: 'acme/shop',
      defaultBranch: 'main',
      bot: { id: 99, username: 'acra-bot' },
      mergeRequests: new Map(),
      files: new Map(),
      hooks: [],
      rateLimitNext: 0,
      requests: [],
      ...overrides,
    };
  }

  async start(): Promise<this> {
    this.server = createServer((req, res) => {
      this.handle(req, res).catch((error: unknown) => send(res, 500, { message: String(error) }));
    });
    await new Promise<void>((resolve) => this.server?.listen(0, '127.0.0.1', resolve));
    const { port } = this.server.address() as AddressInfo;
    this.baseUrl = `http://127.0.0.1:${port}`;
    return this;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  addMergeRequest(mr: Partial<FakeMergeRequest> & { iid: number }): FakeMergeRequest {
    const full: FakeMergeRequest = {
      title: 'Change',
      description: '',
      source_branch: 'feature',
      target_branch: 'main',
      state: 'opened',
      draft: false,
      diff_refs: { base_sha: 'a'.repeat(40), start_sha: 'a'.repeat(40), head_sha: 'b'.repeat(40) },
      diffs: [],
      discussions: [],
      ...mr,
    };
    this.state.mergeRequests.set(mr.iid, full);
    return full;
  }

  setFile(sha: string, path: string, content: string): void {
    this.state.files.set(`${sha}:${path}`, content);
  }

  /** Notes authored by the bot, across all discussions of an MR. */
  botNotes(iid: number): FakeNote[] {
    return (this.state.mergeRequests.get(iid)?.discussions ?? [])
      .flatMap((d) => d.notes)
      .filter((n) => n.author.id === this.state.bot.id);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://fake');
    const method = req.method ?? 'GET';
    this.state.requests.push({ method, path: url.pathname });

    if (this.state.rateLimitNext > 0) {
      this.state.rateLimitNext--;
      res.setHeader('retry-after', '0');
      return send(res, 429, { message: '429 Too Many Requests' });
    }
    if (req.headers['private-token'] !== this.state.token) return send(res, 401, { message: '401 Unauthorized' });

    const body = method === 'POST' || method === 'PUT' ? await readJson(req) : {};
    // Projects are addressable by id or by URL-encoded "group/project" path, as in GitLab.
    const encodedPath = `/projects/${encodeURIComponent(this.state.pathWithNamespace)}`;
    let p = url.pathname.replace(/^\/api\/v4/, '');
    if (p === encodedPath || p.startsWith(`${encodedPath}/`))
      p = `/projects/${this.state.projectId}${p.slice(encodedPath.length)}`;
    const project = `/projects/${this.state.projectId}`;
    let m: RegExpExecArray | null;

    if (method === 'GET' && p === '/user') return send(res, 200, this.state.bot);
    if (!p.startsWith(project)) return send(res, 404, { message: '404 Project Not Found' });
    const rest = p.slice(project.length);

    if (method === 'GET' && rest === '') {
      return send(res, 200, {
        id: this.state.projectId,
        path_with_namespace: this.state.pathWithNamespace,
        default_branch: this.state.defaultBranch,
        web_url: `https://gitlab.example/${this.state.pathWithNamespace}`,
      });
    }

    if ((m = /^\/repository\/files\/([^/]+)\/raw$/.exec(rest)) && method === 'GET') {
      const content = this.state.files.get(`${url.searchParams.get('ref')}:${decodeURIComponent(m[1] ?? '')}`);
      if (content === undefined) return send(res, 404, { message: '404 File Not Found' });
      res.writeHead(200, { 'content-type': 'text/plain' });
      return void res.end(content);
    }

    if ((m = /^\/hooks\/(\d+)$/.exec(rest)) && method === 'PUT') {
      const hook = this.state.hooks.find((h) => h.id === Number(m?.[1]));
      if (!hook) return send(res, 404, { message: '404 Hook Not Found' });
      hook.url = String(body['url'] ?? hook.url);
      hook.token = String(body['token'] ?? hook.token ?? '');
      return send(res, 200, { id: hook.id, url: hook.url, merge_requests_events: hook.merge_requests_events });
    }

    if (rest === '/hooks') {
      if (method === 'GET')
        return send(
          res,
          200,
          this.state.hooks.map(({ token: _t, ...hook }) => hook),
        );
      if (method === 'POST') {
        const hook = {
          id: this.nextId++,
          url: String(body['url']),
          token: String(body['token'] ?? ''),
          merge_requests_events: Boolean(body['merge_requests_events']),
        };
        this.state.hooks.push(hook);
        return send(res, 201, { id: hook.id, url: hook.url, merge_requests_events: hook.merge_requests_events });
      }
    }

    if (!(m = /^\/merge_requests\/(\d+)(\/.*)?$/.exec(rest))) return send(res, 404, { message: '404 Not Found' });
    const mr = this.state.mergeRequests.get(Number(m[1]));
    if (!mr) return send(res, 404, { message: '404 Merge Request Not Found' });
    const sub = m[2] ?? '';

    if (method === 'GET' && sub === '') {
      return send(res, 200, {
        iid: mr.iid,
        title: mr.title,
        description: mr.description,
        source_branch: mr.source_branch,
        target_branch: mr.target_branch,
        state: mr.state,
        draft: mr.draft,
        sha: mr.diff_refs?.head_sha ?? null,
        web_url: `https://gitlab.example/${this.state.pathWithNamespace}/-/merge_requests/${mr.iid}`,
        diff_refs: mr.diff_refs,
      });
    }
    if (method === 'GET' && sub === '/diffs') return paginate(res, url, mr.diffs);
    if (method === 'GET' && sub === '/discussions') {
      return paginate(
        res,
        url,
        mr.discussions.map((d) => ({ id: d.id, individual_note: false, notes: d.notes })),
      );
    }

    if (method === 'POST' && sub === '/discussions') {
      const position = body['position'] as Record<string, unknown> | undefined;
      if (position) {
        const error = this.validatePosition(mr, position);
        if (error) return send(res, 400, { message: error });
      }
      const discussion: FakeDiscussion = {
        id: `d${this.nextId++}`,
        notes: [
          {
            id: this.nextId++,
            body: String(body['body']),
            author: this.state.bot,
            resolvable: true,
            resolved: false,
            ...(position ? { position } : {}),
          },
        ],
      };
      mr.discussions.push(discussion);
      return send(res, 201, { id: discussion.id, notes: discussion.notes });
    }

    if ((m = /^\/discussions\/([^/]+)$/.exec(sub)) && method === 'PUT') {
      const discussion = mr.discussions.find((d) => d.id === m?.[1]);
      if (!discussion) return send(res, 404, { message: '404 Discussion Not Found' });
      const resolved = url.searchParams.get('resolved') ?? String(body['resolved']);
      for (const note of discussion.notes) if (note.resolvable) note.resolved = resolved === 'true';
      return send(res, 200, { id: discussion.id, notes: discussion.notes });
    }

    if (method === 'POST' && sub === '/notes') {
      const note: FakeNote = {
        id: this.nextId++,
        body: String(body['body']),
        author: this.state.bot,
        resolvable: false,
        resolved: false,
      };
      mr.discussions.push({ id: `d${this.nextId++}`, notes: [note] });
      return send(res, 201, note);
    }

    if ((m = /^\/notes\/(\d+)$/.exec(sub)) && method === 'PUT') {
      const note = mr.discussions.flatMap((d) => d.notes).find((n) => n.id === Number(m?.[1]));
      if (!note) return send(res, 404, { message: '404 Note Not Found' });
      note.body = String(body['body']);
      return send(res, 200, note);
    }

    return send(res, 404, { message: '404 Not Found' });
  }

  /** GitLab only accepts positions on lines present in the MR diff for the given SHAs. */
  private validatePosition(mr: FakeMergeRequest, position: Record<string, unknown>): string | null {
    if (position['head_sha'] !== mr.diff_refs?.head_sha) return 'position is outdated (head_sha mismatch)';
    const diff = mr.diffs.find((d) => d.new_path === position['new_path']);
    if (!diff) return 'line_code can not be blank (unknown file)';
    const newLine = Number(position['new_line']);
    let current = 0;
    let oldCurrent = 0;
    for (const line of diff.diff.split('\n')) {
      const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (header) {
        oldCurrent = Number(header[1]);
        current = Number(header[2]);
        continue;
      }
      if (line.startsWith('+')) {
        if (current === newLine)
          return position['old_line'] === undefined ? null : 'old_line must be empty for added lines';
        current++;
      } else if (line.startsWith('-')) {
        oldCurrent++;
      } else if (line.startsWith(' ')) {
        if (current === newLine)
          return position['old_line'] === oldCurrent ? null : 'old_line required for unchanged lines';
        current++;
        oldCurrent++;
      }
    }
    return 'line_code can not be blank (line not in diff)';
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function paginate(res: ServerResponse, url: URL, items: unknown[]): void {
  const perPage = Number(url.searchParams.get('per_page') ?? 20);
  const page = Number(url.searchParams.get('page') ?? 1);
  const slice = items.slice((page - 1) * perPage, page * perPage);
  res.setHeader('x-next-page', page * perPage < items.length ? String(page + 1) : '');
  send(res, 200, slice);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return {};
  }
}
