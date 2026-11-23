# Architecture Decision Records

Format: short context, decision, consequences. Status is one of **Proposed**, **Accepted** or **Superseded**.
A _Proposed_ ADR describes a decision for a future phase; it becomes _Accepted_ when implemented.

| ADR                                             | Title                                                      | Status                                                      |
| ----------------------------------------------- | ---------------------------------------------------------- | ----------------------------------------------------------- |
| [001](./001-nx-monorepo-pnpm.md)                | Nx monorepo with pnpm                                      | Accepted                                                    |
| [002](./002-node-24-lts.md)                     | Node.js 24 LTS                                             | Accepted                                                    |
| [003](./003-typescript-6.md)                    | TypeScript 6.0.3 workspace-wide                            | Accepted                                                    |
| [004](./004-langgraph-orchestration-only.md)    | LangGraph for orchestration, vendor SDKs behind a port     | Proposed (Phase 3)                                          |
| [005](./005-zod-single-schema-language.md)      | Zod as the single schema language; zod/mini in the browser | Accepted                                                    |
| [006](./006-prisma-7-stable.md)                 | Prisma 7.10.1 (stable), not 8.0 RC                         | Accepted                                                    |
| [007](./007-postgresql-18.md)                   | PostgreSQL 18.7 rather than 19.0                           | Accepted                                                    |
| [008](./008-redis-bullmq.md)                    | Redis 8 + BullMQ 6                                         | Accepted                                                    |
| [009](./009-separate-api-and-worker.md)         | Separate API and worker processes                          | Accepted                                                    |
| [010](./010-tenant-isolation.md)                | Tenant isolation in the data layer                         | Accepted (schema); enforcement with first tenant repository |
| [011](./011-envelope-encryption.md)             | Envelope encryption for provider credentials               | Proposed (Phase 4)                                          |
| [012](./012-vitest.md)                          | Vitest across the workspace                                | Accepted                                                    |
| [013](./013-structured-logging.md)              | Structured logging with pino and central redaction         | Accepted                                                    |
| [014](./014-nestjs-11.md)                       | NestJS 11.2.x instead of 12.x                              | Accepted                                                    |
| [015](./015-nx-angular-22-3-patch.md)           | Patch Nx 24.0.6 for Angular 22.3                           | Accepted (temporary)                                        |
| [016](./016-explicit-di-tokens.md)              | Explicit `@Inject()` tokens in NestJS                      | Accepted                                                    |
| [017](./017-module-boundary-tags.md)            | Scope/type tags for module boundaries                      | Accepted                                                    |
| [018](./018-append-only-audit-log.md)           | Database-enforced append-only audit log                    | Accepted                                                    |
| [019](./019-capability-split-provider-ports.md) | Capability-split Git provider ports                        | Accepted                                                    |
| [020](./020-hardened-local-git.md)              | Hardened, read-only local Git access                       | Accepted                                                    |
| [021](./021-repository-config-untrusted.md)     | `ai-review.yaml` is untrusted and cannot relax policy      | Accepted                                                    |
