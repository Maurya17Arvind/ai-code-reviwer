import { DatePipe, JsonPipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { type AuditLogEntry, AuditLogEntrySchema } from '@acra/shared-contracts';
import { DashboardApi, queryString } from '../../core/api/dashboard-api';
import { PagedList } from '../../core/api/paged-list';
import { hasRole } from '../../core/auth/roles';
import { SessionStore } from '../../core/auth/session.store';
import { AsyncState } from '../../shared/ui/async-state';

const ACTION_FILTERS = [
  { value: '', label: 'All events' },
  { value: 'approval.', label: 'Approvals' },
  { value: 'fix.', label: 'Fix proposals' },
  { value: 'finding.', label: 'Finding triage' },
  { value: 'member.', label: 'Members' },
  { value: 'repository.', label: 'Repositories' },
  { value: 'settings.', label: 'Policy' },
  { value: 'organization.', label: 'Organization' },
] as const;

/** Append-only audit log of the organization (ADMIN or higher). */
@Component({
  selector: 'acr-audit-page',
  imports: [AsyncState, DatePipe, JsonPipe],
  template: `
    <div class="page-header">
      <div>
        <h1>Audit log</h1>
        <p class="muted">Every privileged action, who did it and from where. Entries cannot be changed or deleted.</p>
      </div>
    </div>
    @if (!allowed()) {
      <p class="banner banner-info">The audit log is available to admins and owners.</p>
    } @else {
      <div class="filters" role="search" aria-label="Filter audit log">
        <div class="field">
          <label for="f-action">Event type</label>
          <select id="f-action" [value]="action()" (change)="action.set(value($event))">
            @for (f of filters; track f.value) {
              <option [value]="f.value">{{ f.label }}</option>
            }
          </select>
        </div>
      </div>
      <acr-async-state
        [loading]="list.loading()"
        [error]="list.error()"
        [empty]="list.isEmpty()"
        [hasData]="list.items().length > 0"
        emptyText="No audit entries yet."
        (retry)="list.load()"
      >
        <div class="table-wrap">
          <table class="table">
            <caption class="visually-hidden">
              Audit log
            </caption>
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Action</th>
                <th scope="col">Actor</th>
                <th scope="col">Target</th>
                <th scope="col">Details</th>
              </tr>
            </thead>
            <tbody>
              @for (e of list.items(); track e.id) {
                <tr>
                  <td>{{ e.createdAt | date: 'medium' }}</td>
                  <td>
                    <code>{{ e.action }}</code>
                  </td>
                  <td>
                    {{ actorLabel(e) }}
                    @if (e.ipAddress) {
                      <div class="muted small">{{ e.ipAddress }}</div>
                    }
                  </td>
                  <td>
                    {{ e.targetType }}
                    <div class="muted small mono">{{ e.targetId ?? '' }}</div>
                  </td>
                  <td>
                    @if (hasMetadata(e)) {
                      <details>
                        <summary>Show</summary>
                        <pre class="untrusted small">{{ e.metadata | json }}</pre>
                      </details>
                    }
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>
        @if (list.hasMore()) {
          <div class="load-more">
            <button type="button" class="btn" (click)="list.loadMore()" [disabled]="list.loading()">Load more</button>
          </div>
        }
      </acr-async-state>
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AuditPage {
  private readonly api = inject(DashboardApi);
  private readonly session = inject(SessionStore);
  readonly orgId = input.required<string>();

  protected readonly filters = ACTION_FILTERS;
  protected readonly action = signal('');
  protected readonly allowed = computed(() => hasRole(this.session.membership(this.orgId())?.role, 'ADMIN'));
  protected readonly list = new PagedList<AuditLogEntry>((cursor) =>
    this.api.page(
      this.api.orgUrl(this.orgId(), `/audit-logs${queryString({ action: this.action(), cursor, limit: 50 })}`),
      AuditLogEntrySchema,
    ),
  );

  constructor() {
    effect(() => {
      this.orgId();
      this.action();
      if (untracked(() => this.allowed())) untracked(() => void this.list.load());
    });
  }

  protected actorLabel(entry: AuditLogEntry): string {
    if (entry.actor) return `${entry.actor.displayName} (${entry.actor.email})`;
    return entry.actorType === 'WEBHOOK' ? 'Webhook' : 'System';
  }

  protected hasMetadata(entry: AuditLogEntry): boolean {
    return Object.keys(entry.metadata).length > 0;
  }

  protected value(event: Event): string {
    return (event.target as HTMLSelectElement).value;
  }
}
