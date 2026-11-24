import { type Route } from '@angular/router';

const title = (page: string) => `${page} · AI Code Review`;

/** Routes under `/o/:orgId`. Each page is its own lazy chunk. */
export const organizationRoutes: Route[] = [
  {
    path: '',
    pathMatch: 'full',
    title: title('Overview'),
    loadComponent: () => import('../analytics/overview-page').then((m) => m.OverviewPage),
  },
  {
    path: 'reviews',
    title: title('Reviews'),
    loadComponent: () => import('../reviews/reviews-page').then((m) => m.ReviewsPage),
  },
  {
    path: 'reviews/:reviewId',
    title: title('Review'),
    loadComponent: () => import('../reviews/review-detail-page').then((m) => m.ReviewDetailPage),
  },
  {
    path: 'findings',
    title: title('Findings'),
    loadComponent: () => import('../findings/findings-page').then((m) => m.FindingsPage),
  },
  {
    path: 'findings/:findingId',
    title: title('Finding'),
    loadComponent: () => import('../findings/finding-detail-page').then((m) => m.FindingDetailPage),
  },
  {
    path: 'fixes',
    title: title('Fix proposals'),
    loadComponent: () => import('../fixes/fixes-page').then((m) => m.FixesPage),
  },
  {
    path: 'fixes/:fixId',
    title: title('Fix proposal'),
    loadComponent: () => import('../fixes/fix-detail-page').then((m) => m.FixDetailPage),
  },
  {
    path: 'approvals',
    title: title('Approvals'),
    loadComponent: () => import('../approvals/approvals-page').then((m) => m.ApprovalsPage),
  },
  {
    path: 'approvals/:approvalId',
    title: title('Approval request'),
    loadComponent: () => import('../approvals/approval-detail-page').then((m) => m.ApprovalDetailPage),
  },
  {
    path: 'repositories',
    title: title('Repositories'),
    loadComponent: () => import('../repositories/repositories-page').then((m) => m.RepositoriesPage),
  },
  {
    path: 'repositories/connect-gitlab',
    title: title('Connect GitLab'),
    loadComponent: () => import('../repositories/connect-gitlab-page').then((m) => m.ConnectGitLabPage),
  },
  {
    path: 'members',
    title: title('Members'),
    loadComponent: () => import('../members/members-page').then((m) => m.MembersPage),
  },
  {
    path: 'settings',
    title: title('Review policy'),
    loadComponent: () => import('../settings/settings-page').then((m) => m.SettingsPage),
  },
  {
    path: 'usage',
    title: title('Usage and cost'),
    loadComponent: () => import('../analytics/usage-page').then((m) => m.UsagePage),
  },
  {
    path: 'audit',
    title: title('Audit log'),
    loadComponent: () => import('../audit/audit-page').then((m) => m.AuditPage),
  },
];
