import { ChangeDetectionStrategy, Component, computed, type ElementRef, inject, input, viewChild } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { filter, map } from 'rxjs';
import { hasRole, ROLE_LABELS } from '../../core/auth/roles';
import { SessionStore } from '../../core/auth/session.store';
import { Icon, type IconName } from '../../shared/ui/icon';

interface NavItem {
  readonly path: string;
  readonly label: string;
  readonly icon: IconName;
  readonly exact?: boolean;
  readonly minRole?: 'ADMIN';
}

const NAV: readonly NavItem[] = [
  { path: '', label: 'Overview', icon: 'overview', exact: true },
  { path: 'reviews', label: 'Reviews', icon: 'reviews' },
  { path: 'findings', label: 'Findings', icon: 'findings' },
  { path: 'fixes', label: 'Fix proposals', icon: 'fixes' },
  { path: 'approvals', label: 'Approvals', icon: 'approvals' },
  { path: 'repositories', label: 'Repositories', icon: 'repositories' },
  { path: 'members', label: 'Members', icon: 'members' },
  { path: 'settings', label: 'Review policy', icon: 'settings' },
  { path: 'usage', label: 'Usage and cost', icon: 'usage' },
  { path: 'audit', label: 'Audit log', icon: 'audit', minRole: 'ADMIN' },
];

/** Organization layout: section navigation + the selected page. */
@Component({
  selector: 'acr-org-layout',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, Icon],
  template: `
    <div class="org-layout">
      <nav class="side-nav" aria-label="Organization">
        <div class="org-card">
          <span class="org-initial" aria-hidden="true">{{ initial() }}</span>
          <p class="org-name">
            <span class="org-title">{{ membership()?.name }}</span>
            @if (membership(); as m) {
              <span class="muted small">{{ roleLabels[m.role] }}</span>
            }
          </p>
        </div>
        <ul>
          @for (item of nav(); track item.path) {
            <li>
              <a
                [routerLink]="item.path ? ['/o', orgId(), item.path] : ['/o', orgId()]"
                routerLinkActive="active"
                [routerLinkActiveOptions]="{ exact: !!item.exact }"
                ariaCurrentWhenActive="page"
                ><acr-icon [name]="item.icon" [size]="17" />{{ item.label }}</a
              >
            </li>
          }
        </ul>
      </nav>
      <section class="org-content" #content>
        <router-outlet />
      </section>
    </div>
  `,
  styles: `
    /* Fills the shell's main area; sidebar and content are independent scroll regions. */
    :host {
      display: block;
      flex: 1;
      min-height: 0;
      padding: 0;
      overflow: hidden;
    }
    .org-layout {
      display: grid;
      grid-template-columns: 15rem minmax(0, 1fr);
      height: 100%;
    }
    .side-nav {
      position: relative;
      min-height: 0;
      overflow-y: auto;
      overscroll-behavior: contain;
      padding: 1.25rem 0.75rem;
      background: var(--sidebar-bg);
      color: var(--sidebar-text);
      scrollbar-width: thin;
      scrollbar-color: var(--sidebar-border) transparent;
    }
    .org-content {
      position: relative;
      min-height: 0;
      overflow-y: auto;
      overscroll-behavior: contain;
      padding: 2rem max(1.5rem, calc((100% - 80rem) / 2)) 4rem;
    }
    .org-card {
      display: flex;
      align-items: center;
      gap: 0.625rem;
      padding: 0 0.375rem 1rem;
      margin-bottom: 0.75rem;
      border-bottom: 1px solid var(--sidebar-border);
    }
    .org-initial {
      display: grid;
      place-items: center;
      flex: none;
      width: 2.25rem;
      height: 2.25rem;
      border-radius: var(--radius);
      font-weight: 700;
      color: var(--brand-navy);
      background: var(--color-decor);
    }
    .org-name {
      display: grid;
      margin: 0;
      min-width: 0;
      line-height: 1.3;
    }
    .org-name .muted {
      color: var(--sidebar-muted);
    }
    .org-title {
      font-weight: 650;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    ul {
      display: grid;
      gap: 0.125rem;
      list-style: none;
      padding: 0;
      margin: 0;
    }
    a {
      position: relative;
      display: flex;
      align-items: center;
      gap: 0.625rem;
      padding: 0.4375rem 0.625rem;
      border-radius: var(--radius);
      font-size: 0.875rem;
      font-weight: 500;
      color: var(--sidebar-muted);
      text-decoration: none;
      white-space: nowrap;
      transition: background-color 0.15s var(--ease), color 0.15s var(--ease);
    }
    a:hover {
      color: var(--sidebar-text);
      background: var(--sidebar-hover-bg);
    }
    a.active {
      color: var(--sidebar-text);
      background: var(--sidebar-active-bg);
      font-weight: 600;
    }
    a.active::before {
      content: '';
      position: absolute;
      left: -0.75rem;
      top: 0.375rem;
      bottom: 0.375rem;
      width: 3px;
      border-radius: 0 3px 3px 0;
      background: var(--sidebar-indicator);
    }
    a:focus-visible {
      outline-color: var(--sidebar-indicator);
    }
    @media (max-width: 52rem) {
      /* Narrow screens: the nav becomes a horizontally scrolling strip above the content. */
      .org-layout {
        grid-template-columns: minmax(0, 1fr);
        grid-template-rows: auto minmax(0, 1fr);
      }
      .side-nav {
        display: flex;
        align-items: center;
        gap: 0.75rem;
        overflow: hidden;
        padding: 0.5rem 0.75rem;
      }
      .org-card {
        flex: none;
        padding: 0;
        margin: 0;
        border: none;
      }
      .org-name {
        display: none;
      }
      ul {
        display: flex;
        flex: 1;
        overflow-x: auto;
        gap: 0.25rem;
        scrollbar-width: none;
      }
      a.active::before {
        display: none;
      }
      .org-content {
        padding: 1.25rem 1rem 3rem;
      }
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class OrgLayout {
  private readonly session = inject(SessionStore);
  readonly orgId = input.required<string>();

  /** The content pane is the scroll container, so the router's window scrolling never applies. */
  private readonly content = viewChild<ElementRef<HTMLElement>>('content');

  constructor() {
    let lastPath = '';
    inject(Router)
      .events.pipe(
        filter((e) => e instanceof NavigationEnd),
        map((e) => e.urlAfterRedirects.split(/[?#]/)[0] ?? ''),
        takeUntilDestroyed(),
      )
      .subscribe((path) => {
        // A new page starts at the top; filter/query changes on the same page keep the position.
        const pane = this.content()?.nativeElement;
        if (pane && path !== lastPath) pane.scrollTop = 0;
        lastPath = path;
      });
  }

  protected readonly roleLabels = ROLE_LABELS;
  protected readonly membership = computed(() => this.session.membership(this.orgId()));
  protected readonly initial = computed(() => this.membership()?.name.trim().charAt(0).toUpperCase() ?? '');
  protected readonly nav = computed(() =>
    NAV.filter((item) => !item.minRole || hasRole(this.membership()?.role, item.minRole)),
  );
}
