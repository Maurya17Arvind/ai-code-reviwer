import { RateLimit } from '../common/rate-limit/rate-limit.service';
import { Public } from '../auth/auth-context';
import { type LivenessResponse, type ReadinessResponse } from '@acra/shared-contracts';
import { Controller, Get, Header, HttpStatus, Inject, Res } from '@nestjs/common';
import { type Response } from 'express';
import { HealthService } from './health.service';

/**
 * Unauthenticated probes for orchestrators and load balancers.
 * They expose only coarse up/down status — never versions, hosts or error details.
 */
@Public()
@RateLimit('none')
@Controller('health')
export class HealthController {
  constructor(@Inject(HealthService) private readonly health: HealthService) {}

  @Get('live')
  @Header('Cache-Control', 'no-store')
  live(): LivenessResponse {
    return { status: 'ok', timestamp: new Date().toISOString() };
  }

  @Get('ready')
  @Header('Cache-Control', 'no-store')
  async ready(@Res({ passthrough: true }) response: Response): Promise<ReadinessResponse> {
    const result = await this.health.readiness();
    if (result.status !== 'ok') {
      response.status(HttpStatus.SERVICE_UNAVAILABLE);
    }
    return result;
  }
}
