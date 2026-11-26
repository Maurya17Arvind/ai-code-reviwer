import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { type PasswordResetRequest } from '@acra/shared-contracts';
import { firstValueFrom } from 'rxjs';
import { API_BASE_URL } from '../../core/api/health-api';
import { Icon } from '../../shared/ui/icon';

/**
 * Self-service password reset (Phase 9). The confirmation is the same for every address, because the
 * API answers the same way whether or not an account exists; the link only ever arrives by e-mail.
 */
@Component({
  selector: 'acr-forgot-password-page',
  imports: [ReactiveFormsModule, RouterLink, Icon],
  template: `
    <main class="auth-page" id="main-content">
      <div class="auth-brand">
        <span class="brand-mark"><acr-icon name="logo" [size]="18" /></span>
        AI Code Review
      </div>
      <section class="card auth-card" aria-labelledby="forgot-heading">
        <h1 id="forgot-heading">Reset your password</h1>

        @if (sentTo(); as address) {
          <div class="banner banner-ok" role="status" data-testid="reset-sent">
            <span>
              If an account exists for <strong>{{ address }}</strong>, we sent it a link to choose a new password. The
              link works once and expires in 2 hours.
            </span>
          </div>
          <p class="muted small">Nothing arrived? Check your spam folder, or try again in a few minutes.</p>
          <a class="btn btn-primary" routerLink="/login">Back to sign in</a>
        } @else {
          <p class="muted">Enter the e-mail address of your account and we will send you a reset link.</p>

          @if (error(); as message) {
            <p class="banner banner-error" role="alert" data-testid="reset-error">{{ message }}</p>
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
            @if (showErrors() && form.invalid) {
              <p class="field-error" role="alert">Enter a valid e-mail address.</p>
            }
            <button type="submit" class="btn btn-primary" [disabled]="submitting()">
              {{ submitting() ? 'Sending…' : 'Send reset link' }}
            </button>
          </form>
          <p class="muted small"><a routerLink="/login">Back to sign in</a></p>
        }
      </section>
    </main>
  `,
  styles: `
    .field-error {
      margin: 0;
    }
    .btn-primary:not([type='submit']) {
      width: 100%;
      margin-top: 0.5rem;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ForgotPasswordPage {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = inject(API_BASE_URL);
  private readonly fb = inject(NonNullableFormBuilder);

  protected readonly form = this.fb.group({
    email: ['', [Validators.required, Validators.email, Validators.maxLength(320)]],
  });
  protected readonly submitting = signal(false);
  protected readonly showErrors = signal(false);
  protected readonly error = signal<string | null>(null);
  /** Address the confirmation refers to, once the request was accepted. */
  protected readonly sentTo = signal<string | null>(null);

  protected async submit(): Promise<void> {
    this.showErrors.set(true);
    if (this.form.invalid || this.submitting()) return;
    this.submitting.set(true);
    this.error.set(null);
    const body: PasswordResetRequest = { email: this.form.controls.email.value.trim() };
    try {
      await firstValueFrom(this.http.post(`${this.baseUrl}/v1/auth/password-reset`, body));
      this.sentTo.set(body.email);
    } catch (error) {
      this.error.set(resetErrorMessage(error));
    } finally {
      this.submitting.set(false);
    }
  }
}

function resetErrorMessage(error: unknown): string {
  if (error instanceof HttpErrorResponse) {
    if (error.status === 429) return 'Too many requests from this network. Try again in an hour.';
    if (error.status === 404) {
      return 'Password reset by e-mail is not available here. Ask your platform operator for a reset link.';
    }
  }
  return 'The request could not be sent. Check your connection and try again.';
}
