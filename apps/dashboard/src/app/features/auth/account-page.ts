import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { errorMessage } from '../../core/api/api-error';
import { ROLE_LABELS } from '../../core/auth/roles';
import { SessionStore } from '../../core/auth/session.store';
import { PASSWORD_MIN_LENGTH, passwordsMatch } from './password-match';

@Component({
  selector: 'acr-account-page',
  imports: [ReactiveFormsModule, DatePipe],
  template: `
    <div class="page-header">
      <div>
        <h1>Account</h1>
        <p class="muted">{{ user()?.email }}</p>
      </div>
    </div>

    <section class="card stack" aria-labelledby="orgs-heading">
      <h2 id="orgs-heading">Organizations</h2>
      <ul>
        @for (m of memberships(); track m.organizationId) {
          <li>
            {{ m.name }} <span class="muted">({{ roleLabels[m.role] }})</span>
          </li>
        } @empty {
          <li class="muted">You are not a member of any organization yet.</li>
        }
      </ul>
      @if (user()?.lastLoginAt; as last) {
        <p class="muted small">Previous sign-in: {{ last | date: 'medium' }}</p>
      }
    </section>

    <h2 id="password-heading">Change password</h2>
    @if (message(); as m) {
      <p class="banner" [class.banner-ok]="m.ok" [class.banner-error]="!m.ok" role="status">{{ m.text }}</p>
    }
    <form class="form card" [formGroup]="form" (ngSubmit)="submit()" aria-labelledby="password-heading" novalidate>
      <div class="field">
        <label for="current">Current password</label>
        <input id="current" type="password" formControlName="currentPassword" autocomplete="current-password" />
      </div>
      <div class="field">
        <label for="password">New password</label>
        <input id="password" type="password" formControlName="password" autocomplete="new-password" />
        <span class="hint">At least {{ minLength }} characters. Other devices will be signed out.</span>
      </div>
      <div class="field">
        <label for="confirm">Repeat new password</label>
        <input id="confirm" type="password" formControlName="confirm" autocomplete="new-password" />
      </div>
      @if (showErrors() && form.invalid) {
        <p class="field-error" role="alert">
          {{
            form.hasError('mismatch')
              ? 'The new passwords do not match.'
              : 'Fill in all fields (new password: ' + minLength + '+ characters).'
          }}
        </p>
      }
      <button type="submit" class="btn btn-primary" [disabled]="submitting()">Change password</button>
    </form>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AccountPage {
  private readonly session = inject(SessionStore);
  private readonly fb = inject(NonNullableFormBuilder);

  protected readonly user = this.session.user;
  protected readonly memberships = this.session.memberships;
  protected readonly roleLabels = ROLE_LABELS;
  protected readonly minLength = PASSWORD_MIN_LENGTH;
  protected readonly form = this.fb.group(
    {
      currentPassword: ['', Validators.required],
      password: ['', [Validators.required, Validators.minLength(PASSWORD_MIN_LENGTH), Validators.maxLength(200)]],
      confirm: ['', Validators.required],
    },
    { validators: passwordsMatch },
  );
  protected readonly submitting = signal(false);
  protected readonly showErrors = signal(false);
  protected readonly message = signal<{ ok: boolean; text: string } | null>(null);

  protected async submit(): Promise<void> {
    this.showErrors.set(true);
    if (this.form.invalid || this.submitting()) return;
    this.submitting.set(true);
    this.message.set(null);
    try {
      const { currentPassword, password } = this.form.getRawValue();
      await this.session.changePassword({ currentPassword, newPassword: password });
      this.form.reset();
      this.showErrors.set(false);
      this.message.set({ ok: true, text: 'Password changed. Other sessions were signed out.' });
    } catch (error) {
      this.message.set({ ok: false, text: errorMessage(error) });
    } finally {
      this.submitting.set(false);
    }
  }
}
