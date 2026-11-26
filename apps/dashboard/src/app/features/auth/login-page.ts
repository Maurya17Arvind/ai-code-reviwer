import { HttpClient } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, inject, input, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { AuthFeaturesResponseSchema } from '@acra/shared-contracts';
import { catchError, map, of } from 'rxjs';
import { API_BASE_URL } from '../../core/api/health-api';
import { errorMessage } from '../../core/api/api-error';
import { SessionStore } from '../../core/auth/session.store';
import { Icon } from '../../shared/ui/icon';

/** Only same-app paths are accepted as return targets (no open redirects). */
export function safeReturnUrl(value: string | undefined): string {
  return value && value.startsWith('/') && !value.startsWith('//') && !value.startsWith('/\\') ? value : '/';
}

@Component({
  selector: 'acr-login-page',
  imports: [ReactiveFormsModule, RouterLink, Icon],
  template: `
    <main class="auth-page" id="main-content">
      <div class="auth-brand">
        <span class="brand-mark"><acr-icon name="logo" [size]="18" /></span>
        AI Code Review
      </div>
      <section class="card auth-card" aria-labelledby="login-heading">
        <h1 id="login-heading">Sign in</h1>
        <p class="muted">Welcome back. Sign in to continue to your dashboard.</p>

        @if (error(); as message) {
          <p class="banner banner-error" role="alert" data-testid="login-error">{{ message }}</p>
        }

        <form class="form" [formGroup]="form" (ngSubmit)="submit()" novalidate>
          <div class="field">
            <label for="email">E-mail</label>
            <input
              id="email"
              type="email"
              formControlName="email"
              autocomplete="username"
              required
              [attr.aria-invalid]="showErrors() && form.controls.email.invalid"
            />
          </div>
          <div class="field">
            <label for="password">Password</label>
            <input
              id="password"
              type="password"
              formControlName="password"
              autocomplete="current-password"
              required
              [attr.aria-invalid]="showErrors() && form.controls.password.invalid"
            />
          </div>
          @if (showErrors() && form.invalid) {
            <p class="field-error" role="alert">Enter your e-mail address and password.</p>
          }
          <button type="submit" class="btn btn-primary" [disabled]="submitting()">
            {{ submitting() ? 'Signing in…' : 'Sign in' }}
          </button>
        </form>
        @if (features().passwordReset) {
          <p class="forgot"><a routerLink="/forgot-password" data-testid="forgot-link">Forgot your password?</a></p>
        }
        <p class="muted small">
          No account yet? Ask an organization admin for an invitation.
          @if (!features().passwordReset) {
            Forgot your password? Ask a platform operator for a new setup link.
          }
        </p>
      </section>
    </main>
  `,
  styles: `
    .field-error {
      margin: 0;
    }
    .forgot {
      margin: 1rem 0 0;
      text-align: center;
      font-size: 0.875rem;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LoginPage {
  private readonly session = inject(SessionStore);
  private readonly router = inject(Router);
  private readonly fb = inject(NonNullableFormBuilder);
  private readonly baseUrl = inject(API_BASE_URL);

  /** Self-service features of this installation. Requested at once; on any error they stay hidden. */
  protected readonly features = toSignal(
    inject(HttpClient)
      .get<unknown>(`${this.baseUrl}/v1/auth/features`)
      .pipe(
        map((body) => AuthFeaturesResponseSchema.parse(body)),
        catchError(() => of({ passwordReset: false })),
      ),
    { initialValue: { passwordReset: false } },
  );

  /** `?returnUrl=` from the guard. */
  readonly returnUrl = input<string>();

  protected readonly form = this.fb.group({
    email: ['', [Validators.required, Validators.email, Validators.maxLength(320)]],
    password: ['', [Validators.required, Validators.maxLength(200)]],
  });
  protected readonly submitting = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly showErrors = signal(false);

  protected async submit(): Promise<void> {
    this.showErrors.set(true);
    if (this.form.invalid || this.submitting()) return;
    this.submitting.set(true);
    this.error.set(null);
    try {
      await this.session.login(this.form.getRawValue());
      await this.router.navigateByUrl(safeReturnUrl(this.returnUrl()));
    } catch (error) {
      this.error.set(errorMessage(error, 'Sign-in failed. Please try again.'));
      this.form.controls.password.reset();
    } finally {
      this.submitting.set(false);
    }
  }
}
