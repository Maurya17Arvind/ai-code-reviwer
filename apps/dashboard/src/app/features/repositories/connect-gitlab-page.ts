import { httpResource } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, inject, input, signal } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { type ConnectGitLabResponse, IntegrationCapabilitiesSchema } from '@acra/shared-contracts';
import { errorMessage } from '../../core/api/api-error';
import { DashboardApi } from '../../core/api/dashboard-api';

/**
 * Connects one GitLab project. The token is sent once over HTTPS, validated against GitLab,
 * encrypted by the server and never displayed again. The form is cleared after submission.
 */
@Component({
  selector: 'acr-connect-gitlab-page',
  imports: [ReactiveFormsModule, RouterLink],
  template: `
    <p><a [routerLink]="['/o', orgId(), 'repositories']">← Repositories</a></p>
    <div class="page-header">
      <div>
        <h1>Connect a GitLab project</h1>
        <p class="muted">
          Needs a project or personal access token with the <code>api</code> scope (Maintainer to register the webhook).
        </p>
      </div>
    </div>

    @if (result(); as r) {
      <div class="banner banner-ok" role="status">
        <span
          >Connected <strong>{{ r.projectPath }}</strong>.</span
        >
      </div>
      @if (r.webhookToken) {
        <div class="card stack">
          <p><strong>Set up the webhook in GitLab now. The secret is shown only once.</strong></p>
          <p>
            Settings → Webhooks → URL <code>{{ r.webhookUrl }}</code>, trigger "Merge request events", SSL verification
            on.
          </p>
          <p>
            Secret token: <span class="code-box">{{ r.webhookToken }}</span>
          </p>
        </div>
      } @else if (r.webhookId) {
        <p>The webhook was registered automatically.</p>
      } @else {
        <p class="muted">No webhook was set up. Reviews start once a webhook delivers merge request events.</p>
      }
      <p><a class="btn" [routerLink]="['/o', orgId(), 'repositories']">Back to repositories</a></p>
    } @else {
      @if (error(); as message) {
        <p class="banner banner-error" role="alert">{{ message }}</p>
      }
      <form class="form card" [formGroup]="form" (ngSubmit)="submit()" novalidate>
        <div class="field">
          <label for="baseUrl">GitLab URL</label>
          <input id="baseUrl" type="url" formControlName="baseUrl" />
          @if (capabilities.value(); as caps) {
            <span class="hint">Allowed hosts on this server: {{ caps.gitlabAllowedHosts.join(', ') }}</span>
          }
        </div>
        <div class="field">
          <label for="project">Project</label>
          <input id="project" type="text" formControlName="project" placeholder="group/subgroup/project" />
        </div>
        <div class="field">
          <label for="connectionName">Connection name</label>
          <input id="connectionName" type="text" formControlName="connectionName" />
          <span class="hint">Projects that share a token can share a connection name.</span>
        </div>
        <div class="field">
          <label for="token">Access token</label>
          <input id="token" type="password" formControlName="token" autocomplete="off" spellcheck="false" />
          <span class="hint">Write-only: it is encrypted on the server and never shown again.</span>
        </div>
        <fieldset>
          <legend>Webhook</legend>
          <label class="checkbox-row">
            <input
              type="radio"
              formControlName="webhook"
              value="register"
              [attr.disabled]="webhooksAvailable() ? null : true"
            />
            Register automatically (token needs Maintainer)
          </label>
          <label class="checkbox-row">
            <input
              type="radio"
              formControlName="webhook"
              value="manual"
              [attr.disabled]="webhooksAvailable() ? null : true"
            />
            I will add it in GitLab myself (show the secret once)
          </label>
          <label class="checkbox-row">
            <input type="radio" formControlName="webhook" value="none" />
            No webhook for now
          </label>
          @if (!webhooksAvailable()) {
            <p class="hint">Webhooks need WEBHOOK_PUBLIC_BASE_URL on the server.</p>
          }
        </fieldset>
        @if (showErrors() && form.invalid) {
          <p class="field-error" role="alert">
            Fill in the URL, project, connection name and a token (10+ characters).
          </p>
        }
        <button type="submit" class="btn btn-primary" [disabled]="submitting()">
          {{ submitting() ? 'Connecting…' : 'Connect project' }}
        </button>
      </form>
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ConnectGitLabPage {
  private readonly api = inject(DashboardApi);
  private readonly fb = inject(NonNullableFormBuilder);
  readonly orgId = input.required<string>();

  protected readonly capabilities = httpResource(() => this.api.orgUrl(this.orgId(), '/integrations'), {
    parse: (v) => IntegrationCapabilitiesSchema.parse(v),
  });
  protected readonly form = this.fb.group({
    baseUrl: ['https://gitlab.com', [Validators.required, Validators.pattern(/^https?:\/\/\S+$/)]],
    project: ['', [Validators.required, Validators.maxLength(500), Validators.pattern(/^[A-Za-z0-9_.\-/]+$/)]],
    connectionName: [
      'default',
      [Validators.required, Validators.maxLength(200), Validators.pattern(/^[A-Za-z0-9 ._-]+$/)],
    ],
    token: ['', [Validators.required, Validators.minLength(10), Validators.maxLength(500)]],
    webhook: this.fb.control<'register' | 'manual' | 'none'>('none'),
  });
  protected readonly submitting = signal(false);
  protected readonly showErrors = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly result = signal<ConnectGitLabResponse | null>(null);

  protected webhooksAvailable(): boolean {
    return this.capabilities.value()?.gitlabWebhooks ?? false;
  }

  protected async submit(): Promise<void> {
    this.showErrors.set(true);
    if (this.form.invalid || this.submitting()) return;
    this.submitting.set(true);
    this.error.set(null);
    try {
      this.result.set(await this.api.connectGitLab(this.orgId(), this.form.getRawValue()));
      this.form.reset();
    } catch (error) {
      this.error.set(errorMessage(error));
      this.form.controls.token.reset();
    } finally {
      this.submitting.set(false);
    }
  }
}
