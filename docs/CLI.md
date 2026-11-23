# `ai-review` CLI

> Version 0.2.0 (Phase 2). The CLI is **read-only with respect to your code**: it never modifies, stages,
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

## Coming in Phase 3

`ai-review review [scope]`, `ai-review findings`, `ai-review report --format json`. These use the same scope
flags as `changes`.
