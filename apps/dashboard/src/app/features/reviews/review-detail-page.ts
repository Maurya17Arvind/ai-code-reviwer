import { DatePipe, DecimalPipe } from '@angular/common';
import { httpResource } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ReviewDetailSchema } from '@acra/shared-contracts';
import { errorMessage } from '../../core/api/api-error';
import { DashboardApi } from '../../core/api/dashboard-api';
import { AsyncState } from '../../shared/ui/async-state';
import { Badge } from '../../shared/ui/badge';
import { CountPipe, HumanizePipe, Percent0Pipe, ShortShaPipe, UsdPipe } from '../../shared/ui/pipes';

/** One review: commits, per-model executions (tokens, cost, failures) and the findings it produced. */
@Component({
  selector: 'acr-review-detail-page',
  imports: [
    AsyncState,
    Badge,
    CountPipe,
    DatePipe,
    DecimalPipe,
    HumanizePipe,
    Percent0Pipe,
    RouterLink,
    ShortShaPipe,
    UsdPipe,
  ],
  template: `
    <p><a [routerLink]="['/o', orgId(), 'reviews']">← Reviews</a></p>
    <acr-async-state
      [loading]="review.isLoading()"
      [error]="error()"
      [hasData]="review.hasValue()"
      (retry)="review.reload()"
    >
      @if (review.value(); as r) {
        <div class="page-header">
          <div>
            <h1>{{ r.repositoryName }} {{ r.provider === 'GITLAB' ? '!' : '#' }}{{ r.requestId }}</h1>
            <p class="muted">
              Review of commit <code>{{ r.headSha | shortSha }}</code>
            </p>
          </div>
          <acr-badge [value]="r.status" />
        </div>

        @if (r.statusReason) {
          <p class="banner" [class.banner-error]="r.status === 'failed'" [class.banner-info]="r.status !== 'failed'">
            {{ r.statusReason }}
          </p>
        }

        <div class="card">
          <dl class="details">
            <dt>Head commit</dt>
            <dd>
              <code>{{ r.headSha }}</code>
            </dd>
            <dt>Base commit</dt>
            <dd>
              <code>{{ r.baseSha ?? '—' }}</code>
            </dd>
            <dt>Started</dt>
            <dd>{{ r.createdAt | date: 'medium' }}</dd>
            <dt>Finished</dt>
            <dd>{{ r.finishedAt ? (r.finishedAt | date: 'medium') : '—' }}</dd>
            <dt>Comments</dt>
            <dd>{{ r.comments.inline }} inline, {{ r.comments.summary }} summary</dd>
            <dt>AI cost</dt>
            <dd>{{ r.costUsd | usd }}</dd>
            @if (r.repositoryWebUrl) {
              <dt>Repository</dt>
              <dd>
                <a [href]="r.repositoryWebUrl" target="_blank" rel="noopener noreferrer">{{ r.repositoryWebUrl }}</a>
              </dd>
            }
          </dl>
        </div>

        <h2>AI reviewers</h2>
        <div class="table-wrap">
          <table class="table">
            <thead>
              <tr>
                <th scope="col">Provider</th>
                <th scope="col">Model</th>
                <th scope="col">Result</th>
                <th scope="col" class="num">Input tokens</th>
                <th scope="col" class="num">Output tokens</th>
                <th scope="col" class="num">Latency</th>
                <th scope="col" class="num">Cost</th>
              </tr>
            </thead>
            <tbody>
              @for (e of r.executions; track e.id) {
                <tr>
                  <td>{{ e.provider }}</td>
                  <td>
                    {{ e.model }}
                    @if (e.servedByModel && e.servedByModel !== e.model) {
                      <div class="muted small">served by {{ e.servedByModel }}</div>
                    }
                  </td>
                  <td>
                    <acr-badge [value]="e.status" />
                    @if (e.errorKind) {
                      <div class="muted small">{{ e.errorKind | humanize }}</div>
                    }
                  </td>
                  <td class="num">{{ e.inputTokens | count }}</td>
                  <td class="num">{{ e.outputTokens | count }}</td>
                  <td class="num">{{ e.latencyMs / 1000 | number: '1.1-1' }} s</td>
                  <td class="num">{{ e.costUsd | usd }}</td>
                </tr>
              } @empty {
                <tr>
                  <td colspan="7" class="muted">No AI reviewer ran for this review.</td>
                </tr>
              }
            </tbody>
          </table>
        </div>

        <h2>Findings</h2>
        <div class="table-wrap">
          <table class="table">
            <thead>
              <tr>
                <th scope="col">Severity</th>
                <th scope="col">Finding</th>
                <th scope="col">Location</th>
                <th scope="col">Status</th>
                <th scope="col" class="num">Confidence</th>
              </tr>
            </thead>
            <tbody>
              @for (f of r.findings; track f.id) {
                <tr>
                  <td><acr-badge [value]="f.severity" /></td>
                  <td>
                    <a [routerLink]="['/o', orgId(), 'findings', f.id]">{{ f.title }}</a>
                  </td>
                  <td>
                    <code>{{ f.filePath }}{{ f.lineNumber ? ':' + f.lineNumber : '' }}</code>
                  </td>
                  <td><acr-badge [value]="f.status" /></td>
                  <td class="num">{{ f.confidence | percent0 }}</td>
                </tr>
              } @empty {
                <tr>
                  <td colspan="5" class="muted">No findings were reported in this review.</td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      }
    </acr-async-state>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ReviewDetailPage {
  private readonly api = inject(DashboardApi);
  readonly orgId = input.required<string>();
  readonly reviewId = input.required<string>();

  protected readonly review = httpResource(() => this.api.orgUrl(this.orgId(), `/reviews/${this.reviewId()}`), {
    parse: (v) => ReviewDetailSchema.parse(v),
  });
  protected readonly error = computed(() => (this.review.error() ? errorMessage(this.review.error()) : null));
}
