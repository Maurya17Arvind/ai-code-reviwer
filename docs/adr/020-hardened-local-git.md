# ADR-020: Hardened, read-only local Git access

**Status:** Accepted · 2026-11-23

## Context

The CLI and, later, the worker run git inside repositories whose content is untrusted. The repository's own
`.git/config` and `.gitattributes`, user-level git configuration, and environment variables can all change
git's behaviour or make it run programs. For example, `core.fsmonitor` runs a command during
`git status`/`git diff`, and external diff/textconv drivers run commands while diffing. Refs and paths come
from user input and from AI output.

## Decision

`LocalGitProvider` (`@acra/git-providers-local`):

- Uses the git CLI through **simple-git 4.1.0 in strict mode**. Processes are spawned without a shell,
  options that enable command execution are blocked, and `GIT_*` / pager environment variables are stripped.
- Forces these settings on every command:
  `core.fsmonitor=false`, `core.quotePath=false`, `color.ui=false`, `diff.noprefix=false`,
  `diff.mnemonicPrefix=false`, `diff.relative=false`. Diffs use
  `--no-ext-diff --no-textconv --src-prefix=a/ --dst-prefix=b/`.
- Validates refs with `assertSafeGitRef`: no leading `-` (option injection), no `..` ranges, no `@{`/`:`
  selectors. Ranges are built internally from resolved commit ids, and commit ids passed to `readFile` must
  be full hex object ids.
- Resolves paths with `resolveInsideRepo`: no absolute paths or `..` segments, and symlink targets must stay
  inside the repository. File reads are size-limited (default 1 MB) and binary-sniffed. Diff output is capped
  at 50 MB. Each git process has a 30 s inactivity timeout.
- **Read-only.** The provider has no method that writes to the repository, index or refs. Tests confirm that
  `git status` is unchanged after every scope is computed.

## Consequences

- An integration test configures a hostile `core.fsmonitor` command and verifies it is never executed. Option
  injection through `--base` is rejected before git runs.
- simple-git does not reject when git exits non-zero _without_ stderr output (as `--quiet` commands do).
  Existence checks therefore look at the output, never at the absence of an error. This was found by tests
  and is documented in the code.
- Masking credentials embedded in `origin` URLs happens before any output.
