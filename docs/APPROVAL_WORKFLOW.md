# Approval and Fix Workflow

> Implemented in Phase 6. Local repositories: `ai-review fix …` (CLI). GitLab/GitHub: fix proposals by the worker,
> decisions through the operator CLI (`admin.js approvals-*`) until the authenticated dashboard and API arrive in
> Phase 7. Verified against real Git and fake GitLab/GitHub servers. **Not yet run against real GitLab or GitHub.**

## 1. Permissions

| Operation                                                     | Permission                     | Where it happens                                                  |
| ------------------------------------------------------------- | ------------------------------ | ----------------------------------------------------------------- |
| Receive webhook, fetch changes, run review, validate findings | Automatic                      | API / worker                                                      |
| Publish validated comments                                    | Automatic                      | worker                                                            |
| Generate fix proposals                                        | Automatic                      | CLI `fix propose`; worker when `fixes.enabled: true`              |
| Apply code fixes                                              | **Human approval**             | CLI `fix apply` (isolated worktree)                               |
| Stage changes                                                 | **Human approval**             | CLI `fix stage`                                                   |
| Commit changes                                                | **Human approval**             | CLI `fix commit`                                                  |
| Push branch                                                   | **Human approval**             | CLI `fix push`; hosted: `commit_and_push_fix` (see §4)            |
| Create GitLab MR / GitHub PR                                  | **Human approval**             | CLI `fix open`; hosted: `create_merge_request` / `…_pull_request` |
| Merge MR/PR                                                   | **Disabled — not implemented** | nowhere: no code path, no operation kind, no DB enum value        |

`ai-review.yaml` restates this policy and cannot relax it (ADR-021).

## 2. Fix proposals (Module G)

1. A model receives **one finding and one file** (at most ±150 lines around the finding for files over 600 lines).
   Secrets are redacted first. The finding text is model-written, so it goes inside the same nonce-delimited
   untrusted block as the code.
2. The model returns **line-range replacements**, never a diff (`ModelFixOutputSchema`, strict JSON schema).
3. Deterministic validation decides (`validateFixOutput`):
   - ranges must lie inside the lines shown and must not overlap;
   - size limits: at most 10 edits, 80 lines replaced and 120 lines written;
   - no NUL bytes, no redaction markers, no edits on lines that contained a redacted secret;
   - no line-number prefixes copied back.

   Protected files are refused before any model call (ADR-031): CI and workflow files, hooks, package
   manifests, lockfiles, Docker and Make files, `.env*`, keys, and `ai-review.yaml`.

4. The platform computes the **unified diff** itself (`createUnifiedDiff`). The diff is byte-exact, including
   CRLF files and files without a final newline; a property test applies 150 random edit sets with `git apply`.
   It also stores `patch_sha256`, plus SHA-256 hashes of the original and the resulting file.
5. The proposal is shown with the model's explanation, which is labelled as unverified. Nothing has been written.

## 3. Approval requests (Module H)

Each request is bound to:

- the requesting user and the organization;
- the repository and the review session;
- the **reviewed commit SHA**;
- the **exact operation**: kind, fix branch, commit message, MR/PR title and target, commit to push;
- the **patch SHA-256**;
- an **expiry**: 24 h by default, 7 days at most.

All of these are hashed into `binding_hash` (canonical JSON, SHA-256). The short **approval code** is the first
12 hex characters of that hash. Typing it proves the person saw exactly that request.

```text
pending ──approve──▶ approved ──begin──▶ executing ──▶ executed | failed
   │ └──reject──▶ rejected     │
   └── expire / invalidate ────┴──▶ expired | invalidated
```

Rules, enforced in `@acra/approvals` and repeated as PostgreSQL CHECK constraints where possible:

- Only a **human** with role OWNER, ADMIN or MEMBER can approve or reject. VIEWERs and the system cannot.
- **Approving** re-checks that the request was not modified, has not expired, and that the reviewed commit is
  still the latest one.
- **Executing** re-checks everything again, right before the write: the binding hash, the expiry, the
  provider's current head, the patch hash, the original-file hash and the result hash.
- The status moves `approved → executing` with compare-and-set: **an approval is used at most once**. Failed
  writes are recorded as `failed` and are never retried automatically.
