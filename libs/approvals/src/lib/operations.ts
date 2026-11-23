/**
 * Operations that change code or Git state. Each needs its own human approval (Module H). There is
 * deliberately no merge operation: merging is not implemented anywhere in the platform, and any
 * attempt to name one is rejected (`assertKnownOperation`).
 */
export const OPERATION_KINDS = [
  'apply_fix',
  'stage_changes',
  'commit_changes',
  'push_branch',
  'create_merge_request',
  'create_pull_request',
  /** Hosted repositories have no working tree: apply + stage + commit + push are one remote write. */
  'commit_and_push_fix',
] as const;
export type OperationKind = (typeof OPERATION_KINDS)[number];

/** A validation command as argv (never a shell string). */
export type CommandArgv = readonly string[];

export type ApprovalOperation =
  | {
      readonly kind: 'apply_fix';
      readonly fixId: string;
      readonly filePath: string;
      readonly branch: string;
      /** Commands run after applying, exactly as approved. */
      readonly validationCommands: readonly CommandArgv[];
    }
  | {
      readonly kind: 'stage_changes';
      readonly fixId: string;
      readonly branch: string;
      readonly paths: readonly string[];
    }
  | {
      readonly kind: 'commit_changes';
      readonly fixId: string;
      readonly branch: string;
      readonly message: string;
      /** The commit the new commit will have as parent. */
      readonly parentSha: string;
    }
  | {
      readonly kind: 'push_branch';
      readonly fixId: string;
      readonly branch: string;
      readonly remote: string;
      /** Exactly this commit is pushed (no other commits, no force). */
      readonly commitSha: string;
    }
  | {
      readonly kind: 'commit_and_push_fix';
      readonly fixId: string;
      readonly filePath: string;
      readonly branch: string;
      readonly message: string;
    }
  | {
      readonly kind: 'create_merge_request' | 'create_pull_request';
      readonly fixId: string;
      readonly sourceBranch: string;
      readonly targetBranch: string;
      readonly title: string;
      /** The commit the MR/PR must point at; refused if the branch moved. */
      readonly commitSha: string;
    };

const BRANCH = /^ai-review\/fix-[0-9a-f]{8,40}$/;

export class OperationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OperationError';
  }
}

export function assertKnownOperation(kind: string): asserts kind is OperationKind {
  if (/merge$/i.test(kind) && !kind.endsWith('merge_request')) {
    throw new OperationError('Merging is disabled: the platform never merges merge requests or pull requests');
  }
  if (!(OPERATION_KINDS as readonly string[]).includes(kind)) throw new OperationError(`Unknown operation "${kind}"`);
}

/** Branch names for fixes are generated, never taken from model output or repository content. */
export function fixBranchName(fixId: string): string {
  const branch = `ai-review/fix-${fixId.replace(/-/g, '').slice(0, 12).toLowerCase()}`;
  if (!BRANCH.test(branch)) throw new OperationError('Invalid fix id for a branch name');
  return branch;
}

/** Structural validation; the operation is built by platform code but re-checked before it is bound. */
export function validateOperation(operation: ApprovalOperation): void {
  assertKnownOperation(operation.kind);
  const branch = 'branch' in operation ? operation.branch : operation.sourceBranch;
  if (!BRANCH.test(branch)) throw new OperationError(`Branch "${branch.slice(0, 80)}" is not a fix branch`);
  const sha = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
  switch (operation.kind) {
    case 'commit_changes':
      if (!sha.test(operation.parentSha)) throw new OperationError('Invalid parent commit');
      if (operation.message.trim() === '' || operation.message.length > 5_000)
        throw new OperationError('Commit message must be 1–5000 characters');
      break;
    case 'commit_and_push_fix':
      if (operation.message.trim() === '' || operation.message.length > 5_000)
        throw new OperationError('Commit message must be 1–5000 characters');
      break;
    case 'push_branch':
      if (!sha.test(operation.commitSha)) throw new OperationError('Invalid commit');
      if (!/^[A-Za-z0-9._-]{1,100}$/.test(operation.remote)) throw new OperationError('Invalid remote name');
      break;
    case 'create_merge_request':
    case 'create_pull_request':
      if (!sha.test(operation.commitSha)) throw new OperationError('Invalid commit');
      if (operation.title.trim() === '' || operation.title.length > 250)
        throw new OperationError('Title must be 1–250 characters');
      if (!/^[A-Za-z0-9._/-]{1,255}$/.test(operation.targetBranch) || operation.targetBranch.includes('..'))
        throw new OperationError('Invalid target branch');
      break;
    case 'apply_fix':
      if (operation.validationCommands.length > 10) throw new OperationError('At most 10 validation commands');
      break;
    case 'stage_changes':
      if (operation.paths.length === 0 || operation.paths.length > 50) throw new OperationError('Stage 1–50 paths');
      break;
  }
}

/** Which earlier operation (same fix) must have been executed first. */
export function prerequisiteOf(kind: OperationKind): OperationKind | null {
  switch (kind) {
    case 'stage_changes':
      return 'apply_fix';
    case 'commit_changes':
      return 'stage_changes';
    case 'push_branch':
      return 'commit_changes';
    case 'create_merge_request':
    case 'create_pull_request':
      return null; // local: push_branch; hosted: commit_and_push_fix — checked by the caller
    default:
      return null;
  }
}

/** Human-readable, deterministic description shown before approval. */
export function describeOperation(operation: ApprovalOperation): string[] {
  switch (operation.kind) {
    case 'apply_fix':
      return [
        `Apply fix ${operation.fixId.slice(0, 8)} to ${operation.filePath} in an isolated worktree on new branch ${operation.branch}`,
        operation.validationCommands.length > 0
          ? `Then run: ${operation.validationCommands.map((c) => c.join(' ')).join(' ; ')}`
          : 'No validation commands will be run',
      ];
    case 'stage_changes':
      return [`Stage ${operation.paths.join(', ')} on branch ${operation.branch}`];
    case 'commit_changes':
      return [
        `Commit staged changes on ${operation.branch} (parent ${operation.parentSha.slice(0, 12)})`,
        `Message: ${operation.message}`,
      ];
    case 'push_branch':
      return [
        `Push ${operation.branch} at ${operation.commitSha.slice(0, 12)} to remote "${operation.remote}" (no force)`,
      ];
    case 'commit_and_push_fix':
      return [
        `Create branch ${operation.branch} from the reviewed commit and commit fix ${operation.fixId.slice(0, 8)} to ${operation.filePath}`,
        `(apply + stage + commit + push as one remote write; no force)`,
        `Message: ${operation.message}`,
      ];
    case 'create_merge_request':
    case 'create_pull_request':
      return [
        `Open a ${operation.kind === 'create_merge_request' ? 'merge request' : 'pull request'} ${operation.sourceBranch} → ${operation.targetBranch} at ${operation.commitSha.slice(0, 12)}`,
        `Title: ${operation.title}`,
        'It will NOT be merged — merging stays a human action in GitLab/GitHub.',
      ];
  }
}
