import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { filter, map } from 'rxjs';
import { SessionStore } from '../../core/auth/session.store';

/** Signed-in layout: header with organization switcher and account menu. */
@Component({
  selector: 'acr-shell',
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  template: `
    <a class="skip-link" href="#main-content">Skip to main content</a>
    <header class="app-header">
      <a class="brand" routerLink="/">AI Code Review</a>
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
        <a routerLink="/organizations/new" routerLinkActive="active" ariaCurrentWhenActive="page">New organization</a>
        <a routerLink="/system-status" routerLinkActive="active" ariaCurrentWhenActive="page">System status</a>
        <a routerLink="/account" routerLinkActive="active" ariaCurrentWhenActive="page">{{ user()?.displayName }}</a>
        <button type="button" class="btn btn-small" (click)="signOut()">Sign out</button>
      </nav>
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
