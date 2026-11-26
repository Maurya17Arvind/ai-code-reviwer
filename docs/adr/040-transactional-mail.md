# ADR-040: Transactional mail over SMTP, with tokens minted by the worker

**Status:** Proposed (Phase 9) · 2026-11-25

## Context

The SaaS roadmap (PROJECT_PLAN §14) needs e-mail for sign-up verification, password resets and invitations.
ADR-035 deliberately had no mail: invitation and reset links are shown once to an admin, who shares them by hand.
That made password resets an operator action, because a reset link issued to an organization admin could take
over an account that also belongs to other organizations.

Mail links carry single-use bearer tokens. Today such a token exists in plain form only in the API response
that shows it. Only its SHA-256 is stored. Moving delivery to a background job must not weaken that.

## Decision

- **SMTP only, provider-neutral.**
  - The platform speaks SMTP through a `Mailer` port in `@acra/mail`, with a nodemailer adapter (10.6.1, pinned
    exactly, no runtime dependencies).
  - Any relay works: SES, Postmark, Resend, SendGrid or a company relay. No provider SDK or provider-specific
    webhooks are adopted in this phase.
  - Configuration: `MAIL_SMTP_URL` (an `smtp://` or `smtps://` URL; credentials are redacted in logs), `MAIL_FROM`
    and an optional `MAIL_REPLY_TO`.
  - Mail is **disabled** when `MAIL_SMTP_URL` is unset. Self-hosted installations then behave exactly as in
    Phase 8.
- **Sending happens in the worker, from ids only.**
  - The API enqueues a `mail` job containing a purpose (`password_reset`, `signup_verification`, `invitation`,
    `account_exists`) and record ids. It never contains a token, a link or an e-mail address.
  - The worker re-loads the records and checks that the purpose still applies. For example, a reset for a
    deleted user is dropped.
  - The worker then **mints the single-use token itself**, stores only its hash, renders the message and sends
    it. The raw token exists only in worker memory and in the delivered e-mail; never in Redis, the database or
    logs.
  - A retried job mints a new token and voids the previous unused one for the same purpose. At most one link
    per purpose is valid at a time.
- **Templates are code, not data.**
  - Each message is a typed function that returns a subject, plain text and HTML.
  - Every interpolated value is HTML-escaped in the HTML part. Display and organization names are
    attacker-controlled.
  - Links are built only from `DASHBOARD_PUBLIC_URL` and a token, never from request headers, which would allow host
    header injection.
  - Header values (subject, display name in `To`) are stripped of CR/LF.
- **Delivery semantics.**
  - BullMQ retries with exponential backoff for transient SMTP failures (connection errors, timeouts, 4xx
    replies). Only a 5xx reply that rejects the message or recipient (`RCPT`, `DATA`) is permanent and not
    retried. A 5xx to `AUTH` or `MAIL FROM` means misconfiguration, which an operator can fix, so it is retried.
  - Each attempt's outcome is counted in metrics (`acra_mail_messages_total{purpose,outcome}`, outcome = sent, skipped, retry or failed). The final
    outcome is audited, without the address or the token.
- **Implementation details (Phase 9 step 2).**
  - Queue `mail`, job `send-mail`, payload `{ purpose, userId, correlationId, requestId }` validated as a strict
    object by the producer and again by the worker. Up to 6 attempts with exponential backoff from 15 s.
  - Reset links are valid for **2 hours**. Invitation links keep 72 hours.
  - The worker needs `DASHBOARD_PUBLIC_URL` when mail is configured and refuses to start without it.
  - Mail audit entries have the platform as actor and the user as target, never the user as actor.
- **Local development** uses Mailpit (`axllent/mailpit:v1.34.0`), bound to 127.0.0.1, with a web inbox to follow
  links.

## Consequences

- One new runtime dependency (nodemailer). It has no transitive dependencies.
- Account recovery no longer needs an operator once mail is configured. ADR-035's operator-only reset remains the
  fallback without mail.
- Users get mail only after the worker processes the job. A queue outage delays mail but loses nothing: jobs
  persist in Redis.
- Deliverability (SPF, DKIM, DMARC, a sending domain) is an operator responsibility. DEPLOYMENT.md documents it.
- Bounce and complaint handling would need provider-specific webhooks and is out of scope for Phase 9.
