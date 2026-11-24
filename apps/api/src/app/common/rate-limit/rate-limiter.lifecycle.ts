import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { RATE_LIMITER } from './rate-limit.service';
import { type RateLimiter } from './rate-limiter';

/** Closes the rate limiter's Redis connection on shutdown. */
@Injectable()
export class RateLimiterLifecycle implements OnApplicationShutdown {
  constructor(@Inject(RATE_LIMITER) private readonly limiter: RateLimiter) {}

  async onApplicationShutdown(): Promise<void> {
    await this.limiter.close();
  }
}
