# ADR-003: TypeScript 6.0.3 workspace-wide

**Status:** Accepted · 2026-11-23

## Context

npm's `latest` TypeScript is 7.0.2, but `@angular/compiler-cli@22.3.0` and `@angular/build@22.3.0` require
`typescript >=6.0 <6.1`. typescript-eslint 8.73 supports `<6.1.0`.

## Decision

- **TypeScript 6.0.3** for every project. A single version avoids drift between the dashboard and Node code.
- Strict base config: `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
  `noPropertyAccessFromIndexSignature`, `noImplicitOverride`, `noImplicitReturns`, `useUnknownInCatchVariables`,
  `isolatedModules`. Angular strict templates, strict injection parameters and strict input access modifiers.
- `baseUrl` is **not** used (deprecated in TS 6, removed in TS 7). Path aliases resolve relative to `tsconfig.base.json`.
- Every project has an explicit `typecheck` target (`tsc --noEmit` / `ngc --noEmit`) covering source and specs.

## Consequences

Upgrading to TS 7 is blocked on Angular support. Code written now avoids TS 7–removed options.
