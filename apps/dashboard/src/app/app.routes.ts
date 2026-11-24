import { type Route } from '@angular/router';
import { authGuard, guestGuard, homeRedirectGuard, organizationGuard } from './core/auth/guards';

const title = (page: string) => `${page} · AI Code Review`;

/** Every feature is lazy-loaded (route-level code splitting). */
export const appRoutes: Route[] = [
  {
    path: 'login',
    title: title('Sign in'),
    canActivate: [guestGuard],
    loadComponent: () => import('./features/auth/login-page').then((m) => m.LoginPage),
  },
  {
    path: 'setup-password',
    title: title('Choose a password'),
    loadComponent: () => import('./features/auth/setup-password-page').then((m) => m.SetupPasswordPage),
  },
  {
    path: '',
    canActivate: [authGuard],
    loadComponent: () => import('./features/shell/shell').then((m) => m.Shell),
    children: [
      { path: '', pathMatch: 'full', canActivate: [homeRedirectGuard], children: [] },
      {
        path: 'organizations/new',
        title: title('New organization'),
        loadComponent: () =>
          import('./features/organizations/create-organization-page').then((m) => m.CreateOrganizationPage),
      },
      {
        path: 'account',
        title: title('Account'),
        loadComponent: () => import('./features/auth/account-page').then((m) => m.AccountPage),
      },
      {
        path: 'system-status',
        title: title('System status'),
        loadComponent: () => import('./features/system-status/system-status').then((m) => m.SystemStatusPage),
      },
      {
        path: 'o/:orgId',
        canActivate: [organizationGuard],
        loadComponent: () => import('./features/organization/org-layout').then((m) => m.OrgLayout),
        loadChildren: () => import('./features/organization/organization.routes').then((m) => m.organizationRoutes),
      },
    ],
  },
  {
    path: '**',
    title: title('Not found'),
    loadComponent: () => import('./features/not-found/not-found').then((m) => m.NotFoundPage),
  },
];
