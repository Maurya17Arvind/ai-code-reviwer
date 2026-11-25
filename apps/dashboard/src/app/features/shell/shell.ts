import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { filter, map } from 'rxjs';
import { SessionStore } from '../../core/auth/session.store';
import { Icon } from '../../shared/ui/icon';

/** Signed-in layout: header with organization switcher and account menu. */
@Component({
  selector: 'acr-shell',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, Icon],
  template: `
    <a class="skip-link" href="#main-content">Skip to main content</a>
    <header class="app-header">
      <div class="header-inner">
        <a class="brand" routerLink="/">
          <span class="brand-mark"><acr-icon name="logo" [size]="18" /></span>
          <span class="brand-text">AI Code Review</span>
        </a>
        @if (memberships().length > 0) {
          <label class="org-switch">
            <span class="visually-hidden">Organization</span>
            <select [value]="currentOrgId() ?? ''" (change)="switchOrganization($event)" data-testid="org-switcher">
              @if (!currentOrgId()) {
                <option value="" disabled>Choose an organization</option>
              }
              @for (m of memberships(); track m.organizationId) {
                <option [value]="m.organizationId">{{ m.name }}</option>
              }
            </select>
          </label>
        }
        <nav aria-label="Account" class="account-nav">
          <a routerLink="/organizations/new" routerLinkActive="active" ariaCurrentWhenActive="page">
            <acr-icon name="plus" [size]="16" /><span class="nav-text">New organization</span>
          </a>
          <a routerLink="/system-status" routerLinkActive="active" ariaCurrentWhenActive="page">
            <acr-icon name="activity" [size]="16" /><span class="nav-text">System status</span>
          </a>
          <a class="account-link" routerLink="/account" routerLinkActive="active" ariaCurrentWhenActive="page">
            <span class="avatar" aria-hidden="true">{{ initials() }}</span
            ><span class="nav-text">{{ user()?.displayName }}</span>
          </a>
          <button type="button" class="btn btn-small btn-ghost" (click)="signOut()">
            <acr-icon name="logout" [size]="16" />Sign out
          </button>
        </nav>
      </div>
    </header>
    <main id="main-content" class="app-main" tabindex="-1">
      <router-outlet />
    </main>
  `,
  styleUrl: './shell.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Shell {
  private readonly session = inject(SessionStore);
  private readonly router = inject(Router);

  protected readonly user = this.session.user;
  protected readonly memberships = this.session.memberships;
  protected readonly initials = computed(() =>
    (this.user()?.displayName ?? '')
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join(''),
  );
  private readonly url = toSignal(
    this.router.events.pipe(
      filter((e) => e instanceof NavigationEnd),
      map(() => this.router.url),
    ),
    { initialValue: this.router.url },
  );
  protected readonly currentOrgId = computed(() => /^\/o\/([0-9a-f-]{36})/i.exec(this.url())?.[1] ?? null);

  protected switchOrganization(event: Event): void {
    const id = (event.target as HTMLSelectElement).value;
    if (id) void this.router.navigate(['/o', id]);
  }

  protected async signOut(): Promise<void> {
    await this.session.logout().catch(() => undefined);
    await this.router.navigate(['/login']);
  }
}
