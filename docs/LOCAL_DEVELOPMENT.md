# Local Development

> Verified on Windows 11 (PowerShell + Git Bash), 2026-11-23.

## 1. Prerequisites

| Tool           | Version             | Check                                                  |
| -------------- | ------------------- | ------------------------------------------------------ |
| Node.js        | 24.15.x (`.nvmrc`)  | `node --version` — with nvm-windows: `nvm use 24.15.0` |
| pnpm           | 10.32+              | `pnpm --version` (or `corepack enable`)                |
| Docker Desktop | 29+ with Compose v2 | `docker info`                                          |
| Git            | 2.4x                | `git --version`                                        |

Recommended on Windows (admin PowerShell): enable long paths —
`New-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem' -Name LongPathsEnabled -Value 1 -PropertyType DWORD -Force`
and `git config --global core.longpaths true`.

## 2. First-time setup

```powershell
pnpm install                     # also applies patches/ and runs `prisma generate`
Copy-Item .env.example .env      # then replace every change-me value with long random strings
pnpm infra:up                    # PostgreSQL 18.7 + Redis 8.10 (waits until healthy)
pnpm db:migrate                  # apply migrations
pnpm check                       # lint + typecheck + unit tests + build (all projects)
pnpm test:integration            # integration tests against the local containers
```

## 3. Running the apps

| Command                                                  | What                                        | URL                                    |
| -------------------------------------------------------- | ------------------------------------------- | -------------------------------------- |
| `pnpm dev:api`                                           | NestJS API (watch)                          | http://127.0.0.1:3000/api/health/ready |
| `pnpm dev:worker`                                        | BullMQ worker (watch)                       | —                                      |
| `pnpm dev:dashboard`                                     | Angular dev server; `/api` proxied to :3000 | http://localhost:4300                  |
| `pnpm nx build cli && node dist/apps/cli/main.js --help` | CLI                                         | —                                      |

The dashboard runs on **4300** (4200 is commonly taken on this machine).

## 4. Everyday commands

| Command                                   | Purpose                                                   |
| ----------------------------------------- | --------------------------------------------------------- |
| `pnpm nx affected -t lint typecheck test` | Only what changed vs `main`                               |
| `pnpm nx run <project>:test`              | Unit tests of one project                                 |
| `pnpm nx run <project>:integration`       | Integration tests (api, worker, database)                 |
| `pnpm format` / `pnpm format:check`       | Prettier                                                  |
| `pnpm db:migrate:dev`                     | Create + apply a migration after editing `schema.prisma`  |
| `pnpm db:studio`                          | Browse data                                               |
| `pnpm infra:down`                         | Stop containers (data volumes are kept); add `-v` to wipe |
| `pnpm nx graph`                           | Visualise the project graph and boundaries                |

## 5. Troubleshooting

| Symptom                                                              | Fix                                                                                                               |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `Invalid environment configuration: - DATABASE_URL: is required`     | Create `.env` from `.env.example`; values must match the Compose passwords                                        |
| `ERR_PNPM_UNKNOWN ... copyfile` on Windows                           | A process holds files in `node_modules` (often the Nx daemon): `pnpm nx daemon --stop`, then retry                |
| Nx generator fails with `Command failed: pnpm install` in PowerShell | Run generators from Git Bash, or run `pnpm install` afterwards — the files are generated correctly                |
| `Package subpath './node/index' is not defined by "exports"`         | The Nx patch was not applied: run `pnpm install` (see ADR-015)                                                    |
| `npm warn Unknown project config "strict-peer-dependencies"`         | Harmless; these are pnpm settings. Use `pnpm` instead of `npm`/`npx`                                              |
| Changing Postgres passwords in `.env` has no effect                  | The init script only runs on an empty volume: `docker compose down -v` (destroys local data) then `pnpm infra:up` |
| Port already in use                                                  | `Get-Process -Id (Get-NetTCPConnection -LocalPort 3000 -State Listen).OwningProcess`                              |
