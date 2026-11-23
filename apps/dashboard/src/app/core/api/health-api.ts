import { HttpClient, HttpErrorResponse, HttpStatusCode } from '@angular/common/http';
import { inject, Injectable, InjectionToken } from '@angular/core';
import { type ReadinessResponse, ReadinessResponseSchema } from '@acra/shared-contracts';
import { catchError, map, type Observable, of, throwError } from 'rxjs';

/** Base path of the backend API. In development `/api` is proxied to the NestJS server. */
export const API_BASE_URL = new InjectionToken<string>('API_BASE_URL', { factory: () => '/api' });

@Injectable({ providedIn: 'root' })
export class HealthApi {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = inject(API_BASE_URL);

  /**
   * Readiness of the backend. A 503 still carries a valid readiness body (dependencies down),
   * so it is mapped to data rather than treated as a transport error. Responses are validated
   * against the shared contract — the UI never trusts unvalidated payloads.
   */
  readiness(): Observable<ReadinessResponse> {
    return this.http.get<unknown>(`${this.baseUrl}/health/ready`).pipe(
      catchError((error: unknown) =>
        error instanceof HttpErrorResponse && error.status === HttpStatusCode.ServiceUnavailable
          ? of(error.error as unknown)
          : throwError(() => error),
      ),
      map((body) => ReadinessResponseSchema.parse(body)),
    );
  }
}
