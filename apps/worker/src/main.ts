import 'reflect-metadata';
import { ConfigValidationError, loadDotEnvFile, loadEnv } from '@acra/configuration';
import { disableThirdPartyTracing } from '@acra/agent-core';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { WorkerModule } from './app/worker.module';
import { WorkerConfigSchema } from './app/worker-config';

async function bootstrap(): Promise<void> {
  loadDotEnvFile();
  const config = loadEnv(WorkerConfigSchema);
  const tracingWarning = disableThirdPartyTracing();

  const app = await NestFactory.createApplicationContext(WorkerModule.forRoot(config), { bufferLogs: true });
  const logger = app.get(Logger);
  app.useLogger(logger);
  // SIGINT/SIGTERM → Nest shutdown hooks → BullMQ workers finish their current job and close.
  app.enableShutdownHooks();
  await app.init();
  if (tracingWarning) logger.warn(tracingWarning, 'Bootstrap');
  logger.log('Worker started; consuming queues', 'Bootstrap');
}

bootstrap().catch((error: unknown) => {
  if (error instanceof ConfigValidationError) {
    console.error(error.message);
  } else {
    console.error('Worker failed to start', error);
  }
  process.exit(1);
});
