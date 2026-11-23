# ADR-027: Small typed fetch client for GitLab instead of a full SDK

**Status:** Accepted · 2026-11-23

## Context

The adapter needs about 12 GitLab REST v4 endpoints. `@gitbeaker/rest` covers the whole API, but every outbound
request carrying a stored token must be controlled: SSRF validation of user-configured instance URLs, no
redirects (a redirect could send the token to another host), timeouts, response-size caps and Retry-After
handling.

## Decision

- `GitLabClient` in `libs/git-providers/gitlab` is a small `fetch` client:
  - the base URL is validated with `assertSafeOutboundUrl` before the first request (https, allowlisted host,
    no private addresses unless explicitly enabled);
  - `redirect: 'manual'`, and any 3xx is an error;
  - 30 s timeout;
  - up to 3 retries for 429/502/503/504, honouring `Retry-After` (capped at 30 s);
  - 20 MB cap on JSON responses; streamed file reads stop at the file size limit;
  - `x-next-page` pagination (100 per page, 50 pages maximum);
  - error messages never include the token, and file paths are redacted from them.
- No new dependency is needed. The adapter is tested against a fake GitLab HTTP server, not mocks of an SDK.

## Consequences

New endpoints need a few lines each. GitHub (Phase 5) uses Octokit, because GitHub App authentication
(JWT → installation token) is complex. The same outbound policy is applied through Octokit's `request.fetch`.
