# ADR-019: Capability-split Git provider ports

**Status:** Accepted · 2026-11-23

## Context

The product brief proposes one `GitProvider` interface. It covers reading the repository, MR/PR access,
publishing comments, and writing (branch, push, create MR/PR). That interface has three problems:

- A local repository cannot publish review comments or create MRs.
- Write operations are approval-gated and must be impossible to call from the read path.
- Domain services such as the context builder need only one method: read a file.

## Decision

The interface is split into ports in `@acra/git-providers-core` (interface segregation):

- `FileContentReader`: `readFile(path, revision)`.
- `RepositoryReader extends FileContentReader`: `getRepositoryInfo`, `getChangeSet(scope)`, `getCommitDetails`.
- `ReviewRequestSource` / `ReviewPublisher` (Phases 4–5): MR/PR details, existing comments, inline and
  summary comments.
- `RepositoryWriter` (Phase 6): createBranch, pushChanges, createReviewRequest. It is only reachable through
  the approval service.

Ports are added in the phase that implements them; only the Phase 2 ports exist now. The diff model
(`ChangedFile`/`DiffHunk`/`DiffLine`) is provider-neutral. `parseHunks` already handles the per-file
hunk format returned by the GitLab and GitHub APIs.

## Consequences

The review engine depends on `FileContentReader`/`RepositoryReader` only. A compromised or buggy read path
has no write capability in its type. Each provider implements only what it can actually do.
