import { DatePipe } from '@angular/common';
import { httpResource } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ApprovalSummarySchema } from '@acra/shared-contracts';
import * as z from 'zod/mini';
import { errorMessage } from '../../core/api/api-error';
import { DashboardApi, queryString } from '../../core/api/dashboard-api';
import { AsyncState } from '../../shared/ui/async-state';
import { Badge } from '../../shared/ui/badge';
import { HumanizePipe, ShortShaPipe } from '../../shared/ui/pipes';

@Component({
  selector: 'acr-approvals-page',
  imports: [AsyncState, Badge, DatePipe, HumanizePipe, RouterLink, ShortShaPipe],
  template: `
    <div class="page-header">
      <div>
        <h1>Approvals</h1>
        <p class="muted">
          Every write (branch, commit, merge/pull request) needs a human approval. Merging is never automated.
        </p>
      </div>
      <div class="segmented" role="group" aria-label="Show">
        <button
          type="button"
          class="btn btn-small"
          [attr.aria-pressed]="scope() === 'open'"
          (click)="scope.set('open')"
        >
          Open
        </button>
        <button type="button" class="btn btn-small" [attr.aria-pressed]="scope() === 'all'" (click)="scope.set('all')">
          All
        </button>
      </div>
    </div>
    <acr-async-state
      [loading]="approvals.isLoading()"
      [error]="error()"
      [hasData]="approvals.hasValue()"
      [empty]="(approvals.value() ?? []).length === 0"
      [emptyText]="scope() === 'open' ? 'No open approval requests.' : 'No approval requests yet.'"
      (retry)="approvals.reload()"
    >
      <div class="table-wrap">
        <table class="table">
          <caption class="visually-hidden">
            Approval requests
          </caption>
          <thead>
            <tr>
              <th scope="col">Operation</th>
              <th scope="col">Status</th>
              <th scope="col">Commit</th>
              <th scope="col">Requested by</th>
              <th scope="col">Expires</th>
            </tr>
          </thead>
          <tbody>
            @for (a of approvals.value() ?? []; track a.id) {
              <tr>
                <td>
                  <a [routerLink]="['/o', orgId(), 'approvals', a.id]">{{ a.operationKind | humanize }}</a>
                </td>
                <td><acr-badge [value]="a.status" /></td>
                <td>
                  <code>{{ a.headSha | shortSha }}</code>
                </td>
                <td>{{ a.requestedBy.display }}</td>
                <td>{{ a.expiresAt | date: 'short' }}</td>
              </tr>
            }
          </tbody>
        </table>
      </div>
    </acr-async-state>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ApprovalsPage {
  private readonly api = inject(DashboardApi);
  readonly orgId = input.required<string>();

  protected readonly scope = signal<'open' | 'all'>('open');
  protected readonly approvals = httpResource(
    () => this.api.orgUrl(this.orgId(), `/approvals${queryString({ scope: this.scope() })}`),
    { parse: (v) => z.array(ApprovalSummarySchema).parse(v) },
  );
  protected readonly error = computed(() => (this.approvals.error() ? errorMessage(this.approvals.error()) : null));
}
