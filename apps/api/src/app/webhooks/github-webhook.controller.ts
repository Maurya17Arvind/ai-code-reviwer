import { RateLimit } from '../common/rate-limit/rate-limit.service';
import { Public } from '../auth/auth-context';
import { Controller, Headers, HttpCode, Inject, Post, type RawBodyRequest, Req, Res } from '@nestjs/common';
import { type Request, type Response } from 'express';
import { GitHubWebhookService } from './github-webhook.service';
import { type WebhookResult } from './gitlab-webhook.service';

/**
 * POST /api/webhooks/github — the GitHub App's webhook URL. The signature is verified over the raw
 * request bytes (the app is created with `rawBody: true`). 202 when a review was queued, 200 when
 * ignored/duplicate, 401 for a bad signature, 404 when GitHub is not configured.
 */
@Public()
@RateLimit('webhook')
@Controller('webhooks/github')
export class GitHubWebhookController {
  constructor(@Inject(GitHubWebhookService) private readonly webhooks: GitHubWebhookService) {}

  @Post()
  @HttpCode(200)
  async receive(
    @Headers('x-hub-signature-256') signature: string | undefined,
    @Headers('x-github-event') event: string | undefined,
    @Headers('x-github-delivery') deliveryId: string | undefined,
    @Req() request: RawBodyRequest<Request>,
    @Res({ passthrough: true }) response: Response,
  ): Promise<WebhookResult> {
    const result = await this.webhooks.handle({ signature, event, deliveryId }, request.rawBody);
    if (result.status === 'queued') response.status(202);
    return result;
  }
}
