import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router } from '@angular/router';
import { errorMessage } from '../../core/api/api-error';
import { DashboardApi } from '../../core/api/dashboard-api';
import { SessionStore } from '../../core/auth/session.store';

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100);
}

@Component({
  selector: 'acr-create-organization-page',
  imports: [ReactiveFormsModule],
  template: `
    <div class="page-header">
      <div>
        <h1>New organization</h1>
        <p class="muted">Organizations hold repositories, members and review history. You become its owner.</p>
      </div>
    </div>
    @if (error(); as message) {
      <p class="banner banner-error" role="alert">{{ message }}</p>
    }
    <form class="form card" [formGroup]="form" (ngSubmit)="submit()" novalidate>
      <div class="field">
        <label for="name">Name</label>
        <input id="name" type="text" formControlName="name" maxlength="200" autocomplete="organization" />
      </div>
      <div class="field">
        <label for="slug">Slug</label>
        <input id="slug" type="text" formControlName="slug" maxlength="100" aria-describedby="slug-hint" />
        <span class="hint" id="slug-hint"
          >Lower-case letters, digits and dashes. Used by the operator CLI (--org).</span
        >
      </div>
      @if (showErrors() && form.invalid) {
        <p class="field-error" role="alert">Enter a name and a valid slug.</p>
      }
      <button type="submit" class="btn btn-primary" [disabled]="submitting()">Create organization</button>
    </form>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CreateOrganizationPage {
  private readonly api = inject(DashboardApi);
  private readonly session = inject(SessionStore);
  private readonly router = inject(Router);
  private readonly fb = inject(NonNullableFormBuilder);

  protected readonly form = this.fb.group({
    name: ['', [Validators.required, Validators.maxLength(200)]],
    slug: ['', [Validators.required, Validators.minLength(2), Validators.maxLength(100), Validators.pattern(SLUG)]],
  });
  protected readonly submitting = signal(false);
  protected readonly showErrors = signal(false);
  protected readonly error = signal<string | null>(null);
  private slugEdited = false;

  constructor() {
    this.form.controls.name.valueChanges.pipe(takeUntilDestroyed()).subscribe((name) => {
      if (!this.slugEdited) this.form.controls.slug.setValue(slugify(name), { emitEvent: false });
    });
    this.form.controls.slug.valueChanges.pipe(takeUntilDestroyed()).subscribe(() => (this.slugEdited = true));
  }

  protected async submit(): Promise<void> {
    this.showErrors.set(true);
    if (this.form.invalid || this.submitting()) return;
    this.submitting.set(true);
    this.error.set(null);
    try {
      const org = await this.api.createOrganization(this.form.getRawValue());
      await this.session.refresh();
      await this.router.navigate(['/o', org.id]);
    } catch (error) {
      this.error.set(errorMessage(error));
    } finally {
      this.submitting.set(false);
    }
  }
}
