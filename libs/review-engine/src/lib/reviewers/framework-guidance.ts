/**
 * Framework-specific review guidance appended to the system prompt (product brief §11).
 * Written for current Angular (v22): standalone, signals, zoneless, built-in control flow.
 * Outdated advice (NgModules, *ngIf/*ngFor, zone.js-specific tuning) is intentionally absent.
 */
export const ANGULAR_GUIDANCE = `Angular (v22) review focus — report only concrete problems in the changed code:
- Dependency injection: inject() must run in an injection context (field initializers, constructors, factory functions); calls inside callbacks, setTimeout or async continuations throw at runtime.
- Signals: never write to signals inside computed() (throws/loops); computed() must be pure. Reading a signal in a template or computed is fine; reading it once in a constructor loses reactivity.
- effect(): use for side effects synchronising with non-signal APIs only; setting signals inside effects to derive state should be computed() or linkedSignal(). Effects created outside an injection context need an explicit injector.
- RxJS: subscriptions in components/services must be cleaned up (takeUntilDestroyed(), the async pipe, toSignal()). Nested subscribes, missing error handling and unbounded shareReplay are real defects.
- Change detection (zoneless/OnPush): state that is not a signal or async-pipe value and is mutated outside Angular events will not update the view.
- Templates: built-in control flow (@if/@for/@switch); @for requires a meaningful track expression — tracking by $index on reorderable or keyed data causes wrong DOM reuse. @defer for heavy, below-the-fold content.
- Routing: feature routes should be lazy (loadComponent/loadChildren); guards/resolvers as functions with inject().
- Forms: prefer typed reactive forms; avoid untyped FormControl<any>; validate on the client and never trust it on the server.
- Security/XSS: Angular sanitizes bindings — DomSanitizer.bypassSecurityTrust*, [innerHTML] with untrusted data after bypass, ElementRef.nativeElement.innerHTML writes and direct DOM APIs are XSS risks.
- NgRx: reducers must be pure and immutable; effects must handle errors inside the inner observable (otherwise the effect dies); selectors should be memoized.
- Apollo Angular / GraphQL: watch for missing error handling, over-fetching fields, N+1 query patterns, cache key (id/__typename) mismatches that break normalization, refetchQueries overuse, and mutations without cache updates.
- TypeScript strict mode: non-null assertions (!) and 'as' casts that hide null/undefined or wrong shapes; any leaking into public APIs.
- Testing: changed behaviour without tests, tests that only assert implementation details, or async tests without proper awaiting.`;

export function frameworkGuidance(framework: string | undefined, usesAngular: boolean): string | null {
  if (framework === 'angular' || usesAngular) return ANGULAR_GUIDANCE;
  return null;
}
