# ADR-016: Explicit `@Inject()` tokens in NestJS

**Status:** Accepted · 2026-11-23

## Context

Nest's implicit constructor injection relies on TypeScript `emitDecoratorMetadata`. Production builds use
tsc (webpack + ts-loader), which emits it. Unit tests run through Vite's transformer, where metadata
emission depends on transformer support. A type-only import of an injected class also silently erases
the metadata.

## Decision

Every Nest constructor dependency is declared with an explicit token: `@Inject(SomeClass)`,
`@Inject(SOME_SYMBOL)` or `@InjectQueue(name)`. Lint rules that would turn injected classes into
type-only imports (`consistent-type-imports`) are not enabled.

## Consequences

DI behaves the same in builds and tests. Classes can also be instantiated directly in unit tests with fakes.
