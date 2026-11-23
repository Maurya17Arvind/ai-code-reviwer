# ADR-034: Hosted fixes are written through provider APIs by an approval executor

**Status:** Accepted · 2026-11-24

## Context

For GitLab merge requests and GitHub pull requests, Phase 6 must push an approved fix branch and open an MR/PR. The
worker has no clone of the repository. Cloning just to commit one file would require storing push credentials and
running Git on untrusted repositories.

## Decision

- New port `RepositoryWriter` in `git-providers-core`, implemented by both adapters:
  - `commitFileToNewBranch` creates the branch at the reviewed commit with one commit:
    - GitLab: `POST /repository/commits` with `start_sha`;
    - GitHub: `POST /git/refs`, then `PUT /contents`; the created ref is removed if the second call fails.
  - `createReviewRequest` opens the MR/PR.
  - `branchHead` reads a branch's current commit.
  - Only `ai-review/fix-*` branches can be written. An existing branch is never moved, and nothing is deleted,
    approved or merged.
- Server operations:
  - `commit_and_push_fix` covers apply, stage, commit and push as one approved remote write; the approval text
    lists every step.
  - `create_merge_request` / `create_pull_request` require that the fix branch is still at the approved commit.
  - The target is the reviewed MR/PR's **source branch**, so the fix lands in the change under review, not in the
    default branch.
- Execution runs in the worker (`approvals` queue, concurrency 1, one attempt) and re-verifies everything
  (ADR-032).
- GitHub: execution jobs request installation tokens with `contents:write`, `pull_requests:write` and
  `metadata:read`, scoped to the one repository. Review jobs keep read-only `contents`. The App registration must
  grant Contents: Read and write. This updates ADR-029, which assumed read-only contents.
- Until Phase 7, decisions are made through the operator CLI (`admin.js approvals-*`), and the approval code is
  required.

## Consequences

- Hosted fixes are single-file, single-commit changes. That matches ADR-031.
- No repository code runs on the server. CI on the fix MR/PR is the validation step (ADR-033).
- Write capability exists in the platform, but only behind an executed approval. Credentials for it are minted per
  job.
