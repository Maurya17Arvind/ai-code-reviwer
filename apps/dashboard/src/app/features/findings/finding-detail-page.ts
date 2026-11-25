import { DatePipe } from '@angular/common';
import { httpResource } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { FindingDetailSchema } from '@acra/shared-contracts';
import { errorMessage } from '../../core/api/api-error';
import { DashboardApi } from '../../core/api/dashboard-api';
import { hasRole } from '../../core/auth/roles';
import { SessionStore } from '../../core/auth/session.store';
import { AsyncState } from '../../shared/ui/async-state';
import { Badge } from '../../shared/ui/badge';
import { HumanizePipe, Percent0Pipe, ShortShaPipe } from '../../shared/ui/pipes';

/**
 * One finding with its evidence and lifecycle. Model-written text is untrusted: it is rendered with
 * interpolation only (Angular escapes it), never as HTML or Markdown.
 */
@Component({
  selector: 'acr-finding-detail-page',
  imports: [AsyncState, Badge, DatePipe, HumanizePipe, Percent0Pipe, ReactiveFormsModule, RouterLink, ShortShaPipe],
  template: `
    <p><a [routerLink]="['/o', orgId(), 'findings']">← Findings</a></p>
    <acr-async-state
      [loading]="finding.isLoading()"
      [error]="loadError()"
      [hasData]="finding.hasValue()"
      (retry)="finding.reload()"
    >
      @if (finding.value(); as f) {
        <div class="page-header">
          <div>
            <h1 data-testid="finding-title">{{ f.title }}</h1>
            <p class="muted">
              {{ f.repositoryName }} ·
              <code
                >{{ f.filePath }}{{ f.lineNumber ? ':' + f.lineNumber : ''
                }}{{ f.endLineNumber && f.endLineNumber !== f.lineNumber ? '–' + f.endLineNumber : '' }}</code
              >
            </p>
          </div>
          <div class="row">
            <acr-badge [value]="f.severity" />
            <acr-badge [value]="f.status" />
          </div>
        </div>

        <div class="card">
          <dl class="details">
            <dt>Category</dt>
            <dd>{{ f.category | humanize }}</dd>
            <dt>Confidence</dt>
            <dd>{{ f.confidence | percent0 }}</dd>
            <dt>Reported by</dt>
            <dd>{{ f.sources.join(', ') }}</dd>
            <dt>Placement</dt>
            <dd>{{ f.placement === 'inline' ? 'Inline comment' : 'Review summary' }}</dd>
            <dt>First seen</dt>
            <dd>
              <code>{{ f.firstSeenSha | shortSha }}</code> · {{ f.createdAt | date: 'medium' }}
            </dd>
            <dt>Last seen</dt>
            <dd>
              <code>{{ f.lastSeenSha | shortSha }}</code> ·
              <a [routerLink]="['/o', orgId(), 'reviews', f.lastSessionId]">review</a>
            </dd>
          </dl>
        </div>

        <p class="muted small">
          The text below was written by an AI model and validated by the platform. Treat it as a suggestion.
        </p>
        <h2>Description <span class="ai-label">AI</span></h2>
        <p class="untrusted ai-content">{{ f.description }}</p>
        <h2>Evidence</h2>
        <pre class="untrusted">{{ f.evidence }}</pre>
        @if (f.suggestion) {
          <h2>Suggestion <span class="ai-label">AI</span></h2>
          <p class="untrusted ai-content">{{ f.suggestion }}</p>
        }

        @if (f.fixes.length > 0) {
          <h2>Fix proposals</h2>
          <ul>
            @for (fix of f.fixes; track fix.id) {
              <li>
                <a [routerLink]="['/o', orgId(), 'fixes', fix.id]">Fix from {{ fix.createdAt | date: 'short' }}</a>
                <acr-badge [value]="fix.status" />
              </li>
            }
          </ul>
        }

        <h2>Triage</h2>
        @if (message(); as m) {
          <p class="banner" [class.banner-ok]="m.ok" [class.banner-error]="!m.ok" role="status">{{ m.text }}</p>
        }
        @if (!canTriage()) {
          <p class="muted">Viewers cannot change finding status.</p>
        } @else if (f.allowedTransitions.length === 0) {
          <p class="muted">This finding is {{ f.status | humanize }}; future reviews will not report it again.</p>
        } @else {
          <form class="form card" [formGroup]="form" (ngSubmit)="submit()" aria-label="Triage finding">
            <fieldset>
              <legend>Mark this finding as</legend>
              @for (t of f.allowedTransitions; track t) {
                <label class="checkbox-row">
                  <input type="radio" formControlName="status" [value]="t" />
                  {{
                    t === 'false_positive'
                      ? 'False positive: the issue does not exist'
                      : 'Dismissed: real, but will not be fixed'
                  }}
                </label>
              }
            </fieldset>
            <div class="field">
              <label for="reason">Reason (optional, recorded in the audit log)</label>
              <textarea id="reason" formControlName="reason" rows="2" maxlength="500"></textarea>
            </div>
            <button type="submit" class="btn btn-primary" [disabled]="form.invalid || saving()">Save</button>
          </form>
        }
      }
    </acr-async-state>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FindingDetailPage {
  private readonly api = inject(DashboardApi);
  private readonly session = inject(SessionStore);
  private readonly fb = inject(NonNullableFormBuilder);
  readonly orgId = input.required<string>();
  readonly findingId = input.required<string>();

  protected readonly finding = httpResource(() => this.api.orgUrl(this.orgId(), `/findings/${this.findingId()}`), {
    parse: (v) => FindingDetailSchema.parse(v),
  });
  protected readonly loadError = computed(() => (this.finding.error() ? errorMessage(this.finding.error()) : null));
  protected readonly canTriage = computed(() => hasRole(this.session.membership(this.orgId())?.role, 'MEMBER'));
  protected readonly form = this.fb.group({
    status: this.fb.control<'' | 'dismissed' | 'false_positive'>('', Validators.required),
    reason: ['', Validators.maxLength(500)],
  });
  protected readonly saving = signal(false);
  protected readonly message = signal<{ ok: boolean; text: string } | null>(null);

  protected async submit(): Promise<void> {
    const { status, reason } = this.form.getRawValue();
    if (!status || this.saving()) return;
    this.saving.set(true);
    this.message.set(null);
    try {
      const updated = await this.api.updateFindingStatus(this.orgId(), this.findingId(), {
        status,
        ...(reason.trim() ? { reason: reason.trim() } : {}),
      });
      this.finding.set(updated);
      this.form.reset();
      this.message.set({ ok: true, text: 'Saved. Future reviews will not report this finding again.' });
    } catch (error) {
      this.message.set({ ok: false, text: errorMessage(error) });
    } finally {
      this.saving.set(false);
    }
  }
}
