import { DatePipe } from '@angular/common';
import { httpResource } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, effect, inject, input, signal, untracked } from '@angular/core';
import { RouterLink } from '@angular/router';
import {
  RepositorySchema,
  ReviewSessionStatusSchema,
  type ReviewSummary,
  ReviewSummarySchema,
} from '@acra/shared-contracts';
import * as z from 'zod/mini';
import { DashboardApi, queryString } from '../../core/api/dashboard-api';
import { PagedList } from '../../core/api/paged-list';
import { AsyncState } from '../../shared/ui/async-state';
import { Badge } from '../../shared/ui/badge';
import { HumanizePipe, ShortShaPipe, UsdPipe } from '../../shared/ui/pipes';

/** Review history: every review session, newest first, filterable by repository and outcome. */
@Component({
  selector: 'acr-reviews-page',
  imports: [AsyncState, Badge, DatePipe, HumanizePipe, RouterLink, ShortShaPipe, UsdPipe],
  template: `
    <div class="page-header">
      <div>
        <h1>Reviews</h1>
        <p class="muted">One review per reviewed commit of a merge or pull request.</p>
      </div>
    </div>

    <div class="filters" role="search" aria-label="Filter reviews">
      <div class="field">
        <label for="f-repo">Repository</label>
        <select id="f-repo" [value]="repositoryId()" (change)="repositoryId.set(value($event))">
          <option value="">All repositories</option>
          @for (r of repositories.value() ?? []; track r.id) {
            <option [value]="r.id">{{ r.fullName }}</option>
          }
        </select>
      </div>
      <div class="field">
        <label for="f-status">Outcome</label>
        <select id="f-status" [value]="status()" (change)="status.set(value($event))">
          <option value="">All outcomes</option>
          @for (s of statuses; track s) {
            <option [value]="s">{{ s | humanize }}</option>
          }
        </select>
      </div>
    </div>

    <acr-async-state
      [loading]="list.loading()"
      [error]="list.error()"
      [empty]="list.isEmpty()"
      [hasData]="list.items().length > 0"
      emptyText="No reviews yet. Reviews appear when a connected repository opens or updates a merge/pull request."
      (retry)="list.load()"
    >
      <div class="table-wrap">
        <table class="table">
          <caption class="visually-hidden">
            Reviews
          </caption>
          <thead>
            <tr>
              <th scope="col">Started</th>
              <th scope="col">Repository</th>
              <th scope="col">MR / PR</th>
              <th scope="col">Commit</th>
              <th scope="col">Outcome</th>
              <th scope="col" class="num">Findings</th>
              <th scope="col" class="num">AI cost</th>
            </tr>
          </thead>
          <tbody>
            @for (r of list.items(); track r.id) {
              <tr>
                <td>
                  <a [routerLink]="['/o', orgId(), 'reviews', r.id]">{{ r.createdAt | date: 'short' }}</a>
                </td>
                <td>{{ r.repositoryName }}</td>
                <td>{{ requestLabel(r) }}</td>
                <td>
                  <code>{{ r.headSha | shortSha }}</code>
                </td>
                <td>
                  <acr-badge [value]="r.status" />
                  @if (r.statusReason) {
                    <div class="muted small">{{ r.statusReason }}</div>
                  }
                </td>
                <td class="num">{{ r.findingCount }}</td>
                <td class="num">{{ r.costUsd | usd }}</td>
              </tr>
            }
          </tbody>
        </table>
      </div>
      @if (list.hasMore()) {
        <div class="load-more">
          <button type="button" class="btn" (click)="list.loadMore()" [disabled]="list.loading()">
            {{ list.loading() ? 'Loading…' : 'Load more' }}
          </button>
        </div>
      }
    </acr-async-state>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ReviewsPage {
  private readonly api = inject(DashboardApi);
  readonly orgId = input.required<string>();

  protected readonly statuses = ReviewSessionStatusSchema.options;
  protected readonly repositoryId = signal('');
  protected readonly status = signal('');
  protected readonly repositories = httpResource(() => this.api.orgUrl(this.orgId(), '/repositories'), {
    parse: (v) => z.array(RepositorySchema).parse(v),
  });
  protected readonly list = new PagedList<ReviewSummary>((cursor) =>
    this.api.page(
      this.api.orgUrl(
        this.orgId(),
        `/reviews${queryString({ repositoryId: this.repositoryId(), status: this.status(), cursor, limit: 25 })}`,
      ),
      ReviewSummarySchema,
    ),
  );

  constructor() {
    effect(() => {
      this.orgId();
      this.repositoryId();
      this.status();
      untracked(() => void this.list.load());
    });
  }

  protected value(event: Event): string {
    return (event.target as HTMLSelectElement).value;
  }

  protected requestLabel(r: ReviewSummary): string {
    if (r.requestId === null) return '—';
    return r.provider === 'GITLAB' ? `!${r.requestId}` : `#${r.requestId}`;
  }
}
