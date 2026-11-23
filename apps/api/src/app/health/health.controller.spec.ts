import { type ReadinessResponse } from '@acra/shared-contracts';
import { type Response } from 'express';
import { HealthController } from './health.controller';
import { type HealthService } from './health.service';

function controllerReturning(result: ReadinessResponse) {
  const service = { readiness: () => Promise.resolve(result) } as unknown as HealthService;
  return new HealthController(service);
}

function fakeResponse() {
  const response = { statusCode: 200, status: vi.fn() };
  response.status.mockImplementation((code: number) => {
    response.statusCode = code;
    return response;
  });
  return response;
}

describe('HealthController', () => {
  it('returns liveness without touching dependencies', () => {
    const controller = controllerReturning({ status: 'ok', timestamp: new Date().toISOString(), checks: [] });
    expect(controller.live().status).toBe('ok');
  });

  it('keeps 200 when ready', async () => {
    const response = fakeResponse();
    const controller = controllerReturning({ status: 'ok', timestamp: new Date().toISOString(), checks: [] });
    await controller.ready(response as unknown as Response);
    expect(response.status).not.toHaveBeenCalled();
  });

  it('sets 503 when not ready', async () => {
    const response = fakeResponse();
    const controller = controllerReturning({
      status: 'unavailable',
      timestamp: new Date().toISOString(),
      checks: [{ name: 'redis', status: 'down', latencyMs: 5, reason: 'error' }],
    });
    const body = await controller.ready(response as unknown as Response);
    expect(response.statusCode).toBe(503);
    expect(body.status).toBe('unavailable');
  });
});
