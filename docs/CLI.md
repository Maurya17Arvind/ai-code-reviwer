# `ai-review` CLI

> Version 0.3.0 (Phase 3). The CLI is **read-only with respect to your code**: it never modifies, stages,
> commits or pushes. `init` only creates `ai-review.yaml`, and only when you ask it to.

Build and run from the workspace:

```powershell
pnpm nx build cli
node dist/apps/cli/main.js --help
```

## Global options

| Option              | Meaning                                                                                                                         |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `-C, --repo <path>` | Repository to operate on (default: current directory; any sub-directory works). Use it to work with several local repositories. |
| `-v, --version`     | Print the CLI version                                                                                                           |
| `-h, --help`        | Help for the program or a command                                                                                               |

## Commands

### `ai-review init [--force]`

Creates `ai-review.yaml` in the repository root. Framework and language are detected from `package.json` /
`tsconfig.json` (Angular, NestJS, Next.js, React, Vue, Svelte, Express, Node; TypeScript or JavaScript).
Refuses to overwrite an existing file unless `--force` is given. The file is not staged or committed.

### `ai-review status [--format text|json]`

Shows the repository root, current branch, HEAD, detected base branch, `origin` URL (credentials masked),
configuration state (valid / defaults / invalid with reasons), and the number of staged, unstaged and
untracked files.

Base branch detection order: `origin/HEAD` → local `main`, `master`, `develop`, `trunk` → `origin/<same>`.

### `ai-review changes [scope] [options]`

Previews exactly what a review would include: the changed files, the hunks, the surrounding source, which
files are omitted and why, the total size, and the context hash. **Nothing is sent anywhere.**

| Scope flag                        | Changes included                                                                              |
| --------------------------------- | --------------------------------------------------------------------------------------------- |
| _(none)_ / `--all [--base <ref>]` | Everything not in the base: committed + staged + unstaged + untracked, against the merge-base |
| `--staged`                        | Index vs HEAD                                                                                 |
| `--unstaged`                      | Working tree vs index, including untracked files                                              |
| `--base <ref>`                    | Commits on the current branch that are not in `<ref>` (merge-base..HEAD)                      |
| `--branch <ref> [--base <b>]`     | Commits on `<ref>` that are not in `<b>`, without checking `<ref>` out                        |

| Option                | Meaning                                                                         |
| --------------------- | ------------------------------------------------------------------------------- |
| `--no-untracked`      | Leave out untracked files                                                       |
| `--diff-context <n>`  | Unchanged lines inside the diff (`git -U<n>`, default 3)                        |
| `--surrounding <n>`   | Surrounding source lines per hunk (overrides `review.context.surroundingLines`) |
| `--show-context`      | Print the surrounding source snippets (text format)                             |
| `--format text\|json` | JSON prints the complete review context, including snippets and the hash        |

Files are omitted, with a reason shown, when they are `excluded` (built-in or `ai-review.yaml` glob), `binary`,
`too large`, over the `max files` or `budget` limits, or `unreadable`.

Built-in exclusions: `node_modules`, `dist`, `build`, `coverage`, `.git`, `*.lock`, `package-lock.json`,
`pnpm-lock.yaml`, `yarn.lock`, `*.min.js`, `*.min.css`, `*.map`, `*.snap`.

Example:

```text
$ ai-review changes --base main
Repository  D:/work/shop (feature/users)
Scope       commits on the current branch not in main
Compared    3f2a1b9c0d1e → 9c8b7a6d5e4f
Config      ai-review.yaml

Included files (2)
  A  src/app/new.component.ts     +12    -0  1 hunk
  M  src/app/user.service.ts       +4    -1  1 hunk

Omitted (1)
  M  pnpm-lock.yaml  excluded (**/pnpm-lock.yaml)

Context     2 files · 2 hunks · +16 −1 · 1.9 KB · sha256 5d41402abc4b
Preview only — nothing was sent to any AI provider or server.
```

## Exit codes

| Code | Meaning                                                                                                        |
| ---- | -------------------------------------------------------------------------------------------------------------- |
| 0    | Success (including `--help` / `--version`)                                                                     |
| 1    | Runtime error: not a repository, unknown or unsafe ref, invalid `ai-review.yaml`, git failure, unknown command |
| 2    | Conflicting scope flags or a base branch that cannot be determined                                             |
| 4    | `fix apply/stage/commit/push/open`: approval required but no terminal — re-run with `--approve <code>`         |

### `ai-review review [scope] [options]`

Reviews the changes with Claude and GPT. It uses the same scope flags as `changes` (`--staged`, `--unstaged`,
`--base`, `--branch`, `--all`, `--no-untracked`, `--diff-context`, `--surrounding`).

| Option                 | Meaning                                                                                                                           |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `--provider <name>`    | `claude`, `gpt`, `ollama` (local), `both` (Claude + GPT, default) or `all`. Intersected with `review.providers` in ai-review.yaml |
| `-y, --yes`            | Consent to sending the review context to remote providers (required without an interactive terminal)                              |
| `--fail-on <severity>` | Exit with code **3** when findings at or above this severity exist (CI gate)                                                      |
| `--format <format>`    | `text` (default) or `json` (full review report)                                                                                   |
| `--verbose`            | Print descriptions, evidence and suggestions                                                                                      |

