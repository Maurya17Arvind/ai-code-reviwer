import { AiProviderError, type AiProviderName, type AiReviewer, type TokenUsage } from '@acra/ai-providers-core';
import { redactSecrets } from '@acra/review-engine';
import { sha256Hex } from '@acra/repository-context';
import { normalizeRepoRelativePath, UnsafePathError } from '@acra/security';
import { randomUUID } from 'node:crypto';
import { buildFixPrompt, fixWindow, type FixTarget } from './fix-prompt';
import { isProtectedPath } from './protected-paths';
import { applyChanges, joinLines, type LineChange, splitLines } from './text-lines';
import { createUnifiedDiff } from './unified-diff';
import { FIX_LIMITS, FixRejection, validateFixOutput } from './validate-fix';

/** A validated, not-yet-applied fix. Everything an approval binds to is derived deterministically. */
export interface FixProposal {
  readonly id: string;
  readonly findingId: string;
  readonly fingerprint: string;
  readonly filePath: string;
  /** Commit whose file content the fix was computed against (the reviewed head). */
  readonly baseSha: string;
  /** Model-written explanation. Untrusted text — render escaped, never execute. */
  readonly explanation: string;
  /** Minimal line changes (old-file numbering). The patch and result are recomputed from these. */
  readonly changes: readonly LineChange[];
  /** git-compatible unified diff. */
  readonly patch: string;
  readonly patchSha256: string;
  /** SHA-256 of the file before / after the fix — checked again right before anything is written. */
  readonly originalSha256: string;
  readonly resultSha256: string;
  readonly additions: number;
  readonly deletions: number;
  readonly provider: AiProviderName;
  readonly model: string;
  readonly servedByModel: string;
  readonly usage: TokenUsage;
  readonly costUsd: number | null;
  readonly latencyMs: number;
  readonly createdAt: string;
}

export type FixResult =
  | { readonly status: 'proposed'; readonly proposal: FixProposal }
  | { readonly status: 'rejected'; readonly code: FixRejection['code']; readonly reason: string };

export interface GenerateFixInput {
  readonly reviewer: AiReviewer;
  readonly target: FixTarget;
  /** File content at `baseSha` (text). */
  readonly content: string;
  readonly baseSha: string;
  readonly signal: AbortSignal;
  readonly now?: () => Date;
}

/**
 * Asks one model for a fix and turns its answer into a deterministic patch. Never throws for
 * expected failures (protected file, declined, invalid output, provider error): those come back as
 * `rejected` with a reason that is safe to show.
 */
export async function generateFix(input: GenerateFixInput): Promise<FixResult> {
  try {
    const path = normalizeRepoRelativePath(input.target.filePath);
    if (isProtectedPath(path)) {
      throw new FixRejection('protected_path', `${path} is a protected file; fixes there must be made by hand`);
    }
    if (input.content.length > FIX_LIMITS.maxFileBytes || input.content.includes('\0')) {
      throw new FixRejection('unsupported_file', 'File is binary or too large for an automatic fix');
    }
    const original = splitLines(input.content);

    // Secrets never leave the machine: redact, and refuse when redaction would shift line numbers.
    const redacted = redactSecrets(input.content);
    const shownLines = redacted.redactions > 0 ? splitLines(redacted.text).lines : original.lines;
    if (shownLines.length !== original.lines.length) {
      throw new FixRejection('multiline_secret', 'File contains multi-line secret material; fix it by hand');
    }
    const redactedLines = new Set<number>();
    shownLines.forEach((line, index) => {
      if (line !== original.lines[index]) redactedLines.add(index + 1);
    });

    const window = fixWindow(original.lines.length, input.target);
    const prompt = buildFixPrompt({ ...input.target, filePath: path }, shownLines, window);
    let result;
    try {
      result = await input.reviewer.review(prompt, input.signal);
    } catch (error) {
      const message = error instanceof AiProviderError ? `${error.kind}: ${error.message}` : 'provider call failed';
      throw new FixRejection('provider_error', message);
    }

    const validated = validateFixOutput(result.output, { lines: original.lines, window, redactedLines });
    const fixed = applyChanges(original, validated.changes);
    const patch = createUnifiedDiff(path, original, validated.changes);
    const proposal: FixProposal = {
      id: randomUUID(),
      findingId: input.target.id,
      fingerprint: input.target.fingerprint,
      filePath: path,
      baseSha: input.baseSha,
      explanation: validated.explanation,
      changes: validated.changes,
      patch,
      patchSha256: sha256Hex(patch),
      originalSha256: sha256Hex(input.content),
      resultSha256: sha256Hex(joinLines(fixed)),
      additions: validated.changes.reduce((sum, c) => sum + c.added.length, 0),
      deletions: validated.changes.reduce((sum, c) => sum + (c.oldEnd - c.oldStart + 1), 0),
      provider: result.provider,
      model: result.model,
      servedByModel: result.servedByModel,
      usage: result.usage,
      costUsd: result.costUsd,
      latencyMs: result.latencyMs,
      createdAt: (input.now?.() ?? new Date()).toISOString(),
    };
    return { status: 'proposed', proposal };
  } catch (error) {
    if (error instanceof FixRejection) return { status: 'rejected', code: error.code, reason: error.message };
    if (error instanceof UnsafePathError) {
      return { status: 'rejected', code: 'unsupported_file', reason: 'Finding path is not a safe repository path' };
    }
    throw error;
  }
}

/**
 * Recomputes the fixed file from its original content and verifies both hashes. Used right before a
 * fix is written anywhere: if the file changed since the proposal, nothing is written.
 */
export function applyProposal(
  proposal: Pick<FixProposal, 'changes' | 'originalSha256' | 'resultSha256' | 'patch' | 'patchSha256'>,
  content: string,
): string {
  if (sha256Hex(proposal.patch) !== proposal.patchSha256) {
    throw new FixRejection('invalid_edits', 'Stored patch does not match its hash');
  }
  if (sha256Hex(content) !== proposal.originalSha256) {
    throw new FixRejection('no_change', 'The file changed since the fix was proposed');
  }
  const result = joinLines(applyChanges(splitLines(content), proposal.changes));
  if (sha256Hex(result) !== proposal.resultSha256) {
    throw new FixRejection('invalid_edits', 'Applying the fix did not produce the approved content');
  }
  return result;
}
