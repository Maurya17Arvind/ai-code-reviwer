import { AuthStore } from '@acra/database';
import {
  accountExistsMail,
  type MailDeliveryError,
  type Mailer,
  passwordResetMail,
  type RenderedMail,
} from '@acra/mail';
import { type MailPurpose, type SendMailJob } from '@acra/queue';
import { generateToken, hashToken } from '@acra/security';
import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { MAIL_SETTINGS, MAILER, type WorkerMailSettings } from '../worker-config';

/** Reset links are short-lived: they replace a password, and the mail may sit in an inbox for long. */
export const RESET_LINK_TTL_MS = 2 * 3_600_000;

export type MailOutcome =
  | { readonly status: 'sent'; readonly messageId: string }
  | { readonly status: 'skipped'; readonly reason: 'mail_disabled' | 'user_not_found' };

/**
 * Delivers transactional mail from ids only (ADR-040). Re-loads the user, mints any single-use token
 * here (only its hash is stored), renders the template and sends it. The raw token exists only in this
 * function and in the message; it is never logged, returned or written anywhere else.
 */
@Injectable()
export class MailDeliveryService implements OnModuleDestroy {
  private readonly logger = new Logger(MailDeliveryService.name);

  constructor(
    @Inject(AuthStore) private readonly store: AuthStore,
    @Inject(MAILER) private readonly mailer: Mailer | null,
    @Inject(MAIL_SETTINGS) private readonly settings: WorkerMailSettings | null,
  ) {}

  async deliver(job: SendMailJob, now = new Date()): Promise<MailOutcome> {
    if (!this.mailer || !this.settings) {
      // The API does not enqueue mail without configuration; a job left over from a reconfiguration is dropped.
      this.logger.warn({ purpose: job.purpose, correlationId: job.correlationId }, 'Mail is not configured');
      return this.skipped(job, 'mail_disabled');
    }
    const user = await this.store.findUserById(job.userId);
    if (!user) return this.skipped(job, 'user_not_found');

    const content = await this.render(job.purpose, user, this.settings, now);
    const receipt = await this.mailer.send({ to: { address: user.email, name: user.displayName }, ...content });
    await this.store.audit({
      action: 'mail.sent',
      userId: user.id,
      actor: 'system',
      requestId: job.requestId,
      metadata: { purpose: job.purpose, correlationId: job.correlationId, messageId: receipt.messageId },
    });
    this.logger.log({ purpose: job.purpose, correlationId: job.correlationId }, 'Mail sent');
    return { status: 'sent', messageId: receipt.messageId };
  }

  /** Audits a delivery that will not be retried (permanent rejection or retries exhausted). */
  async recordFailure(job: SendMailJob, error: MailDeliveryError): Promise<void> {
    await this.store.audit({
      action: 'mail.failed',
      userId: job.userId,
      actor: 'system',
      requestId: job.requestId,
      metadata: {
        purpose: job.purpose,
        correlationId: job.correlationId,
        permanent: error.permanent,
        reason: error.message,
      },
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.mailer?.close();
  }

  private async render(
    purpose: MailPurpose,
    user: { id: string; displayName: string },
    settings: WorkerMailSettings,
    now: Date,
  ): Promise<RenderedMail> {
    switch (purpose) {
      case 'password_reset': {
        // Minting voids every earlier unused link of this user, so at most one link works at a time,
        // and a retried job never leaves two valid links behind.
        const token = generateToken();
        await this.store.createSetupToken({
          userId: user.id,
          tokenHash: hashToken(token),
          purpose: 'RESET',
          createdById: null,
          expiresAt: new Date(now.getTime() + RESET_LINK_TTL_MS),
          now,
        });
        return passwordResetMail({
          displayName: user.displayName,
          // Token in the fragment: never sent to servers, proxies or Referer headers (ADR-035).
          link: `${settings.dashboardUrl}/setup-password#token=${token}`,
          expiresInHours: RESET_LINK_TTL_MS / 3_600_000,
        });
      }
      case 'account_exists':
        return accountExistsMail({
          displayName: user.displayName,
          signInUrl: `${settings.dashboardUrl}/login`,
          forgotPasswordUrl: `${settings.dashboardUrl}/forgot-password`,
        });
    }
  }

  private async skipped(job: SendMailJob, reason: 'mail_disabled' | 'user_not_found'): Promise<MailOutcome> {
    await this.store.audit({
      action: 'mail.skipped',
      userId: reason === 'user_not_found' ? null : job.userId,
      actor: 'system',
      requestId: job.requestId,
      // An unknown user cannot be referenced as the audit target; keep the id in the metadata instead.
      metadata: {
        purpose: job.purpose,
        correlationId: job.correlationId,
        reason,
        ...(reason === 'user_not_found' ? { userId: job.userId } : {}),
      },
    });
    return { status: 'skipped', reason };
  }
}
