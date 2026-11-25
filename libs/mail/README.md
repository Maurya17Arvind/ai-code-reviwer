# @acra/mail

Transactional mail for the platform (ADR-040, Phase 9):

- `Mailer` port and `MailDeliveryError`, which says whether a retry can help.
- `SmtpMailer`: nodemailer over `smtp://` / `smtps://`, one connection per message, no file or URL access while
  composing.
- Templates (`passwordResetMail`, `signupVerificationMail`, `accountExistsMail`, `invitationMail`) that render a
  subject, plain text and HTML. Every interpolated value is escaped and only absolute http(s) links are accepted.
- `RecordingMailer`: an in-memory test double.

Messages are sent by the worker only. API code enqueues ids and never handles tokens or addresses for mail.
