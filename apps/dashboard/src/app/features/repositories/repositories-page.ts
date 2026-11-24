import { DatePipe } from '@angular/common';
import { httpResource } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import {
  ConnectionSchema,
  IntegrationCapabilitiesSchema,
  type Repository,
  RepositorySchema,
} from '@acra/shared-contracts';
import * as z from 'zod/mini';
import { errorMessage } from '../../core/api/api-error';
import { DashboardApi } from '../../core/api/dashboard-api';
import { hasRole } from '../../core/auth/roles';
import { SessionStore } from '../../core/auth/session.store';
import { AsyncState } from '../../shared/ui/async-state';

/** Connected repositories and the provider connections behind them. */
@Component({
  selector: 'acr-repositories-page',
  imports: [AsyncState, DatePipe, RouterLink],
  template: `
    <div class="page-header">
      <div>
        <h1>Repositories</h1>
        <p class="muted">Reviews run automatically for active repositories when a merge or pull request changes.</p>
      </div>
      @if (canManage() && capabilities.value()?.gitlabConnect) {
        <a class="btn btn-primary" [routerLink]="['/o', orgId(), 'repositories', 'connect-gitlab']"
          >Connect GitLab project</a
        >
      }
    </div>

    @if (message(); as m) {
      <p class="banner banner-error" role="alert">{{ m }}</p>
    }

    <acr-async-state
      [loading]="repositories.isLoading()"
      [error]="repoError()"
      [hasData]="repositories.hasValue()"
      [empty]="(repositories.value() ?? []).length === 0"
      emptyText="No repositories connected yet."
      (retry)="repositories.reload()"
    >
      <div class="table-wrap">
        <table class="table">
          <caption class="visually-hidden">
            Repositories
          </caption>
          <thead>
            <tr>
              <th scope="col">Repository</th>
              <th scope="col">Provider</th>
              <th scope="col">Webhook</th>
              <th scope="col">Last review</th>
              <th scope="col">Reviews</th>
            </tr>
          </thead>
          <tbody>
            @for (r of repositories.value() ?? []; track r.id) {
              <tr>
                <td>
                  @if (r.webUrl) {
                    <a [href]="r.webUrl" target="_blank" rel="noopener noreferrer">{{ r.fullName }}</a>
                  } @else {
                    {{ r.fullName }}
                  }
                  <div class="muted small">default branch {{ r.defaultBranch }}</div>
                </td>
                <td>
                  {{ r.provider === 'GITLAB' ? 'GitLab' : r.provider === 'GITHUB' ? 'GitHub' : 'Local' }} ·
                  {{ r.connectionName ?? '—' }}
                </td>
                <td>{{ r.webhookConfigured ? 'Configured' : 'Not configured' }}</td>
                <td>{{ r.lastReviewAt ? (r.lastReviewAt | date: 'short') : 'Never' }}</td>
                <td>
                  @if (canManage()) {
                    <label class="checkbox-row">
                      <input
                        type="checkbox"
                        [checked]="r.isActive"
                        [disabled]="busyId() === r.id"
                        (change)="toggle(r)"
                      />
                      {{ r.isActive ? 'Active' : 'Paused' }}
                    </label>
                  } @else {
                    {{ r.isActive ? 'Active' : 'Paused' }}
                  }
                </td>
              </tr>
            }
          </tbody>
        </table>
      </div>
    </acr-async-state>

    <h2>Connections</h2>
    <p class="muted small">Credentials are encrypted at rest and never shown again after they are saved.</p>
    @if (connections.value(); as list) {
      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Provider</th>
              <th scope="col">Instance / account</th>
              <th scope="col" class="num">Repositories</th>
            </tr>
          </thead>
          <tbody>
            @for (c of list; track c.id) {
              <tr>
                <td>{{ c.name }}</td>
                <td>{{ c.provider === 'GITLAB' ? 'GitLab (access token)' : 'GitHub App' }}</td>
                <td>{{ c.accountLogin ?? c.baseUrl }}</td>
                <td class="num">{{ c.repositoryCount }}</td>
              </tr>
            } @empty {
              <tr>
                <td colspan="4" class="muted">No connections yet.</td>
              </tr>
            }
          </tbody>
        </table>
      </div>
    }

    <h2>Connecting providers</h2>
    <div class="grid">
      <section class="card">
        <h3>GitLab</h3>
        @if (capabilities.value()?.gitlabConnect) {
          <p>Admins can connect a project here with a project or personal access token (scope <code>api</code>).</p>
        } @else {
          <p>
            Dashboard connections are disabled on this server (no <code>CREDENTIALS_MASTER_KEY</code> for the API). An
            operator can run:
          </p>
          <pre class="untrusted">
GITLAB_TOKEN=… node dist/apps/api/admin.js connect-gitlab --org &lt;slug&gt; --project group/app</pre>
        }
      </section>
      <section class="card">
        <h3>GitHub</h3>
        <p>Install the GitHub App on your account, then an operator links the installation:</p>
        <pre class="untrusted">
node dist/apps/api/admin.js connect-github --org &lt;slug&gt; --installation &lt;id&gt;</pre>
        @if (capabilities.value(); as caps) {
          <p class="muted small">
            GitHub webhooks are {{ caps.githubWebhooks ? 'configured' : 'not configured' }} on this server.
          </p>
        }
      </section>
    </div>
  `,
  styles: `
    h3 {
      margin: 0 0 0.5rem;
      font-size: 1rem;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RepositoriesPage {
  private readonly api = inject(DashboardApi);
  private readonly session = inject(SessionStore);
  readonly orgId = input.required<string>();

  protected readonly repositories = httpResource(() => this.api.orgUrl(this.orgId(), '/repositories'), {
    parse: (v) => z.array(RepositorySchema).parse(v),
  });
  protected readonly connections = httpResource(() => this.api.orgUrl(this.orgId(), '/connections'), {
    parse: (v) => z.array(ConnectionSchema).parse(v),
  });
  protected readonly capabilities = httpResource(() => this.api.orgUrl(this.orgId(), '/integrations'), {
    parse: (v) => IntegrationCapabilitiesSchema.parse(v),
  });
  protected readonly repoError = computed(() =>
    this.repositories.error() ? errorMessage(this.repositories.error()) : null,
  );
  protected readonly canManage = computed(() => hasRole(this.session.membership(this.orgId())?.role, 'ADMIN'));
  protected readonly busyId = signal<string | null>(null);
  protected readonly message = signal<string | null>(null);

  protected async toggle(repository: Repository): Promise<void> {
    this.busyId.set(repository.id);
    this.message.set(null);
    try {
      const updated = await this.api.setRepositoryActive(this.orgId(), repository.id, !repository.isActive);
      this.repositories.update((list) => list?.map((r) => (r.id === updated.id ? updated : r)));
    } catch (error) {
      this.message.set(errorMessage(error));
      this.repositories.reload();
    } finally {
      this.busyId.set(null);
    }
  }
}
