import { createLoggerOptions } from './logger-options';

describe('createLoggerOptions', () => {
  it('enables redaction and JSON output outside development', () => {
    const options = createLoggerOptions({ service: 'api', level: 'info', nodeEnv: 'production' });
    expect(options.redact.paths).toContain('req.headers.authorization');
    expect(options).not.toHaveProperty('transport');
    expect(options.base).toEqual({ service: 'api' });
  });

  it('uses pretty output in development', () => {
    const options = createLoggerOptions({ service: 'worker', level: 'debug', nodeEnv: 'development' });
    expect(options).toHaveProperty('transport.target', 'pino-pretty');
  });
});
