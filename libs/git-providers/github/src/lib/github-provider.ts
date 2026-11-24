import {
  type ChangedFile,
  type ChangeSet,
  type ExistingComment,
  type FileChangeStatus,
  type FileContent,
  GitProviderError,
  type HostedGitProvider,
  type InlineCommentInput,
  InlinePositionRejectedError,
  type RepositoryWriter,
  type ReviewRequest,
  type Revision,
} from '@acra/git-providers-core';
import { parseHunks } from '@acra/repository-context';
import { normalizeRepoRelativePath } from '@acra/security';
import { GitHubApiError, type GitHubClient } from './github-client';

interface GhPull {
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  merged?: boolean;
  draft?: boolean;
  html_url: string;
  head: { sha: string; ref: string };
  base: { sha: string; ref: string };
}

interface GhFile {
  filename: string;
  previous_filename?: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
}

interface GhComment {
  id: number;
  body: string;
  user: { login: string } | null;
}

interface ReviewThreadsPage {
  repository: {
    pullRequest: {
      reviewThreads: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: Array<{
          id: string;
          isResolved: boolean;
          comments: { nodes: Array<{ databaseId: number; body: string; author: { login: string } | null }> };
        }>;
      };
    } | null;
  } | null;
}

const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

const THREADS_QUERY = `query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes { id isResolved comments(first: 1) { nodes { databaseId body author { login } } } }
      }
    }
  }
}`;

const RESOLVE_MUTATION = `mutation($threadId: ID!) { resolveReviewThread(input: { threadId: $threadId }) { thread { id isResolved } } }`;

/**
 * GitHub adapter for one repository (installation-scoped client). PR review comments carry
 * positions (`line` + `side`); the summary is a single issue comment updated in place; review threads
 * are resolved through GraphQL (REST cannot resolve threads).
 */
export class GitHubProvider implements HostedGitProvider, RepositoryWriter {
  private readonly owner: string;
  private readonly name: string;

  constructor(
    private readonly client: GitHubClient,
    fullName: string,
    private readonly options: {
      readonly botLogin: string;
      readonly maxFileBytes?: number;
      /**
       * Client used only to resolve review threads. GitHub requires a contents:write token for
       * `resolveReviewThread`, so review jobs pass a separate, lazily-minted write-scoped client here
       * instead of widening the token used for everything else (ADR-029).
       */
      readonly threadClient?: GitHubClient;
    },
  ) {
    const [owner, name, ...rest] = fullName.split('/');
    if (!owner || !name || rest.length > 0 || !/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(name)) {
      throw new GitProviderError(`Invalid GitHub repository name "${fullName.slice(0, 100)}"`, 'UNSAFE_REF');
    }
    this.owner = owner;
    this.name = name;
  }

  private get repo(): string {
    return `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.name)}`;
  }

  async getReviewRequest(number: number): Promise<ReviewRequest> {
    const pr = await this.client.get<GhPull>(`${this.repo}/pulls/${number}`).catch((error: unknown) => {
      if (error instanceof GitHubApiError && error.status === 404)
        throw new GitProviderError(`Pull request #${number} not found`, 'UNKNOWN_REF');
      throw error;
    });
    if (!SHA.test(pr.head.sha) || !SHA.test(pr.base.sha))
      throw new GitProviderError('Pull request has invalid commit ids', 'GIT_FAILED');
    // The PR diff is three-dot (merge-base...head); the merge-base is needed to read deleted files.
    const compare = await this.client.get<{ merge_base_commit: { sha: string } }>(
      `${this.repo}/compare/${pr.base.sha}...${pr.head.sha}`,
      { per_page: 1 },
    );
    const mergeBase = compare.merge_base_commit.sha;
    if (!SHA.test(mergeBase)) throw new GitProviderError('Could not determine the merge base', 'GIT_FAILED');
    return {
      id: pr.number,
      title: pr.title,
      description: pr.body ?? '',
      sourceBranch: pr.head.ref,
      targetBranch: pr.base.ref,
      state: pr.state === 'open' ? 'opened' : pr.merged ? 'merged' : 'closed',
      draft: Boolean(pr.draft),
      webUrl: pr.html_url,
      refs: { baseSha: mergeBase, startSha: pr.base.sha, headSha: pr.head.sha },
    };
  }

