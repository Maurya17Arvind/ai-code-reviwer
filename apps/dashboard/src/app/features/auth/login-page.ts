import { ChangeDetectionStrategy, Component, inject, input, signal } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router } from '@angular/router';
import { errorMessage } from '../../core/api/api-error';
import { SessionStore } from '../../core/auth/session.store';

/** Only same-app paths are accepted as return targets (no open redirects). */
export function safeReturnUrl(value: string | undefined): string {
  return value && value.startsWith('/') && !value.startsWith('//') && !value.startsWith('/\\') ? value : '/';
}

@Component({
  selector: 'acr-login-page',
  imports: [ReactiveFormsModule],
  template: `
    <main class="auth-page" id="main-content">
      <section class="card auth-card" aria-labelledby="login-heading">
        <h1 id="login-heading">Sign in</h1>
        <p class="muted">AI Code Review dashboard</p>

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
        <p class="muted small">
          No account yet? Ask an organization admin for an invitation link. Forgot your password? An admin can send you
          a new setup link.
        </p>
      </section>
    </main>
  `,
  styles: `
    .auth-page {
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: 1rem;
    }
    .auth-card {
      width: min(26rem, 100%);
    }
    .field-error {
      color: var(--color-danger);
      margin: 0;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LoginPage {
  private readonly session = inject(SessionStore);
  private readonly router = inject(Router);
  private readonly fb = inject(NonNullableFormBuilder);

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
