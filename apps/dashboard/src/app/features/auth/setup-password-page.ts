import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { errorMessage } from '../../core/api/api-error';
import { SessionStore } from '../../core/auth/session.store';
import { Icon } from '../../shared/ui/icon';
import { PASSWORD_MIN_LENGTH, passwordsMatch } from './password-match';

/**
 * Accepts an invitation or reset link. The token arrives in the URL fragment (never sent to the
 * server in requests or Referer headers) and is removed from the address bar immediately.
 */
@Component({
  selector: 'acr-setup-password-page',
  imports: [ReactiveFormsModule, RouterLink, Icon],
  template: `
    <main class="auth-page" id="main-content">
      <div class="auth-brand">
        <span class="brand-mark"><acr-icon name="logo" [size]="18" /></span>
        AI Code Review
      </div>
      <section class="card auth-card" aria-labelledby="setup-heading">
        <h1 id="setup-heading">Choose a password</h1>
        @if (done()) {
          <p class="banner banner-ok" role="status">Your password is set. You can sign in now.</p>
          <a class="btn btn-primary" routerLink="/login">Go to sign in</a>
        } @else if (!token) {
          <p class="banner banner-error" role="alert">
            This link is incomplete. Open the full link you received, or ask an admin for a new one.
          </p>
        } @else {
          @if (error(); as message) {
            <p class="banner banner-error" role="alert">{{ message }}</p>
          }
          <form class="form" [formGroup]="form" (ngSubmit)="submit()" novalidate>
            <div class="field">
              <label for="password">New password</label>
              <input id="password" type="password" formControlName="password" autocomplete="new-password" />
              <span class="hint">At least {{ minLength }} characters. A passphrase is easiest to remember.</span>
            </div>
            <div class="field">
              <label for="confirm">Repeat password</label>
              <input id="confirm" type="password" formControlName="confirm" autocomplete="new-password" />
            </div>
            @if (showErrors() && form.invalid) {
              <p class="field-error" role="alert">
                {{
                  form.hasError('mismatch')
                    ? 'The passwords do not match.'
                    : 'Use at least ' + minLength + ' characters.'
                }}
              </p>
            }
            <button type="submit" class="btn btn-primary" [disabled]="submitting()">Set password</button>
          </form>
        }
      </section>
    </main>
  `,
  styles: `
    .field-error {
      margin: 0;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SetupPasswordPage {
  private readonly session = inject(SessionStore);
  private readonly fb = inject(NonNullableFormBuilder);

  protected readonly minLength = PASSWORD_MIN_LENGTH;
  protected readonly token = readFragmentToken();
  protected readonly form = this.fb.group(
    {
      password: ['', [Validators.required, Validators.minLength(PASSWORD_MIN_LENGTH), Validators.maxLength(200)]],
      confirm: ['', Validators.required],
    },
    { validators: passwordsMatch },
  );
  protected readonly submitting = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly showErrors = signal(false);
  protected readonly done = signal(false);

  protected async submit(): Promise<void> {
    this.showErrors.set(true);
    if (this.form.invalid || !this.token || this.submitting()) return;
    this.submitting.set(true);
    this.error.set(null);
    try {
      await this.session.setupPassword({ token: this.token, password: this.form.controls.password.value });
      this.done.set(true);
    } catch (error) {
      this.error.set(errorMessage(error));
    } finally {
      this.submitting.set(false);
    }
  }
}

function readFragmentToken(): string | null {
  if (typeof window === 'undefined') return null;
  const match = /(?:^#|&)token=([A-Za-z0-9_-]{20,200})/.exec(window.location.hash);
  if (match) history.replaceState(null, '', window.location.pathname);
  return match?.[1] ?? null;
}
