import { inject } from '@angular/core';
import { type CanActivateFn, Router } from '@angular/router';
import { SessionStore } from './session.store';

/** Signed-in users only; others go to /login and come back afterwards. */
export const authGuard: CanActivateFn = async (_route, state) => {
  const session = inject(SessionStore);
  const router = inject(Router);
  return (await session.ensureLoaded())
    ? true
    : router.createUrlTree(['/login'], { queryParams: { returnUrl: state.url } });
};

/** Sign-in and setup pages: a signed-in user is sent to the dashboard instead. */
export const guestGuard: CanActivateFn = async () => {
  const session = inject(SessionStore);
  const router = inject(Router);
  return (await session.ensureLoaded()) ? router.createUrlTree(['/']) : true;
};

/**
 * `/o/:orgId/...`: the user must be a member. This is a UX check only; the API enforces
 * membership and roles on every request.
 */
export const organizationGuard: CanActivateFn = async (route) => {
  const session = inject(SessionStore);
  const router = inject(Router);
  await session.ensureLoaded();
  const orgId = route.paramMap.get('orgId') ?? '';
  return session.membership(orgId) ? true : router.createUrlTree(['/'], { queryParams: { notFound: 1 } });
};

/** `/` → first organization, or the "create organization" page for new users. */
export const homeRedirectGuard: CanActivateFn = async () => {
  const session = inject(SessionStore);
  const router = inject(Router);
  await session.ensureLoaded();
  const first = session.memberships()[0];
  return router.createUrlTree(first ? ['/o', first.organizationId] : ['/organizations/new']);
};
