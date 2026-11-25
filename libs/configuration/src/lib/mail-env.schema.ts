import * as z from 'zod';

const booleanFlag = z.enum(['true', 'false', '1', '0']).transform((value) => value === 'true' || value === '1');

/**
 * Transactional mail (ADR-040). Everything is optional: without MAIL_SMTP_URL mail is disabled and the
 * platform behaves as before (copyable links, operator resets). Secrets are never echoed in errors.
 */
export const MailEnvSchema = z.object({
  /** `smtp://` (STARTTLS) or `smtps://` (implicit TLS), optionally with credentials. */
  MAIL_SMTP_URL: z.url({ protocol: /^smtps?$/, error: 'must be an smtp:// or smtps:// URL' }).optional(),
  /** Sender, `noreply@example.com` or `AI Code Review <noreply@example.com>`. */
  MAIL_FROM: z.string().min(3).max(320).optional(),
  MAIL_REPLY_TO: z.string().min(3).max(320).optional(),
  /**
   * Refuse to send over a connection that does not upgrade to TLS (smtp:// without STARTTLS).
   * Mail carries single-use sign-in links, so this stays on except for a local catcher such as Mailpit.
   */
  MAIL_REQUIRE_TLS: booleanFlag.default(true),
});
export type MailEnv = z.infer<typeof MailEnvSchema>;

export interface MailboxSetting {
  readonly address: string;
  readonly name?: string;
}

export interface MailSettings {
  readonly smtpUrl: string;
  readonly from: MailboxSetting;
  readonly replyTo?: MailboxSetting;
  readonly requireTls: boolean;
}

const EMAIL = z.email();

/** Parses `addr@example.com` or `Display Name <addr@example.com>`; null when malformed. */
export function parseMailbox(value: string): MailboxSetting | null {
  const trimmed = value.trim();
  const named = /^(.*?)\s*<([^<>\s]+)>$/.exec(trimmed);
  const address = (named ? named[2] : trimmed) ?? '';
  const name = named?.[1]?.replace(/^"(.*)"$/, '$1').trim();
  if (!EMAIL.safeParse(address).success || /[\r\n]/.test(trimmed)) return null;
  return name ? { address, name } : { address };
}

/** Resolves mail settings, or null when mail is not configured. Throws on partial configuration. */
export function resolveMailSettings(env: MailEnv): MailSettings | null {
  if (!env.MAIL_SMTP_URL) {
    if (env.MAIL_FROM || env.MAIL_REPLY_TO) {
      throw new Error('Mail is partially configured: MAIL_FROM is set but MAIL_SMTP_URL is not');
    }
    return null;
  }
  if (!env.MAIL_FROM) throw new Error('Mail is partially configured: set MAIL_FROM together with MAIL_SMTP_URL');
  const from = parseMailbox(env.MAIL_FROM);
  if (!from) throw new Error('MAIL_FROM must be an address or "Name <address>"');
  const replyTo = env.MAIL_REPLY_TO ? parseMailbox(env.MAIL_REPLY_TO) : undefined;
  if (replyTo === null) throw new Error('MAIL_REPLY_TO must be an address or "Name <address>"');
  return {
    smtpUrl: env.MAIL_SMTP_URL,
    from,
    ...(replyTo ? { replyTo } : {}),
    requireTls: env.MAIL_REQUIRE_TLS,
  };
}
