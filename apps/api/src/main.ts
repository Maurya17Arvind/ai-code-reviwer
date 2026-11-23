import 'reflect-metadata';
import { ConfigValidationError, loadDotEnvFile, loadEnv } from '@acra/configuration';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app/app.module';
import { ApiConfigSchema } from './app/api-config';
import { APP_OPTIONS, configureApp, GLOBAL_PREFIX } from './app/configure-app';

async function bootstrap(): Promise<void> {
  loadDotEnvFile();
  const config = loadEnv(ApiConfigSchema);

  const app = await NestFactory.create(AppModule.forRoot(config), APP_OPTIONS);
  configureApp(app, config);
  await app.listen(config.API_PORT, config.API_HOST);

  // `nx serve` waits for this signal before reporting the server as ready.
  if (process.env['NX_READY_SIGNAL_SOCKET']) {
    try {
      // Function keeps bundlers from rewriting the dynamic import.
      const load = new Function('s', 'return import(s)') as (
        s: string,
      ) => Promise<{ emitReadySignal(server: unknown): boolean }>;
      (await load('@nx/js/ready-signal')).emitReadySignal(app.getHttpServer());
    } catch {
      // @nx/js not available (e.g. production image)
    }
  }

  app.get(Logger).log(`API listening on http://${config.API_HOST}:${config.API_PORT}/${GLOBAL_PREFIX}`, 'Bootstrap');
}

bootstrap().catch((error: unknown) => {
  if (error instanceof ConfigValidationError) {
    console.error(error.message);
  } else {
    console.error('API failed to start', error);
  }
  process.exit(1);
});
