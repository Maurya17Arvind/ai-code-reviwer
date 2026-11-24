import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { hasRole, ROLE_LABELS } from '../../core/auth/roles';
import { SessionStore } from '../../core/auth/session.store';

interface NavItem {
  readonly path: string;
  readonly label: string;
  readonly exact?: boolean;
  readonly minRole?: 'ADMIN';
}

const NAV: readonly NavItem[] = [
  { path: '', label: 'Overview', exact: true },
  { path: 'reviews', label: 'Reviews' },
  { path: 'findings', label: 'Findings' },
  { path: 'fixes', label: 'Fix proposals' },
  { path: 'approvals', label: 'Approvals' },
  { path: 'repositories', label: 'Repositories' },
  { path: 'members', label: 'Members' },
  { path: 'settings', label: 'Review policy' },
  { path: 'usage', label: 'Usage and cost' },
  { path: 'audit', label: 'Audit log', minRole: 'ADMIN' },
];

/** Organization layout: section navigation + the selected page. */
@Component({
  selector: 'acr-org-layout',
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  template: `
    <div class="org-layout">
      <nav class="side-nav" aria-label="Organization">
        <p class="org-name">
          {{ membership()?.name }}
          @if (membership(); as m) {
            <span class="muted small">{{ roleLabels[m.role] }}</span>
          }
        </p>
        <ul>
          @for (item of nav(); track item.path) {
            <li>
              <a
                [routerLink]="item.path ? ['/o', orgId(), item.path] : ['/o', orgId()]"
                routerLinkActive="active"
                [routerLinkActiveOptions]="{ exact: !!item.exact }"
                ariaCurrentWhenActive="page"
                >{{ item.label }}</a
              >
            </li>
          }
        </ul>
      </nav>
      <section class="org-content">
        <router-outlet />
      </section>
    </div>
  `,
  styles: `
    .org-layout {
      display: grid;
      grid-template-columns: 12rem minmax(0, 1fr);
      gap: 1.5rem;
    }
    @media (max-width: 48rem) {
      .org-layout {
        grid-template-columns: minmax(0, 1fr);
      }
      .side-nav ul {
        display: flex;
        flex-wrap: wrap;
        gap: 0.25rem 0.75rem;
      }
    }
    .org-name {
      font-weight: 600;
      margin: 0 0 0.75rem;
      display: grid;
    }
    .side-nav ul {
      list-style: none;
      padding: 0;
      margin: 0;
    }
    .side-nav a {
      display: block;
      padding: 0.3rem 0.5rem;
      border-radius: var(--radius);
      color: var(--color-text-muted);
      text-decoration: none;
    }
    .side-nav a:hover,
    .side-nav a.active {
      color: var(--color-text);
      background: var(--color-surface-2);
    }
    .side-nav a.active {
      font-weight: 600;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class OrgLayout {
  private readonly session = inject(SessionStore);
  readonly orgId = input.required<string>();

  protected readonly roleLabels = ROLE_LABELS;
  protected readonly membership = computed(() => this.session.membership(this.orgId()));
  protected readonly nav = computed(() =>
    NAV.filter((item) => !item.minRole || hasRole(this.membership()?.role, item.minRole)),
  );
}
