import { type Route } from '@angular/router';

/** Every feature is lazy-loaded (route-level code splitting). */
export const appRoutes: Route[] = [
  { path: '', pathMatch: 'full', redirectTo: 'system-status' },
  {
    path: 'system-status',
    title: 'System status · AI Code Review',
    loadComponent: () => import('./features/system-status/system-status').then((m) => m.SystemStatusPage),
  },
  {
    path: '**',
    title: 'Not found · AI Code Review',
    loadComponent: () => import('./features/not-found/not-found').then((m) => m.NotFoundPage),
  },
];
