import { DatePipe } from '@angular/common';
import { httpResource } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, effect, inject, input, signal, untracked } from '@angular/core';
import { RouterLink } from '@angular/router';
import { type FindingSummary, FindingSummarySchema, RepositorySchema } from '@acra/shared-contracts';
import { FindingStatusSchema, ReviewCategorySchema, SEVERITY_ORDER } from '@acra/shared-types';
import * as z from 'zod/mini';
import { DashboardApi, queryString } from '../../core/api/dashboard-api';
import { PagedList } from '../../core/api/paged-list';
import { AsyncState } from '../../shared/ui/async-state';
import { Badge } from '../../shared/ui/badge';
import { HumanizePipe, Percent0Pipe } from '../../shared/ui/pipes';

/** Findings across all reviews with severity / status / category / repository filters. */
@Component({
  selector: 'acr-findings-page',
  imports: [AsyncState, Badge, DatePipe, HumanizePipe, Percent0Pipe, RouterLink],
  template: `
    <div class="page-header">
      <div>
        <h1>Findings</h1>
        <p class="muted">Each issue is tracked across commits of its merge or pull request.</p>
      </div>
    </div>

    <div class="filters" role="search" aria-label="Filter findings">
      <div class="field">
        <label for="f-severity">Severity</label>
        <select
          id="f-severity"
          [value]="severity()"
          (change)="severity.set(value($event))"
          data-testid="filter-severity"
        >
          <option value="">All severities</option>
          @for (s of severities; track s) {
            <option [value]="s">{{ s | humanize }}</option>
          }
        </select>
      </div>
      <div class="field">
        <label for="f-status">Status</label>
        <select id="f-status" [value]="status()" (change)="status.set(value($event))">
          <option value="">All statuses</option>
          @for (s of statuses; track s) {
            <option [value]="s">{{ s | humanize }}</option>
          }
        </select>
      </div>
      <div class="field">
        <label for="f-category">Category</label>
        <select id="f-category" [value]="category()" (change)="category.set(value($event))">
          <option value="">All categories</option>
          @for (c of categories; track c) {
            <option [value]="c">{{ c | humanize }}</option>
          }
        </select>
      </div>
      <div class="field">
        <label for="f-repo">Repository</label>
        <select id="f-repo" [value]="repositoryId()" (change)="repositoryId.set(value($event))">
          <option value="">All repositories</option>
          @for (r of repositories.value() ?? []; track r.id) {
            <option [value]="r.id">{{ r.fullName }}</option>
          }
        </select>
      </div>
      @if (filtered()) {
        <button type="button" class="btn btn-small" (click)="clear()">Clear filters</button>
      }
    </div>

    <acr-async-state
      [loading]="list.loading()"
      [error]="list.error()"
      [empty]="list.isEmpty()"
      [hasData]="list.items().length > 0"
      [emptyText]="filtered() ? 'No findings match these filters.' : 'No findings yet.'"
      (retry)="list.load()"
    >
      <div class="table-wrap">
        <table class="table">
          <caption class="visually-hidden">
            Findings
          </caption>
          <thead>
            <tr>
              <th scope="col">Severity</th>
              <th scope="col">Finding</th>
              <th scope="col">Repository</th>
              <th scope="col">Location</th>
              <th scope="col">Status</th>
              <th scope="col" class="num">Confidence</th>
              <th scope="col">First seen</th>
            </tr>
          </thead>
          <tbody>
            @for (f of list.items(); track f.id) {
              <tr>
                <td><acr-badge [value]="f.severity" /></td>
                <td>
                  <a [routerLink]="['/o', orgId(), 'findings', f.id]">{{ f.title }}</a>
                  <div class="muted small">{{ f.category | humanize }} · {{ f.sources.join(', ') }}</div>
                </td>
                <td>{{ f.repositoryName }}</td>
                <td>
                  <code>{{ f.filePath }}{{ f.lineNumber ? ':' + f.lineNumber : '' }}</code>
                </td>
                <td><acr-badge [value]="f.status" /></td>
                <td class="num">{{ f.confidence | percent0 }}</td>
                <td>{{ f.createdAt | date: 'short' }}</td>
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
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FindingsPage {
  private readonly api = inject(DashboardApi);
  readonly orgId = input.required<string>();

  protected readonly severities = SEVERITY_ORDER;
  protected readonly statuses = FindingStatusSchema.options;
  protected readonly categories = ReviewCategorySchema.options;
  protected readonly severity = signal('');
  protected readonly status = signal('');
  protected readonly category = signal('');
  protected readonly repositoryId = signal('');
  protected readonly repositories = httpResource(() => this.api.orgUrl(this.orgId(), '/repositories'), {
    parse: (v) => z.array(RepositorySchema).parse(v),
  });
  protected readonly list = new PagedList<FindingSummary>((cursor) =>
    this.api.page(
      this.api.orgUrl(
        this.orgId(),
        `/findings${queryString({
          severity: this.severity(),
          status: this.status(),
          category: this.category(),
          repositoryId: this.repositoryId(),
          cursor,
          limit: 25,
        })}`,
      ),
      FindingSummarySchema,
    ),
  );

  constructor() {
    effect(() => {
      this.orgId();
      this.severity();
      this.status();
      this.category();
      this.repositoryId();
      untracked(() => void this.list.load());
    });
  }

  protected filtered(): boolean {
    return Boolean(this.severity() || this.status() || this.category() || this.repositoryId());
  }

  protected clear(): void {
    this.severity.set('');
    this.status.set('');
    this.category.set('');
    this.repositoryId.set('');
  }

  protected value(event: Event): string {
    return (event.target as HTMLSelectElement).value;
  }
}
