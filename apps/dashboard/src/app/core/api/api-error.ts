import { HttpErrorResponse } from '@angular/common/http';
import { ApiErrorSchema } from '@acra/shared-contracts';

/**
 * Turns any HTTP or validation failure into a short message for the UI. API messages are written
 * by our backend (never raw provider output); unknown failures get a generic text.
 */
export function errorMessage(error: unknown, fallback = 'Something went wrong. Please try again.'): string {
  if (error instanceof HttpErrorResponse) {
    if (error.status === 0) return 'The server could not be reached. Check your connection and try again.';
    const parsed = ApiErrorSchema.safeParse(error.error);
    if (parsed.success && parsed.data.statusCode < 500) return parsed.data.message;
    return fallback;
  }
  return fallback;
}

export function statusOf(error: unknown): number | null {
  return error instanceof HttpErrorResponse ? error.status : null;
}
