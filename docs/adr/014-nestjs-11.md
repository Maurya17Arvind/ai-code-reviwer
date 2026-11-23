# ADR-014: NestJS 11.2.x instead of 12.x

**Status:** Accepted · 2026-11-23 · Deviation from the Phase 0 proposal (which listed NestJS 12)

## Context

NestJS 12.6.0 is the latest release. Installing it with strict peer checking failed:

```
@nx/nest 24.0.6
├── ✕ unmet peer @nestjs/common@">=10.0.0 <12.0.0": found 12.6.0
└── ✕ unmet peer @nestjs/core@">=10.0.0 <12.0.0": found 12.6.0
```

The requirement is "latest stable **compatible** NestJS". Overriding the peer would hide exactly the kind
of incompatibility the project rules forbid hiding.

## Decision

Pin **NestJS 11.2.11** (`@nestjs/common`, `core`, `platform-express`, `testing`) and `@nestjs/schematics` 11.1.0.
Every other Nest-ecosystem package used (`@nestjs/bullmq` 12.0.2, `nestjs-pino` 5.3.2) supports both 11 and 12.

## Consequences

Upgrade to NestJS 12 when an Nx release widens the `@nx/nest` peer range. Application code uses no
Nest 12–only APIs, so the upgrade should be mechanical.
