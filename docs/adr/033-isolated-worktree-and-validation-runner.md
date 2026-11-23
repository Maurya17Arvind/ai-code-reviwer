# ADR-033: Isolated fix worktrees and an allowlisted validation runner

**Status:** Accepted · 2026-11-24

## Context

Module G requires running tests, lint and typecheck after applying a fix, and the result must be shown to the user.
Repository code is untrusted. That includes test scripts, Git hooks and configuration, and the commands themselves
come from `ai-review.yaml`, which is also untrusted (ADR-021). The rule is that AI-generated commands never run
without security validation and explicit authorization.

## Decision

- **Local fixes are applied in a linked worktree** at `.git/ai-review/worktrees/<id>`, on a new
  `ai-review/fix-<id>` branch created from the reviewed commit. The user's checkout, index and branch are never
  touched. The exact approved patch bytes are applied with `git apply --check`, then `git apply`, and the result
  hash is verified.
- **Write operations disable repository hooks** (`core.hooksPath` points to an empty directory) and do not invoke
  signing programs. Pushes use one exact refspec and are never forced. A test plants real hooks and verifies that
  none run.
- **Validation commands (`@acra/sandbox`):**
  - The allowlist is `npm|pnpm|yarn test|run <script>`, `go test|vet|build`, `cargo test|check|clippy|build`,
    `dotnet test|build` and `pytest`.
  - Nothing that installs, downloads or evaluates code is allowed: no `npx`/`dlx`/`exec`, `node -e`, `sh` or `make`.
  - Commands are parsed into argv. Arguments are restricted to a safe character set. Flags that redirect a package
    manager (`--prefix`, `--registry`, `-C`, …) are denied, and paths must stay inside the repository.
  - No shell is used. The exception is cmd.exe for npm/pnpm/yarn `.cmd` shims on Windows, which is only reached
    with arguments that cmd does not interpret.
  - The environment is scrubbed to an allowlist (PATH, HOME, temp directories, toolchain homes). API keys, tokens and
    database URLs never reach repository code.
  - Each command has a 10-minute limit; on timeout the whole process tree is killed. Output keeps only the last
    64 KB.
  - The exact commands are part of the `apply_fix` approval and its binding hash.
- **The server runs no repository commands.** Hosted fixes are validated by the repository's own CI on the fix
  MR/PR.

## Consequences

- Locally, validation is **authorized but not sandboxed at the OS level**: commands run as the user, with network
  and filesystem access, in the worktree. This is the same trust as running `pnpm test` yourself, which is why the
  commands are shown and approved first.
- OS-level isolation (containers, no network, CPU and memory limits) is planned for Phase 8 as an optional
  server-side runner. It is not claimed here.