  async getReviewRequestChanges(request: ReviewRequest): Promise<ChangeSet> {
    const files = await this.client.paginate<GhFile>(`${this.repo}/pulls/${request.id}/files`);
    return {
      scope: { kind: 'merge_request', provider: 'github', id: request.id },
      base: { kind: 'commit', sha: request.refs.baseSha },
      head: { kind: 'commit', sha: request.refs.headSha },
      files: files.map(toChangedFile).filter((file): file is ChangedFile => file !== null),
    };
  }

  async readFile(path: string, revision: Revision): Promise<FileContent | null> {
    if (revision.kind !== 'commit' || !SHA.test(revision.sha)) {
      throw new GitProviderError('GitHub files can only be read at a commit SHA', 'UNSAFE_REF');
    }
    const normalized = normalizeRepoRelativePath(path);
    const maxBytes = this.options.maxFileBytes ?? 1_000_000;
    const encoded = normalized.split('/').map(encodeURIComponent).join('/');
    const result = await this.client.raw(`${this.repo}/contents/${encoded}`, { ref: revision.sha }, maxBytes);
    if (!result) return null;
    if (result.tooLarge)
      return { path: normalized, revision, sizeBytes: maxBytes + 1, isBinary: false, content: '', tooLarge: true };
    const isBinary = result.data.subarray(0, 8_000).includes(0);
    return {
      path: normalized,
      revision,
      sizeBytes: result.data.length,
      isBinary,
      content: isBinary ? '' : result.data.toString('utf8'),
      tooLarge: false,
    };
  }

  async listComments(number: number): Promise<ExistingComment[]> {
    const isBot = (login: string | undefined) => !!login && stripBot(login) === stripBot(this.options.botLogin);
    const comments: ExistingComment[] = [];

    let cursor: string | null = null;
    for (let page = 0; page < 20; page++) {
      const data: ReviewThreadsPage = await this.client.graphql<ReviewThreadsPage>(THREADS_QUERY, {
        owner: this.owner,
        name: this.name,
        number,
        cursor,
      });
      const threads = data.repository?.pullRequest?.reviewThreads;
      if (!threads) break;
      for (const thread of threads.nodes) {
        const first = thread.comments.nodes[0];
        if (!first) continue;
        comments.push({
          discussionId: thread.id,
          noteId: String(first.databaseId),
          body: first.body,
          resolvable: true,
          resolved: thread.isResolved,
          authoredByUs: isBot(first.author?.login),
        });
      }
      if (!threads.pageInfo.hasNextPage) break;
      cursor = threads.pageInfo.endCursor;
    }

    const issueComments = await this.client.paginate<GhComment>(`${this.repo}/issues/${number}/comments`);
    for (const comment of issueComments) {
      comments.push({
        discussionId: `issue-comment-${comment.id}`,
        noteId: String(comment.id),
        body: comment.body,
        resolvable: false,
        resolved: false,
        authoredByUs: isBot(comment.user?.login),
      });
    }
    return comments;
  }

  async publishInlineComment(input: InlineCommentInput): Promise<{ discussionId: string; noteId: string }> {
    try {
      const comment = await this.client.post<{ id: number }>(`${this.repo}/pulls/${input.requestId}/comments`, {
        body: input.body,
        commit_id: input.refs.headSha,
        path: input.path,
        line: input.newLine,
        side: 'RIGHT',
      });
      return { discussionId: `review-comment-${comment.id}`, noteId: String(comment.id) };
    } catch (error) {
      // 422: line is not part of the diff (or the commit is outdated).
      if (error instanceof GitHubApiError && error.status === 422) throw new InlinePositionRejectedError(error.message);
      throw error;
    }
  }

  async upsertSummary(number: number, body: string, existingNoteId?: string): Promise<{ noteId: string }> {
    if (existingNoteId && /^\d+$/.test(existingNoteId)) {
      try {
        const updated = await this.client.patch<{ id: number }>(`${this.repo}/issues/comments/${existingNoteId}`, {
          body,
        });
        return { noteId: String(updated.id) };
      } catch (error) {
        if (!(error instanceof GitHubApiError && error.status === 404)) throw error;
      }
    }
    const created = await this.client.post<{ id: number }>(`${this.repo}/issues/${number}/comments`, { body });
    return { noteId: String(created.id) };
  }

  // ---- Approval-gated writes (Phase 6). Need a token with contents:write. ----

