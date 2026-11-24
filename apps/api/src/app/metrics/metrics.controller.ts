import { bearerMatches } from '@acra/observability';
import { Controller, Get, Header, Headers, Inject, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { API_CONFIG, type ApiConfig } from '../api-config';
import { Public } from '../auth/auth-context';
import { RateLimit } from '../common/rate-limit/rate-limit.service';
import { ApiMetrics } from './api-metrics';

/**
 * Prometheus scrape endpoint. Disabled (404) unless METRICS_TOKEN is set; scrapers send it as a
 * bearer token. Metrics contain no tenant data, only counts by route template and status.
 */
@Public()
@RateLimit('none')
@Controller('metrics')
export class MetricsController {
  constructor(
    @Inject(ApiMetrics) private readonly metrics: ApiMetrics,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  @Get()
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  async scrape(@Headers('authorization') authorization: string | undefined): Promise<string> {
    if (!this.config.METRICS_TOKEN) throw new NotFoundException();
    if (!bearerMatches(authorization, this.config.METRICS_TOKEN))
      throw new UnauthorizedException('Invalid metrics token');
    return this.metrics.registry.render();
  }
}
