import { httpResource } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { UsageResponseSchema } from '@acra/shared-contracts';
import { errorMessage } from '../../core/api/api-error';
import { DashboardApi, queryString } from '../../core/api/dashboard-api';
import { AsyncState } from '../../shared/ui/async-state';
import { BarChart } from '../../shared/ui/bar-chart';
import { CountPipe, UsdPipe } from '../../shared/ui/pipes';

const PERIODS = [7, 30, 90] as const;

/** AI usage and estimated cost per provider/model, from recorded model executions. */
@Component({
  selector: 'acr-usage-page',
  imports: [AsyncState, BarChart, CountPipe, UsdPipe],
  template: `
    <div class="page-header">
      <div>
        <h1>Usage and cost</h1>
        <p class="muted">Estimated from token counts and configured prices; your provider invoice is authoritative.</p>
      </div>
      <div class="segmented" role="group" aria-label="Period">
        @for (p of periods; track p) {
          <button type="button" class="btn btn-small" [attr.aria-pressed]="days() === p" (click)="days.set(p)">
            {{ p }} days
          </button>
        }
      </div>
    </div>

    <acr-async-state
      [loading]="usage.isLoading()"
      [error]="error()"
      [hasData]="usage.hasValue()"
      (retry)="usage.reload()"
    >
      @if (usage.value(); as u) {
        <div class="grid">
          <div class="card stat">
            <div class="stat-value" data-testid="total-cost">
              {{ u.totals.costUsd + u.totals.fixProposalCostUsd | usd }}
            </div>
            <div class="stat-label">
              Estimated cost (reviews {{ u.totals.costUsd | usd }}, fixes {{ u.totals.fixProposalCostUsd | usd }})
            </div>
          </div>
          <div class="card stat">
            <div class="stat-value">{{ u.totals.executions | count }}</div>
            <div class="stat-label">Model runs ({{ u.totals.failures | count }} failed)</div>
          </div>
          <div class="card stat">
            <div class="stat-value">{{ u.totals.inputTokens + u.totals.outputTokens | count }}</div>
            <div class="stat-label">
              Tokens ({{ u.totals.inputTokens | count }} in, {{ u.totals.outputTokens | count }} out)
            </div>
          </div>
          @if (u.totals.unpricedExecutions > 0) {
            <div class="card stat">
              <div class="stat-value">{{ u.totals.unpricedExecutions | count }}</div>
              <div class="stat-label">Runs without a price (local or unpriced models)</div>
            </div>
          }
        </div>

        <div class="card chart-card">
          <acr-bar-chart title="Estimated cost per day" [data]="costSeries()" [format]="formatUsd" />
        </div>

        <h2>By model</h2>
        <div class="table-wrap">
          <table class="table">
            <caption class="visually-hidden">
              Usage by model
            </caption>
            <thead>
              <tr>
                <th scope="col">Provider</th>
                <th scope="col">Model</th>
                <th scope="col" class="num">Runs</th>
                <th scope="col" class="num">Failed</th>
                <th scope="col" class="num">Input tokens</th>
                <th scope="col" class="num">Output tokens</th>
                <th scope="col" class="num">Cache reads</th>
                <th scope="col" class="num">Cost</th>
              </tr>
            </thead>
            <tbody>
              @for (m of u.byModel; track m.provider + m.model) {
                <tr>
                  <td>{{ m.provider }}</td>
                  <td>{{ m.model }}</td>
                  <td class="num">{{ m.executions | count }}</td>
                  <td class="num">{{ m.failures | count }}</td>
                  <td class="num">{{ m.inputTokens | count }}</td>
                  <td class="num">{{ m.outputTokens | count }}</td>
                  <td class="num">{{ m.cacheReadTokens | count }}</td>
                  <td class="num">{{ m.costUsd | usd }}{{ m.unpricedExecutions > 0 ? ' *' : '' }}</td>
                </tr>
              } @empty {
                <tr>
                  <td colspan="8" class="muted">No AI usage in this period.</td>
                </tr>
              }
            </tbody>
          </table>
        </div>
        @if (u.totals.unpricedExecutions > 0) {
          <p class="muted small">
            * Some runs have no price (local models or models without configured pricing) and count as $0.
          </p>
        }
      }
    </acr-async-state>
  `,
  styles: `
    .chart-card {
      margin-top: 1rem;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class UsagePage {
  private readonly api = inject(DashboardApi);
  readonly orgId = input.required<string>();

  protected readonly periods = PERIODS;
  protected readonly days = signal<number>(30);
  protected readonly usage = httpResource(
    () => this.api.orgUrl(this.orgId(), `/usage${queryString({ days: this.days() })}`),
    {
      parse: (v) => UsageResponseSchema.parse(v),
    },
  );
  protected readonly error = computed(() => (this.usage.error() ? errorMessage(this.usage.error()) : null));
  protected readonly costSeries = computed(() =>
    (this.usage.value()?.daily ?? []).map((d) => ({ label: d.date, value: d.costUsd })),
  );
  private readonly usd = new UsdPipe();
  protected readonly formatUsd = (value: number) => this.usd.transform(value);
}
