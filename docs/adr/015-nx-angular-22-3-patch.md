# ADR-015: Patch Nx 24.0.6 for Angular 22.3

**Status:** Accepted (temporary) · 2026-11-23

## Context

Running any Angular builder (`build`, `test`, `serve`) through Nx failed:

```
Package subpath './node/index' is not defined by "exports" in .../@angular-devkit/architect/package.json
```

`@angular-devkit/architect@0.2203.0` (Angular 22.3) introduced a package `exports` map that exposes `./node`
but not `./node/index.js`. Nx 24.0.6 (`nx/dist/src/adapter/ngcli-adapter.js`) imports the deep path.
Architect 0.2202.x (Angular 22.2) had no exports map, so Nx's own default (Angular ~22.2) worked.
At the time of writing no stable Nx release contains a fix (only 24.1 betas, and prereleases are forbidden).

Options considered:

1. Downgrade to Angular 22.2.x. Rejected: Angular 22.3.x is a fixed product requirement.
2. Use Nx 24.1 beta. Rejected: prerelease.
3. **Patch the single import to the public `@angular-devkit/architect/node` export.** This is
   backward compatible with architects that have no exports map.

## Decision

Option 3 via `pnpm patch`: `patches/nx@24.0.6.patch` (one changed line), registered in
`package.json → pnpm.patchedDependencies` and applied on every install.

## Consequences

- **Remove the patch** (delete the file and the `patchedDependencies` entry) when upgrading to an Nx release
  that fixes the import. pnpm will fail loudly if the patch no longer applies.
