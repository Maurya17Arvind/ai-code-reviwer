import { Public } from '../auth/auth-context';
import { Body, Controller, Headers, HttpCode, Inject, Param, Post, Res } from '@nestjs/common';
import { type Response } from 'express';
import { GitLabWebhookService, type WebhookResult } from './gitlab-webhook.service';

/**
 * POST /api/webhooks/gitlab/:repositoryId — configured as a GitLab project hook by the admin
 * `connect-gitlab` command. 202 when a review was queued, 200 when ignored/duplicate, 401 otherwise.
 */
@Public()
@Controller('webhooks/gitlab')
export class GitLabWebhookController {
  constructor(@Inject(GitLabWebhookService) private readonly webhooks: GitLabWebhookService) {}

  @Post(':repositoryId')
  @HttpCode(200)
  async receive(
    @Param('repositoryId') repositoryId: string,
    @Headers('x-gitlab-token') token: string | undefined,
    @Headers('x-gitlab-event') event: string | undefined,
    @Headers('x-gitlab-event-uuid') deliveryId: string | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ): Promise<WebhookResult> {
    const result = await this.webhooks.handle(repositoryId, { token, event, deliveryId }, body);
    if (result.status === 'queued') response.status(202);
    return result;
  }
}
