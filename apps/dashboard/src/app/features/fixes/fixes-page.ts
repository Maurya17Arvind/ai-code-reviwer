import { DatePipe } from '@angular/common';
import { httpResource } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { FixSummarySchema } from '@acra/shared-contracts';
import * as z from 'zod/mini';
import { errorMessage } from '../../core/api/api-error';
import { DashboardApi } from '../../core/api/dashboard-api';
import { AsyncState } from '../../shared/ui/async-state';
import { Badge } from '../../shared/ui/badge';

/** AI fix proposals. Generating is automatic; every write needs an approval. */
@Component({
  selector: 'acr-fixes-page',
  imports: [AsyncState, Badge, DatePipe, RouterLink],
  template: `
    <div class="page-header">
      <div>
        <h1>Fix proposals</h1>
        <p class="muted">
          Patches are computed by the platform from validated model edits. Nothing is written without approval.
        </p>
      </div>
    </div>
    <acr-async-state
      [loading]="fixes.isLoading()"
      [error]="error()"
      [hasData]="fixes.hasValue()"
      [empty]="(fixes.value() ?? []).length === 0"
      emptyText="No fix proposals yet. Enable fixes in ai-review.yaml (fixes.enabled: true) and allow them in the review policy."
      (retry)="fixes.reload()"
    >
      <div class="table-wrap">
        <table class="table">
          <caption class="visually-hidden">
            Fix proposals
          </caption>
          <thead>
            <tr>
              <th scope="col">Finding</th>
              <th scope="col">Repository</th>
              <th scope="col">File</th>
              <th scope="col">Change</th>
              <th scope="col">Status</th>
              <th scope="col">Proposed</th>
            </tr>
          </thead>
          <tbody>
            @for (f of fixes.value() ?? []; track f.id) {
              <tr>
                <td>
                  <a [routerLink]="['/o', orgId(), 'fixes', f.id]">{{ f.findingTitle }}</a>
                  <div><acr-badge [value]="f.severity" /></div>
                </td>
                <td>{{ f.repositoryName }} {{ f.requestId }}</td>
                <td>
                  <code>{{ f.filePath }}</code>
                </td>
                <td>
                  <span class="add">+{{ f.additions }}</span> <span class="del">−{{ f.deletions }}</span>
                </td>
                <td><acr-badge [value]="f.status" /></td>
                <td>{{ f.createdAt | date: 'short' }}</td>
              </tr>
            }
          </tbody>
        </table>
      </div>
    </acr-async-state>
  `,
  styles: `
    .add {
      color: var(--color-success);
    }
    .del {
      color: var(--color-danger);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FixesPage {
  private readonly api = inject(DashboardApi);
  readonly orgId = input.required<string>();

  protected readonly fixes = httpResource(() => this.api.orgUrl(this.orgId(), '/fixes'), {
    parse: (v) => z.array(FixSummarySchema).parse(v),
  });
  protected readonly error = computed(() => (this.fixes.error() ? errorMessage(this.fixes.error()) : null));
}