  async commitFileToNewBranch(input: {
    branch: string;
    baseSha: string;
    path: string;
    content: string;
    message: string;
  }): Promise<{ commitSha: string }> {
    assertFixBranch(input.branch);
    if (!SHA.test(input.baseSha)) throw new GitProviderError('Base must be a full commit id', 'UNSAFE_REF');
    const path = normalizeRepoRelativePath(input.path);
    const encoded = path.split('/').map(encodeURIComponent).join('/');
    const existing = await this.client.get<{ sha: string; type: string }>(`${this.repo}/contents/${encoded}`, {
      ref: input.baseSha,
    });
    if (existing.type !== 'file') throw new GitProviderError(`${path} is not a file`, 'UNSAFE_PATH');

    // Creating the ref fails with 422 when the branch exists: an existing branch is never moved.
    await this.client.post(`${this.repo}/git/refs`, { ref: `refs/heads/${input.branch}`, sha: input.baseSha });
    try {
      const result = await this.client.put<{ commit: { sha: string } }>(`${this.repo}/contents/${encoded}`, {
        message: input.message,
        content: Buffer.from(input.content, 'utf8').toString('base64'),
        sha: existing.sha,
        branch: input.branch,
      });
      if (!SHA.test(result.commit.sha))
        throw new GitProviderError('GitHub returned an invalid commit id', 'GIT_FAILED');
      return { commitSha: result.commit.sha };
    } catch (error) {
      // Remove only the branch this call just created, so a retry can start clean.
      await this.client.delete(`${this.repo}/git/refs/heads/${input.branch}`).catch(() => undefined);
      throw error;
    }
  }

  async createReviewRequest(input: {
    sourceBranch: string;
    targetBranch: string;
    title: string;
    description: string;
  }): Promise<{ id: number; webUrl: string }> {
    assertFixBranch(input.sourceBranch);
    const pr = await this.client.post<{ number: number; html_url: string }>(`${this.repo}/pulls`, {
      title: input.title,
      head: input.sourceBranch,
      base: input.targetBranch,
      body: input.description,
      maintainer_can_modify: false,
    });
    return { id: pr.number, webUrl: pr.html_url };
  }

  async branchHead(branch: string): Promise<string | null> {
    try {
      const ref = await this.client.get<{ object: { sha: string } }>(
        `${this.repo}/git/ref/heads/${branch.split('/').map(encodeURIComponent).join('/')}`,
      );
      return ref.object.sha;
    } catch (error) {
      if (error instanceof GitHubApiError && error.status === 404) return null;
      throw error;
    }
  }

  async resolveDiscussion(_number: number, threadId: string): Promise<void> {
    if (!threadId.startsWith('PRRT_')) return; // only GraphQL review-thread ids can be resolved
    await (this.options.threadClient ?? this.client).graphql(RESOLVE_MUTATION, { threadId });
  }
}

function assertFixBranch(branch: string): void {
  if (!/^ai-review\/fix-[0-9a-f]{8,40}$/.test(branch)) {
    throw new GitProviderError('Only ai-review/fix-* branches can be written', 'UNSAFE_REF');
  }
}

function stripBot(login: string): string {
  return login.replace(/\[bot\]$/, '').toLowerCase();
}

const STATUS: Record<string, FileChangeStatus> = {
  added: 'added',
  removed: 'deleted',
  modified: 'modified',
  changed: 'modified',
  renamed: 'renamed',
  copied: 'copied',
};

/** Maps a GitHub PR file entry to the shared diff model. Unsafe paths are dropped. */
export function toChangedFile(file: GhFile): ChangedFile | null {
  const status = STATUS[file.status];
  if (!status) return null; // "unchanged"
  let path: string;
  let oldPath: string | undefined;
  try {
    path = normalizeRepoRelativePath(file.filename);
    oldPath = file.previous_filename ? normalizeRepoRelativePath(file.previous_filename) : undefined;
  } catch {
    return null;
  }
  const hunks = file.patch ? parseHunks(file.patch) : [];
  const changes = file.additions + file.deletions;
  // GitHub omits `patch` for binary files and for diffs that are too large.
  const isBinary = !file.patch && changes === 0 && status !== 'renamed' && status !== 'copied';
  const diffUnavailable = !file.patch && changes > 0;
  return {
    path,
    ...(oldPath && (status === 'renamed' || status === 'copied') ? { oldPath } : {}),
    status,
    isBinary,
    additions: file.additions,
    deletions: file.deletions,
    hunks,
    ...(diffUnavailable ? { diffUnavailable: true } : {}),
  };
}
