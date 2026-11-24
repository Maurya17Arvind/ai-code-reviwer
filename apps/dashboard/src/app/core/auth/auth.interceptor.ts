import { HttpErrorResponse, type HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { Router } from '@angular/router';
import { CSRF_HEADER } from '@acra/shared-contracts';
import { catchError, throwError } from 'rxjs';
import { API_BASE_URL } from '../api/health-api';
import { SessionStore } from './session.store';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * For requests to our API only: send cookies, attach the session's CSRF token to writes, and on
 * 401 drop the in-memory session and send the user to the sign-in page (keeping where they were).
 */
export const authInterceptor: HttpInterceptorFn = (request, next) => {
  const baseUrl = inject(API_BASE_URL);
  if (!request.url.startsWith(baseUrl)) return next(request);
  const session = inject(SessionStore);
  const router = inject(Router);

  const csrf = session.csrfToken();
  const prepared = request.clone({
    withCredentials: true,
    ...(csrf && !SAFE_METHODS.has(request.method) ? { setHeaders: { [CSRF_HEADER]: csrf } } : {}),
  });

  return next(prepared).pipe(
    catchError((error: unknown) => {
      const isAuthCall = request.url.includes('/v1/auth/');
      if (error instanceof HttpErrorResponse && error.status === 401 && !isAuthCall) {
        session.markSignedOut();
        void router.navigate(['/login'], { queryParams: { returnUrl: router.url } });
      }
      return throwError(() => error);
    }),
  );
};
