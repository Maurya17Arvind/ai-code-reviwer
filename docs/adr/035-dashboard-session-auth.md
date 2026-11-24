# ADR-035: Dashboard authentication with server-side sessions

**Status:** Accepted · 2026-11-24

## Context

Phase 7 adds the Angular dashboard. Until now there was no user authentication: management happened through the
operator CLI on the server. The dashboard must sign people in, authorize every request by organization membership
and role, and never expose provider secrets. There is no e-mail service, and no SSO provider has been chosen yet.

## Decision

- **Password sign-in, verified server-side.**
  - Passwords are hashed with **scrypt** from `node:crypto` (N=2^17, r=8, p=1, 16-byte salt). This is the OWASP
    minimum for scrypt and needs no native dependency.
  - Each hash records its own parameters, and hashes made with weaker parameters are upgraded at the next sign-in.
  - Passwords are NFKC-normalised. The policy is 12 to 200 characters, with no composition rules (NIST 800-63B).
- **Server-side sessions, not JWTs.**
  - A 32-byte random token goes in an `HttpOnly; SameSite=Strict; Path=/` cookie (`__Host-acra_session` and `Secure` in
    production). Only its SHA-256 is stored, in `user_sessions`.
  - Sessions have an absolute TTL (`SESSION_TTL_HOURS`, default 12) and an idle timeout (`SESSION_IDLE_MINUTES`,
    default 120).
  - Logout and password changes revoke sessions immediately, which stateless tokens could not do.
- **CSRF.**
  - SameSite=Strict is backed by a session-bound token: `SHA-256("acra-csrf:v1:" + sessionToken)`.
  - The token is returned in the session response and must be sent in `X-CSRF-Token` on every non-GET request.
  - The login endpoint accepts JSON only, so a cross-site form cannot post to it.
- **Deny by default.**
  - `SessionGuard` is a global guard, and only routes marked `@Public()` are open: health, webhooks, login and password
    setup.
  - `OrganizationGuard` resolves `:orgId` to the caller's role. Non-members get **404**, so the organization's existence
    is not disclosed; insufficient roles get **403**.
  - The approvals state machine still enforces its own role rules independently.
- **Brute-force protection** (amended in Phase 8, see SECURITY.md §2g).
  - ~~After 5 consecutive failures an account is locked for 15 minutes.~~ The account-wide lock was removed:
    anyone could keep a victim locked out. Attempts are now limited per client IP (30 per 15 minutes) and per
    (account, client IP) (5 per 15 minutes), cluster-wide in Redis (ADR-037).
  - Unknown e-mails are verified against a dummy hash, so responses do not reveal which accounts exist.
- **Setup links** (amended in Phase 8): organization admins can only issue invitation links for users who never set
  a password and belong to no other organization. Resetting an existing account's password is an operator
  action until e-mail delivery exists; otherwise the admin of any organization could take over that account.
- **Onboarding without e-mail.**
  - Admins invite people from the dashboard, and the API returns a **single-use setup link** valid for 72 hours. Only
    the token's hash is stored, and issuing a new link voids the older ones.
  - The token travels in the URL fragment (`#token=`), so it never reaches servers, logs or `Referer` headers. The
    dashboard removes it from the address bar immediately.
  - The operator CLI bootstraps the first user with `users-create`, `users-setup-link` and `users-set-password`. The
    latter reads `ACRA_NEW_PASSWORD`, never argv.
- **Role rules for members.**
  - ADMIN and OWNER manage members, and only an OWNER can grant or touch the OWNER role.
  - Nobody edits their own membership.
  - The last OWNER cannot be removed or demoted. A serializable transaction enforces this in the store.
- **Audit.** Sign-in, failed sign-in, logout and password changes are audited at platform level, and every
  organization change at organization level, each with request id and client IP.

## Consequences

- No new dependencies. Sessions cost one indexed lookup per request (the `last_seen_at` write is throttled to once a
  minute).
- The in-memory attempt limits are per instance. Cluster-wide rate limiting is Phase 8; the database lockout already
  works across instances.
- SSO (OIDC, GitLab or GitHub login) can be added later as another way to create the same server-side session.
- The dashboard keeps the session only in memory, with nothing in localStorage, so reloading the page asks the API
  again.
