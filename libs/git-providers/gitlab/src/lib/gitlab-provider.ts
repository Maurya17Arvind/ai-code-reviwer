import {
  type ChangedFile,
  type ChangeSet,
  type ExistingComment,
  type FileChangeStatus,
  type FileContent,
  type FileContentReader,
  GitProviderError,
  InlinePositionRejectedError,
  type InlineCommentInput,
  type RepositoryWriter,
  type ReviewPublisher,
  type ReviewRequest,
  type ReviewRequestSource,
  type Revision,
} from '@acra/git-providers-core';
import { parseHunks } from '@acra/repository-context';
import { normalizeRepoRelativePath } from '@acra/security';
import { GitLabApiError, type GitLabClient } from './gitlab-client';

interface GlMergeRequest {
  iid: number;
  title: string;
  description: string | null;
  source_branch: string;
  target_branch: string;
  state: string;
  draft?: boolean;
  work_in_progress?: boolean;
  web_url: string;
  diff_refs: { base_sha: string; start_sha: string; head_sha: string } | null;
}

interface GlDiff {
  old_path: string;
  new_path: string;
  new_file?: boolean;
  renamed_file?: boolean;
  deleted_file?: boolean;
  diff: string;
  too_large?: boolean;
  collapsed?: boolean;
}

interface GlNote {
  id: number;
  body: string;
  author: { id: number };
  resolvable?: boolean;
  resolved?: boolean;
  system?: boolean;
}

export interface GitLabProject {
  readonly id: number;
  readonly pathWithNamespace: string;
  readonly defaultBranch: string;
  readonly webUrl: string;
}

const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

export { InlinePositionRejectedError };

/**
 * GitLab adapter: ReviewRequestSource + ReviewPublisher + FileContentReader for one project.
 * All provider data (paths, descriptions, diffs) is treated as untrusted input.
 */
export class GitLabProvider implements ReviewRequestSource, ReviewPublisher, FileContentReader, RepositoryWriter {
  private botUserId: Promise<number> | undefined;

  constructor(
    private readonly client: GitLabClient,
    readonly projectId: number,
    private readonly options: { readonly maxFileBytes?: number } = {},
  ) {}

  private get project(): string {
    return `/projects/${this.projectId}`;
  }

  async getProject(): Promise<GitLabProject> {
    const project = await this.client.get<{
      id: number;
      path_with_namespace: string;
      default_branch: string;
      web_url: string;
    }>(this.project);
    return {
      id: project.id,
      pathWithNamespace: project.path_with_namespace,
      defaultBranch: project.default_branch,
      webUrl: project.web_url,
    };
  }

  async getReviewRequest(iid: number): Promise<ReviewRequest> {
    const mr = await this.client
      .get<GlMergeRequest>(`${this.project}/merge_requests/${iid}`)
      .catch((error: unknown) => {
        if (error instanceof GitLabApiError && error.status === 404)
          throw new GitProviderError(`Merge request !${iid} not found`, 'UNKNOWN_REF');
        throw error;
      });
    const refs = mr.diff_refs;
    if (!refs || !SHA.test(refs.head_sha) || !SHA.test(refs.base_sha) || !SHA.test(refs.start_sha)) {
      // GitLab computes diff_refs asynchronously right after MR creation / push.
      throw new GitProviderError(`Merge request !${iid} diff is not ready yet`, 'GIT_FAILED');
    }
    return {
      id: mr.iid,
      title: mr.title,
      description: mr.description ?? '',
      sourceBranch: mr.source_branch,
      targetBranch: mr.target_branch,
      state: (['opened', 'closed', 'merged', 'locked'] as const).find((s) => s === mr.state) ?? 'closed',
      draft: Boolean(mr.draft ?? mr.work_in_progress),
      webUrl: mr.web_url,
      refs: { baseSha: refs.base_sha, startSha: refs.start_sha, headSha: refs.head_sha },
    };
  }

