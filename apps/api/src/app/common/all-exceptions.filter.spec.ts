import { ApiErrorSchema } from '@acra/shared-contracts';
import {
  type ArgumentsHost,
  BadRequestException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { AllExceptionsFilter } from './all-exceptions.filter';

function hostWith(request: object) {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  const host = {
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }),
  } as unknown as ArgumentsHost;
  return { host, response };
}

describe('AllExceptionsFilter', () => {
  const filter = new AllExceptionsFilter();

  it('maps HTTP exceptions to the ApiError envelope with the request id', () => {
    const { host, response } = hostWith({ id: 'req-12345678' });
    filter.catch(new NotFoundException('Repository not found'), host);
    expect(response.status).toHaveBeenCalledWith(404);
    const body = response.json.mock.calls[0]?.[0];
    expect(ApiErrorSchema.parse(body)).toEqual({
      statusCode: 404,
      error: 'Not Found',
      message: 'Repository not found',
      requestId: 'req-12345678',
    });
  });

  it('joins validation message arrays', () => {
    const { host, response } = hostWith({});
    filter.catch(new BadRequestException(['name is required', 'slug is invalid']), host);
    expect(response.json.mock.calls[0]?.[0]).toMatchObject({
      statusCode: 400,
      message: 'name is required; slug is invalid',
    });
  });

  it('hides details of unexpected errors', () => {
    const { host, response } = hostWith({});
    filter.catch(new Error('duplicate key value violates unique constraint "users_email_key"'), host);
    expect(response.status).toHaveBeenCalledWith(500);
    const body = response.json.mock.calls[0]?.[0];
    expect(body).toEqual({ statusCode: 500, error: 'Internal Server Error', message: 'An unexpected error occurred.' });
  });

  it('hides messages of 5xx HttpExceptions as well', () => {
    const { host, response } = hostWith({});
    filter.catch(new InternalServerErrorException('pool exhausted at 10.0.0.5'), host);
    expect(JSON.stringify(response.json.mock.calls[0]?.[0])).not.toContain('10.0.0.5');
  });
});
