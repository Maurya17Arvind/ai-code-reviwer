import { type ApiError } from '@acra/shared-contracts';
import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { type Request, type Response } from 'express';

/**
 * Converts every exception into the ApiError envelope.
 * Unexpected errors are logged server-side with full detail and returned as a generic 500 —
 * stack traces, SQL and driver messages never reach the client.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<Request & { id?: unknown }>();
    const response = http.getResponse<Response>();
    const requestId = typeof request.id === 'string' ? request.id : undefined;

    const body = exception instanceof HttpException ? fromHttpException(exception) : internalError();
    if (body.statusCode >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error({ err: exception, requestId }, 'Unhandled exception');
    }

    response.status(body.statusCode).json(requestId === undefined ? body : { ...body, requestId });
  }
}

function fromHttpException(exception: HttpException): ApiError {
  const statusCode = exception.getStatus();
  if (statusCode >= HttpStatus.INTERNAL_SERVER_ERROR) {
    return internalError(statusCode);
  }
  const payload = exception.getResponse();
  let message = exception.message;
  let error = HttpStatus[statusCode] ?? 'Error';
  if (typeof payload === 'object' && payload !== null) {
    const record = payload as Record<string, unknown>;
    if (typeof record['message'] === 'string') message = record['message'];
    if (Array.isArray(record['message'])) message = record['message'].map(String).join('; ');
    if (typeof record['error'] === 'string') error = record['error'];
  } else if (typeof payload === 'string') {
    message = payload;
  }
  return { statusCode, error, message };
}

function internalError(statusCode: number = HttpStatus.INTERNAL_SERVER_ERROR): ApiError {
  return { statusCode, error: 'Internal Server Error', message: 'An unexpected error occurred.' };
}