**Consent.** Before anything is sent, the CLI prints the number of files, the size and the destinations (provider,
model, host), then asks. Without a terminal it refuses unless `--yes` is passed. Secrets are redacted first.
Nothing is sent to our servers, and the repository's own `.env` is never loaded. When every reviewer is local
(Ollama on loopback), no consent is needed: the summary says "Nothing leaves this machine".

Results are stored in `.git/ai-review/`, which is never committed (latest report, last 50 reports, your
dismissals). The command never modifies, stages, commits or pushes code.

### `ai-review findings [--severity <min>] [--format text|json] [--verbose]`

Lists the findings of the latest review. Local only, no network.

### `ai-review dismiss <finding-id> [--false-positive] [--reason <text>]`

Records a dismissal, or a false positive, for a finding (use an id prefix of at least 4 characters). Later
reviews will not report that issue again (matched by fingerprint, independent of line numbers).

### `ai-review report [--format text|json|markdown] [-o <file>]`

Renders the latest review. Markdown includes per-provider status, tokens and cost, findings with evidence and
suggestions, and resolved findings. Untrusted model text is escaped.

## Fixes and approvals (Phase 6)

See [APPROVAL_WORKFLOW.md](./APPROVAL_WORKFLOW.md) for the full model.

| Command                                      | What it does                                                                                                                      | Approval                         |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| `fix propose <finding-id> [--provider] [-y]` | One model proposes a minimal fix for one finding; shows the explanation and exact patch. Changes nothing                          | no (consent before sending code) |
| `fix list` / `fix show <fix-id>`             | Proposals, their state, patch and validation results                                                                              | no                               |
| `fix apply <fix-id> [--skip-validation]`     | Creates `.git/ai-review/worktrees/<id>` on a new `ai-review/fix-<id>` branch, applies the patch, runs `fixes.validation.commands` | **yes**                          |
| `fix stage <fix-id>`                         | `git add` of exactly the fixed file in the fix worktree                                                                           | **yes**                          |
| `fix commit <fix-id> [--message]`            | Commits on the fix branch (message shown and bound; hooks disabled)                                                               | **yes**                          |
| `fix push <fix-id> [--remote origin]`        | Pushes exactly the approved commit as the fix branch, never forced                                                                | **yes**                          |
| `fix open <fix-id> [--target] [--host]`      | Opens a GitLab MR / GitHub PR (token from `GITLAB_TOKEN` / `GITHUB_TOKEN`); never merged                                          | **yes**                          |
| `fix discard <fix-id>`                       | Removes the fix worktree and local fix branch                                                                                     | no                               |
| `approvals [--all]`                          | Open requests, or the full history                                                                                                | no                               |

Approving:

- With a terminal, every approval step asks "Approve this operation?". A "no" rejects the request and nothing changes.
- Without a terminal, the command prints an **approval code** and exits with **4**. Re-run it with
  `--approve <code>`. The code is derived from the request's binding hash, so it only approves exactly what was shown.
- There is no blanket `--yes` for approvals.
- A newer `ai-review review` of a different commit invalidates every open approval.

## AI provider configuration (environment)

| Variable                                                                                            | Default                  | Meaning                                                                                  |
| --------------------------------------------------------------------------------------------------- | ------------------------ | ---------------------------------------------------------------------------------------- |
| `ANTHROPIC_API_KEY`                                                                                 | —                        | Read by the Anthropic SDK (an `ant auth login` profile also works)                       |
| `ANTHROPIC_REVIEW_MODEL`                                                                            | `claude-opus-5-5`        | Claude model                                                                             |
| `ANTHROPIC_REVIEW_EFFORT`                                                                           | `high`                   | `low`, `medium`, `high`, `xhigh` or `max`                                                |
| `ANTHROPIC_REFUSAL_FALLBACK`                                                                        | `true`                   | Server-side refusal fallback (ADR-024)                                                   |
| `OPENAI_API_KEY`                                                                                    | —                        | Read by the OpenAI SDK                                                                   |
| `OPENAI_REVIEW_MODEL`                                                                               | **none**                 | Required to enable GPT; GPT is skipped without it                                        |
| `OPENAI_REASONING_EFFORT`                                                                           | unset                    | `low`, `medium` or `high`                                                                |
| `OPENAI_PRICE_INPUT_PER_MTOK`, `OPENAI_PRICE_OUTPUT_PER_MTOK`, `OPENAI_PRICE_CACHED_INPUT_PER_MTOK` | unset                    | Enables GPT cost estimates                                                               |
| `OLLAMA_REVIEW_MODEL`                                                                               | **none**                 | Local Ollama model (e.g. `qwen2.5-coder:3b`); required for `--provider ollama` (ADR-026) |
| `OLLAMA_BASE_URL`                                                                                   | `http://127.0.0.1:11434` | A non-loopback host requires consent, like cloud providers                               |
| `OLLAMA_NUM_CTX`                                                                                    | `16384`                  | Context window; prompts that fill it are rejected as truncated                           |
| `AI_REVIEW_TIMEOUT_MS`                                                                              | `600000`                 | Per-provider limit (raise it for slow CPU-only local models)                             |

Exit codes for `review`: `0` success · `1` no reviewer succeeded or a runtime error · `2` usage error or missing consent · `3` `--fail-on` threshold reached.