  async getReviewRequestChanges(request: ReviewRequest): Promise<ChangeSet> {
    const diffs = await this.client.paginate<GlDiff>(`${this.project}/merge_requests/${request.id}/diffs`);
    const files: ChangedFile[] = [];
    for (const diff of diffs) {
      const file = toChangedFile(diff);
      if (file) files.push(file);
    }
    return {
      scope: { kind: 'merge_request', provider: 'gitlab', id: request.id },
      base: { kind: 'commit', sha: request.refs.baseSha },
      head: { kind: 'commit', sha: request.refs.headSha },
      files,
    };
  }

  async readFile(path: string, revision: Revision): Promise<FileContent | null> {
    if (revision.kind !== 'commit' || !SHA.test(revision.sha)) {
      throw new GitProviderError('GitLab files can only be read at a commit SHA', 'UNSAFE_REF');
    }
    const normalized = normalizeRepoRelativePath(path);
    const maxBytes = this.options.maxFileBytes ?? 1_000_000;
    const result = await this.client.raw(
      `${this.project}/repository/files/${encodeURIComponent(normalized)}/raw`,
      { ref: revision.sha },
      maxBytes,
    );
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

  async listComments(requestId: number): Promise<ExistingComment[]> {
    const botId = await this.getBotUserId();
    const discussions = await this.client.paginate<{ id: string; notes: GlNote[] }>(
      `${this.project}/merge_requests/${requestId}/discussions`,
    );
    return discussions.flatMap((discussion) =>
      discussion.notes
        .filter((note) => !note.system)
        .map((note) => ({
          discussionId: discussion.id,
          noteId: String(note.id),
          body: note.body,
          resolvable: Boolean(note.resolvable),
          resolved: Boolean(note.resolved),
          authoredByUs: note.author.id === botId,
        })),
    );
  }

  async publishInlineComment(input: InlineCommentInput): Promise<{ discussionId: string; noteId: string }> {
    try {
      const discussion = await this.client.post<{ id: string; notes: GlNote[] }>(
        `${this.project}/merge_requests/${input.requestId}/discussions`,
        {
          body: input.body,
          position: {
            position_type: 'text',
            base_sha: input.refs.baseSha,
            start_sha: input.refs.startSha,
            head_sha: input.refs.headSha,
            new_path: input.path,
            old_path: input.oldPath,
            new_line: input.newLine,
            ...(input.oldLine === undefined ? {} : { old_line: input.oldLine }),
          },
        },
      );
      return { discussionId: discussion.id, noteId: String(discussion.notes[0]?.id ?? '') };
    } catch (error) {
      if (error instanceof GitLabApiError && error.status === 400) throw new InlinePositionRejectedError(error.message);
      throw error;
    }
  }

  async upsertSummary(requestId: number, body: string, existingNoteId?: string): Promise<{ noteId: string }> {
    const base = `${this.project}/merge_requests/${requestId}/notes`;
    if (existingNoteId) {
      try {
        const note = await this.client.put<GlNote>(`${base}/${encodeURIComponent(existingNoteId)}`, { body });
        return { noteId: String(note.id) };
      } catch (error) {
        if (!(error instanceof GitLabApiError && error.status === 404)) throw error;
      }
    }
    const note = await this.client.post<GlNote>(base, { body });
    return { noteId: String(note.id) };
  }

  async resolveDiscussion(requestId: number, discussionId: string): Promise<void> {
    await this.client.put(
      `${this.project}/merge_requests/${requestId}/discussions/${encodeURIComponent(discussionId)}`,
      {},
      { resolved: 'true' },
    );
  }

  /** Registers (or reuses) a project hook for merge request events. Returns the hook id. */
  async ensureWebhook(url: string, token: string): Promise<number> {
    const hooks = await this.client.paginate<{ id: number; url: string }>(`${this.project}/hooks`);
    const existing = hooks.find((hook) => hook.url === url);
    if (existing) {
      // Re-set the token so it matches the stored hash.
      await this.client.put(`${this.project}/hooks/${existing.id}`, hookBody(url, token));
      return existing.id;
    }
    const hook = await this.client.post<{ id: number }>(`${this.project}/hooks`, hookBody(url, token));
    return hook.id;
  }

  // ---- Approval-gated writes (Phase 6) ----

  async commitFileToNewBranch(input: {
    branch: string;
    baseSha: string;
    path: string;
    content: string;
    message: string;
  }): Promise<{ commitSha: string }> {
    assertFixBranch(input.branch);
    if (!SHA.test(input.baseSha)) throw new GitProviderError('Base must be a full commit id', 'UNSAFE_REF');
    if ((await this.branchHead(input.branch)) !== null) {
      throw new GitProviderError(`Branch ${input.branch} already exists`, 'GIT_FAILED');
    }
    // start_sha creates the branch from exactly the reviewed commit; GitLab refuses an existing branch.
    const commit = await this.client.post<{ id: string }>(`${this.project}/repository/commits`, {
      branch: input.branch,
      start_sha: input.baseSha,
      commit_message: input.message,
      actions: [{ action: 'update', file_path: normalizeRepoRelativePath(input.path), content: input.content }],
    });
    if (!SHA.test(commit.id)) throw new GitProviderError('GitLab returned an invalid commit id', 'GIT_FAILED');
    return { commitSha: commit.id };
  }

  async createReviewRequest(input: {
    sourceBranch: string;
    targetBranch: string;
    title: string;
    description: string;
  }): Promise<{ id: number; webUrl: string }> {
    assertFixBranch(input.sourceBranch);
    const mr = await this.client.post<{ iid: number; web_url: string }>(`${this.project}/merge_requests`, {
      source_branch: input.sourceBranch,
      target_branch: input.targetBranch,
      title: input.title,
      description: input.description,
      remove_source_branch: false,
      squash: false,
    });
    return { id: mr.iid, webUrl: mr.web_url };
  }

  async branchHead(branch: string): Promise<string | null> {
    try {
      const result = await this.client.get<{ commit: { id: string } }>(
        `${this.project}/repository/branches/${encodeURIComponent(branch)}`,
      );
      return result.commit.id;
    } catch (error) {
      if (error instanceof GitLabApiError && error.status === 404) return null;
      throw error;
    }
  }

  private getBotUserId(): Promise<number> {
    this.botUserId ??= this.client.get<{ id: number }>('/user').then((user) => user.id);
    return this.botUserId;
  }
}

function assertFixBranch(branch: string): void {
  if (!/^ai-review\/fix-[0-9a-f]{8,40}$/.test(branch)) {
    throw new GitProviderError('Only ai-review/fix-* branches can be written', 'UNSAFE_REF');
  }
}

function hookBody(url: string, token: string) {
  return {
    url,
    token,
    merge_requests_events: true,
    push_events: false,
    note_events: false,
    issues_events: false,
    enable_ssl_verification: true,
  };
}

/** Maps one GitLab diff entry to the provider-neutral model. Unsafe paths are dropped. */
export function toChangedFile(diff: GlDiff): ChangedFile | null {
  let path: string;
  let oldPath: string;
  try {
    path = normalizeRepoRelativePath(diff.new_path);
    oldPath = normalizeRepoRelativePath(diff.old_path);
  } catch {
    return null;
  }
  const status: FileChangeStatus = diff.new_file
    ? 'added'
    : diff.deleted_file
      ? 'deleted'
      : diff.renamed_file
        ? 'renamed'
        : 'modified';
  const text = diff.diff ?? '';
  const isBinary = /^Binary files /m.test(text);
  const diffUnavailable = Boolean(diff.too_large || diff.collapsed) && text.trim() === '';
  const hunks = isBinary ? [] : parseHunks(text);
  let additions = 0;
  let deletions = 0;
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.kind === 'add') additions++;
      else if (line.kind === 'del') deletions++;
    }
  }
  return {
    path: status === 'deleted' ? oldPath : path,
    ...(status === 'renamed' ? { oldPath } : {}),
    status,
    isBinary,
    additions,
    deletions,
    hunks,
    ...(diffUnavailable ? { diffUnavailable: true } : {}),
  };
}
