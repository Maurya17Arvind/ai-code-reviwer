import { httpResource } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { AnalyticsResponseSchema } from '@acra/shared-contracts';
import { SEVERITY_ORDER } from '@acra/shared-types';
import { errorMessage } from '../../core/api/api-error';
import { DashboardApi, queryString } from '../../core/api/dashboard-api';
import { AsyncState } from '../../shared/ui/async-state';
import { Badge } from '../../shared/ui/badge';
import { BarChart } from '../../shared/ui/bar-chart';
import { CountPipe, HumanizePipe, Percent0Pipe } from '../../shared/ui/pipes';

const PERIODS = [7, 30, 90] as const;

/** Review analytics for the organization (reviews, findings, triage, fixes, approvals). */
@Component({
  selector: 'acr-overview-page',
  imports: [AsyncState, Badge, BarChart, CountPipe, HumanizePipe, Percent0Pipe, RouterLink],
  template: `
    <div class="page-header">
      <div>
        <h1>Overview</h1>
        <p class="muted">Review activity in the last {{ days() }} days.</p>
      </div>
      <div class="segmented" role="group" aria-label="Period">
        @for (p of periods; track p) {
          <button
            type="button"
            class="btn btn-small"
            [attr.aria-pressed]="days() === p"
            (click)="days.set(p)"
          >
            {{ p }} days
          </button>
        }
      </div>
    </div>

    <acr-async-state
      [loading]="analytics.isLoading()"
      [error]="error()"
      [hasData]="analytics.hasValue()"
      (retry)="analytics.reload()"
    >
      @if (analytics.value(); as a) {
        <div class="grid">
          <a class="card stat" [routerLink]="['/o', orgId(), 'reviews']">
            <div class="stat-value">{{ a.reviews.total | count }}</div>
            <div class="stat-label">Reviews</div>
          </a>
          <a class="card stat" [routerLink]="['/o', orgId(), 'findings']">
            <div class="stat-value">{{ a.findings.total | count }}</div>
            <div class="stat-label">New findings ({{ a.findings.published | count }} published)</div>
          </a>
          <div class="card stat">
            <div class="stat-value">{{ a.falsePositiveRate | percent0 }}</div>
            <div class="stat-label">False-positive rate of triaged findings</div>
          </div>
          <a class="card stat" [routerLink]="['/o', orgId(), 'approvals']">
            <div class="stat-value">{{ a.approvals.byStatus['pending'] ?? 0 }}</div>
            <div class="stat-label">Pending approvals</div>
          </a>
        </div>

        <div class="grid two">
          <div class="card">
            <acr-bar-chart title="Reviews per day" [data]="reviewSeries()" />
          </div>
          <div class="card">
            <acr-bar-chart title="New findings per day" [data]="findingSeries()" />
          </div>
        </div>

        <div class="grid two">
          <section class="card" aria-labelledby="sev-heading">
            <h2 id="sev-heading">Findings by severity</h2>
            <table class="table">
              <tbody>
                @for (s of severities; track s) {
                  <tr>
                    <td><acr-badge [value]="s" /></td>
                    <td class="num">{{ a.findings.bySeverity[s] ?? 0 }}</td>
                  </tr>
                }
              </tbody>
            </table>
          </section>
          <section class="card" aria-labelledby="cat-heading">
            <h2 id="cat-heading">Findings by category</h2>
            <table class="table">
              <tbody>
                @for (c of categories(); track c.key) {
                  <tr>
                    <td>{{ c.key | humanize }}</td>
                    <td class="num">{{ c.count }}</td>
                  </tr>
                } @empty {
                  <tr>
                    <td class="muted">No findings in this period.</td>
                  </tr>
                }
              </tbody>
            </table>
          </section>
          <section class="card" aria-labelledby="rev-heading">
            <h2 id="rev-heading">Review outcomes</h2>
            <table class="table">
              <tbody>
                @for (r of entries(a.reviews.byStatus); track r.key) {
                  <tr>
                    <td><acr-badge [value]="r.key" /></td>
                    <td class="num">{{ r.count }}</td>
                  </tr>
                } @empty {
                  <tr>
                    <td class="muted">No reviews in this period.</td>
                  </tr>
                }
              </tbody>
            </table>
          </section>
          <section class="card" aria-labelledby="fix-heading">
            <h2 id="fix-heading">Fix proposals</h2>
            <table class="table">
              <tbody>
                @for (f of entries(a.fixes.byStatus); track f.key) {
                  <tr>
                    <td><acr-badge [value]="f.key" /></td>
                    <td class="num">{{ f.count }}</td>
                  </tr>
                } @empty {
                  <tr>
                    <td class="muted">No fix proposals in this period.</td>
                  </tr>
                }
              </tbody>
            </table>
          </section>
        </div>
      }
    </acr-async-state>
  `,
  styles: `
    .grid.two {
      grid-template-columns: repeat(auto-fit, minmax(18rem, 1fr));
      margin-top: 1rem;
    }
    h2 {
      margin-top: 0;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class OverviewPage {
  private readonly api = inject(DashboardApi);
  readonly orgId = input.required<string>();

  protected readonly periods = PERIODS;
  protected readonly severities = SEVERITY_ORDER;
  protected readonly days = signal<number>(30);
  protected readonly analytics = httpResource(
    () => this.api.orgUrl(this.orgId(), `/analytics${queryString({ days: this.days() })}`),
    { parse: (value) => AnalyticsResponseSchema.parse(value) },
  );
  protected readonly error = computed(() => (this.analytics.error() ? errorMessage(this.analytics.error()) : null));
  protected readonly reviewSeries = computed(() =>
    (this.analytics.value()?.daily ?? []).map((d) => ({ label: d.date, value: d.reviews })),
  );
  protected readonly findingSeries = computed(() =>
    (this.analytics.value()?.daily ?? []).map((d) => ({ label: d.date, value: d.findings })),
  );
  protected readonly categories = computed(() => this.entries(this.analytics.value()?.findings.byCategory ?? {}));

  protected entries(record: Record<string, number>): Array<{ key: string; count: number }> {
    return Object.entries(record)
      .map(([key, count]) => ({ key, count }))
      .sort((a, b) => b.count - a.count);
  }
}
