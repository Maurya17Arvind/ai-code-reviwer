# ADR-029: GitHub App with per-job, repository-scoped installation tokens

**Status:** Accepted · 2026-11-23

## Context

GitHub offers three ways for a service to act on repositories: personal access tokens, OAuth apps and GitHub Apps.
The review worker must read code and comment on pull requests in many repositories across several organizations,
without acting as any human user.

## Decision

- **GitHub App only.** No PATs, no OAuth.
  - The App authenticates with an RS256 JWT, valid for 9 minutes and backdated 60 s for clock skew.
  - It exchanges the JWT for installation access tokens.
- **Least privilege at two levels:**
  - The App is registered with Contents: read, Pull requests: write and Metadata: read only.
  - Each review job requests a token restricted to **the one repository being reviewed**, with the same three
    permissions (`repository_ids` + `permissions` in `POST /app/installations/{id}/access_tokens`). A bug or
    a prompt-injected path in one job cannot reach another repository of the same installation.
- **No stored secret per connection.**
  - `provider_connections` holds the installation id and account login. `encrypted_token` is null for GitHub
    rows; a CHECK constraint enforces "GitLab ⇒ token, GitHub ⇒ installation id".
  - The App private key lives in the worker/admin environment: a file path is preferred, inline is allowed.
    The API never receives it.
- **Tokens are cached in memory only.** Each token is cached per (installation, repository set) and refreshed
  five minutes before it expires.
- **Same HTTP client discipline as GitLab** (ADR-027). This **supersedes** ADR-027's note that GitHub would use
  Octokit. GitHub also uses a small typed `fetch` client:
  - SSRF policy on the API base URL;
  - no redirects, timeouts and size caps;
  - `Retry-After` / `x-ratelimit-reset` handling;
  - `Link` pagination restricted to the same origin.

  The REST and GraphQL surface needed is about ten calls. JWT signing uses `node:crypto`. No new dependency.

- **Review threads are resolved through GraphQL** (`resolveReviewThread`), because REST cannot resolve them.
  The summary is a single issue comment updated in place.

## Consequences

- Each job costs one extra token request when its token is not cached. That is negligible next to model latency.
- Rotating the App private key needs only an environment change and a restart. No database migration.
- Organizations that forbid GitHub Apps cannot use the GitHub integration. That is acceptable, since PATs would
  violate the least-privilege requirement.

## Update (Phase 6, ADR-034)

Executing a human-approved fix (create the fix branch and commit, open the PR) needs `contents:write`. The App
registration therefore grants **Contents: Read and write**. Only the approval executor requests write tokens
(`WRITE_TOKEN_PERMISSIONS`), scoped to the one repository and only after the approval was re-verified. Review jobs
still request `contents:read`.