- **A new reviewed commit invalidates** every pending or approved request for older commits, and supersedes
  unapplied proposals. Locally this happens on `ai-review review`; on the server, when the worker starts
  reviewing the new head. The executor also refuses if the MR/PR head moved.
- **Untrusted content never authorizes anything.** Operations are built by platform code from stored fields.
  Branch names are generated (`ai-review/fix-<id>`). Commit messages and MR/PR titles are reduced to one plain
  line. MR/PR bodies are escaped, with GitLab quick actions and @mentions neutralised.
- Every request, decision and execution is audited: `audit_logs` on the server (`actor_type USER` with the
  member's id), and `.git/ai-review/audit.jsonl` locally.

## 4. Local repositories (CLI)

```text
ai-review review --yes                    # findings
ai-review fix propose <finding-id> --yes  # patch + explanation, nothing changed
ai-review fix apply  <fix-id>             # approval → isolated worktree + new branch → validation commands
ai-review fix stage  <fix-id>             # approval
ai-review fix commit <fix-id>             # approval (message shown and bound)
ai-review fix push   <fix-id>             # approval (exact commit, never forced)
ai-review fix open   <fix-id>             # approval → GitLab MR / GitHub PR (GITLAB_TOKEN / GITHUB_TOKEN)
ai-review approvals [--all]               # history
```

- **Isolation:** the fix lives in `.git/ai-review/worktrees/<id>` on its own branch, created from the reviewed
  commit. Your checkout, index and current branch are never touched.
- **Repository hooks are disabled** for these operations (`core.hooksPath` points to an empty directory), and
  signing programs are not invoked.
- **Approving:**
  - With a terminal, every step asks **"Approve this operation?"**.
  - Without one, the command prints the approval code and exits with code **4**. Re-run it with
    `--approve <code>`. A wrong or stale code changes nothing.
  - There is no `--yes` for approvals.
- **Validation commands** come from `fixes.validation.commands` in `ai-review.yaml`. They are shown in the
  `apply` approval and run in the fix worktree (ADR-033):
  - allowlisted programs only, run as argv with no shell;
  - a scrubbed environment: no API keys, tokens or database URLs;
  - a 10-minute limit per command, with the whole process tree killed on timeout;
  - output is capped.

  Results are shown and stored. A failing command does not block the next step, but it is reported.

- `ai-review fix discard <id>` removes the worktree and the local fix branch. Remotes are never touched.

## 5. GitLab / GitHub (server)

1. With `fixes.enabled: true` in the repository's `ai-review.yaml`, the worker proposes fixes after each review.
   It covers at most `maxPerReview` findings at or above `minimumSeverity`, and stores them in `proposed_fixes`.
2. An operator, acting for a named member, uses these commands:

   ```powershell
   node dist/apps/api/admin.js members-add --org acme --email dev@acme.io --name "Dev" --role MEMBER
   node dist/apps/api/admin.js fixes-list --org acme
   node dist/apps/api/admin.js fixes-show <fix-id> --org acme
   node dist/apps/api/admin.js approvals-request --org acme --fix <fix-id> --step push --user dev@acme.io
   node dist/apps/api/admin.js approvals-approve <approval-id> --org acme --user lead@acme.io --code <code>
   node dist/apps/api/admin.js approvals-request --org acme --fix <fix-id> --step open --user dev@acme.io
   node dist/apps/api/admin.js approvals-approve <approval-id> --org acme --user lead@acme.io --code <code>
   ```

3. Approving enqueues an `approvals` job, which the worker executes once:
   - **`commit_and_push_fix`:** creates `ai-review/fix-<id>` at the reviewed commit, with one commit
     containing exactly the approved result. There is no working tree on the server, so apply, stage, commit
     and push form one atomic remote write, and the approval shows all four steps (ADR-034).
     - GitLab: the commits API with `start_sha`.
     - GitHub: a new ref, then the contents API.
     - An existing branch is never moved.
   - **`create_merge_request` / `create_pull_request`:** opens an MR/PR from the fix branch into the reviewed
     MR/PR's **source branch**, only if the fix branch is still at the approved commit.
4. No repository commands run on the server. The repository's own CI validates the fix MR/PR (ADR-033).
5. GitHub: only these execution jobs request a `contents:write` installation token, scoped to the single
   repository. Review jobs stay read-only. The GitHub App therefore needs **Contents: Read and write** (see
   [GITHUB.md](./GITHUB.md)).
