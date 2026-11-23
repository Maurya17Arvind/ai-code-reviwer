# ADR-030: GitHub webhook intake — one signed URL, installation-based routing

**Status:** Accepted · 2026-11-23

## Context

A GitHub App has exactly one webhook URL and one secret for all installations. GitLab hooks are per project, so
the repository id is in the URL (ADR-028). That pattern does not apply to GitHub.

## Decision

- **`POST /api/webhooks/github`** for the whole App.
- **Signature first.**
  - `X-Hub-Signature-256` is verified with HMAC-SHA256 over the **raw request bytes**. Nest is created with
    `rawBody: true`; the 2 MB body limit still applies.
  - The comparison is constant-time (`timingSafeEqual`).
  - Nothing in the payload is parsed before the signature passes. Any failure returns `401`.
  - Without `GITHUB_WEBHOOK_SECRET` the endpoint returns `404`.
- **Routing trusts only the signed (installation id, repository id).**
  - Installations not connected by an operator (`connect-github`) are ignored.
  - A new repository of a connected installation is registered on its first PR event. The installation already
    grants access, and its organization is fixed.
  - Repositories that were deactivated stay inactive.
- **Lifecycle events keep access in sync:**
  - `installation_repositories` added/removed activates or deactivates repositories;
  - `installation` deleted deactivates all repositories and soft-deletes the connection;
  - suspend deactivates the repositories only;
  - every change is audited with actor `WEBHOOK`.
- **Replay protection and idempotency:**
  - `X-GitHub-Delivery` is recorded once in `webhook_deliveries`. Redeliveries reuse the id and are reported as
    `duplicate`.
  - The job id is (provider, repository, PR, head SHA), as for GitLab.
- **Jobs carry identifiers only.** PR titles and bodies are never stored or forwarded.

## Consequences

- One secret protects all organizations, so rotating it is an App-level operation: update GitHub and the API
  environment together.
- Because routing depends on the installation id, an installation can belong to only one organization.
  `saveGitHubConnection` enforces this.
- Auto-registration means a repository added to an "all repositories" installation is reviewed without
  operator action. Operators who want opt-in should install the App on selected repositories only.
