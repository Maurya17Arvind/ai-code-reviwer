import { singleLine } from './mailer';

/** Subject and bodies of a message; the recipient is added by the caller. */
export interface RenderedMail {
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

export const PRODUCT_NAME = 'AI Code Review';

/** Escapes text for HTML element content and double-quoted attribute values. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Only absolute http(s) links are ever placed in a message. Links are built by the platform from
 * DASHBOARD_URL; this is a last line of defence against a `javascript:` or relative URL slipping in.
 */
export function assertSafeLink(link: string): string {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    throw new Error('Mail link is not an absolute URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Mail link must use http or https');
  return url.toString();
}

/**
 * Names come from users (display names, organization names) and are untrusted. In plain text they are
 * kept on one line and shortened, so they cannot fake extra paragraphs or links; in HTML they are
 * additionally escaped.
 */
function plainName(value: string, max = 80): string {
  const line = singleLine(value);
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function hours(value: number): string {
  return value === 1 ? '1 hour' : `${value} hours`;
}

interface Layout {
  readonly subject: string;
  readonly greeting: string;
  /** Paragraphs of plain text; escaped for HTML here. */
  readonly paragraphs: readonly string[];
  readonly action?: { readonly label: string; readonly url: string };
  /** Small print below the button. */
  readonly footnote: string;
}

// Brand palette (dashboard styles.scss): navy text on cream, Eden primary action, Mauve rule.
const NAVY = '#0D0129';
const CREAM = '#FFFCF7';
const EDEN = '#19615C';
const MUTED = '#5C5470';
const MAUVE = '#BE8276';

function render(layout: Layout): RenderedMail {
  const action = layout.action ? { label: layout.action.label, url: assertSafeLink(layout.action.url) } : null;

  const text = [
    layout.greeting,
    '',
    ...layout.paragraphs.flatMap((p) => [p, '']),
    ...(action ? [`${action.label}:`, action.url, ''] : []),
    layout.footnote,
    '',
    `— ${PRODUCT_NAME}`,
  ].join('\n');

  const p = (content: string) => `<p style="margin:0 0 16px">${escapeHtml(content)}</p>`;
  const button = action
    ? `<p style="margin:24px 0"><a href="${escapeHtml(action.url)}" style="display:inline-block;padding:12px 20px;border-radius:8px;background:${EDEN};color:${CREAM};text-decoration:none;font-weight:600">${escapeHtml(action.label)}</a></p>
<p style="margin:0 0 16px;font-size:13px;color:${MUTED}">If the button does not work, copy this link into your browser:<br><span style="word-break:break-all">${escapeHtml(action.url)}</span></p>`
    : '';

  const html = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(layout.subject)}</title></head>
<body style="margin:0;padding:24px 12px;background:${CREAM};color:${NAVY};font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.55">
<div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #EBE3D7;border-radius:12px;padding:32px">
<p style="margin:0 0 24px;font-weight:700;font-size:16px">${escapeHtml(PRODUCT_NAME)}</p>
${p(layout.greeting)}
${layout.paragraphs.map(p).join('\n')}
${button}
<hr style="border:none;border-top:2px solid ${MAUVE};margin:24px 0;opacity:.5">
<p style="margin:0;font-size:13px;color:${MUTED}">${escapeHtml(layout.footnote)}</p>
</div>
</body>
</html>`;

  return { subject: singleLine(layout.subject), text, html };
}

export interface PasswordResetMail {
  readonly displayName: string;
  readonly link: string;
  readonly expiresInHours: number;
}

export function passwordResetMail(input: PasswordResetMail): RenderedMail {
  return render({
    subject: `Reset your ${PRODUCT_NAME} password`,
    greeting: `Hi ${plainName(input.displayName)},`,
    paragraphs: [
      `Someone asked to reset the password of your ${PRODUCT_NAME} account. If that was you, choose a new password with the link below.`,
    ],
    action: { label: 'Choose a new password', url: input.link },
    footnote: `The link works once and expires in ${hours(input.expiresInHours)}. If you did not ask for a reset, ignore this message: your password stays the same.`,
  });
}

export interface SignupVerificationMail {
  readonly displayName: string;
  readonly link: string;
  readonly expiresInHours: number;
}

export function signupVerificationMail(input: SignupVerificationMail): RenderedMail {
  return render({
    subject: `Confirm your e-mail for ${PRODUCT_NAME}`,
    greeting: `Hi ${plainName(input.displayName)},`,
    paragraphs: [
      `Thanks for signing up. Confirm that this is your e-mail address and choose a password to finish creating your account.`,
    ],
    action: { label: 'Confirm and choose a password', url: input.link },
    footnote: `The link works once and expires in ${hours(input.expiresInHours)}. If you did not sign up, ignore this message and no account will be activated.`,
  });
}

export interface AccountExistsMail {
  readonly displayName: string;
  readonly signInUrl: string;
  readonly forgotPasswordUrl: string;
}

/**
 * Sent instead of a verification mail when someone signs up with an address that already has an
 * account, so the sign-up response never reveals which addresses are registered.
 */
export function accountExistsMail(input: AccountExistsMail): RenderedMail {
  return render({
    subject: `You already have an ${PRODUCT_NAME} account`,
    greeting: `Hi ${plainName(input.displayName)},`,
    paragraphs: [
      `Someone tried to sign up with this e-mail address, but it already has an account. You can sign in as usual.`,
      `Forgot your password? Request a reset link at ${assertSafeLink(input.forgotPasswordUrl)}`,
    ],
    action: { label: 'Sign in', url: input.signInUrl },
    footnote: `If this was not you, no action is needed: nothing has changed on your account.`,
  });
}

export interface InvitationMail {
  readonly inviterName: string;
  readonly organizationName: string;
  readonly roleLabel: string;
  readonly link: string;
  readonly expiresInHours: number;
  /** True when the invitee has no account yet and will choose a password. */
  readonly newAccount: boolean;
}

export function invitationMail(input: InvitationMail): RenderedMail {
  const organization = plainName(input.organizationName);
  return render({
    subject: `Invitation to join ${organization} on ${PRODUCT_NAME}`,
    greeting: 'Hi,',
    paragraphs: [
      `${plainName(input.inviterName)} invited you to join the organization "${organization}" as ${plainName(input.roleLabel, 40)}.`,
      input.newAccount
        ? 'Accept the invitation and choose a password to create your account.'
        : 'Sign in to accept or decline the invitation.',
    ],
    action: { label: input.newAccount ? 'Accept and create account' : 'View invitation', url: input.link },
    footnote: `The invitation expires in ${hours(input.expiresInHours)}. If you were not expecting it, you can ignore this message.`,
  });
}
