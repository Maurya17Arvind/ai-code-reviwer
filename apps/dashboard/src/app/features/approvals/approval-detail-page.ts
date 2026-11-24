import { DatePipe, KeyValuePipe } from '@angular/common';
import { httpResource } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { ApprovalDetailSchema } from '@acra/shared-contracts';
import { errorMessage } from '../../core/api/api-error';
import { DashboardApi } from '../../core/api/dashboard-api';
import { hasRole } from '../../core/auth/roles';
import { SessionStore } from '../../core/auth/session.store';
import { AsyncState } from '../../shared/ui/async-state';
import { Badge } from '../../shared/ui/badge';
import { HumanizePipe } from '../../shared/ui/pipes';

/**
 * Approve or reject one request. Approving requires typing the request's 12-character code, which
 * is derived from everything the approval is bound to (commit, operation, patch hash, expiry):
 * the decision applies to exactly what is shown here (ADR-032).
 */
@Component({
  selector: 'acr-approval-detail-page',
  imports: [AsyncState, Badge, DatePipe, HumanizePipe, KeyValuePipe, ReactiveFormsModule, RouterLink],
  template: `
    <p><a [routerLink]="['/o', orgId(), 'approvals']">← Approvals</a></p>
    <acr-async-state
      [loading]="approval.isLoading()"
      [error]="loadError()"
      [hasData]="approval.hasValue()"
      (retry)="approval.reload()"
    >
      @if (approval.value(); as a) {
        <div class="page-header">
          <div>
            <h1>{{ a.operationKind | humanize }}</h1>
            <p class="muted">Requested by {{ a.requestedBy.display }} on {{ a.createdAt | date: 'medium' }}</p>
          </div>
          <acr-badge [value]="a.status" />
        </div>

        <section class="card" aria-labelledby="what-heading">
          <h2 id="what-heading">What will happen</h2>
          <ul data-testid="approval-description">
            @for (line of a.description; track $index) {
              <li>{{ line }}</li>
            }
          </ul>
          <dl class="details">
            <dt>Reviewed commit</dt>
            <dd>
              <code>{{ a.headSha }}</code>
            </dd>
            <dt>Patch SHA-256</dt>
            <dd>
              <code class="small">{{ a.patchSha256 ?? '—' }}</code>
            </dd>
            <dt>Expires</dt>
            <dd>{{ a.expiresAt | date: 'medium' }}</dd>
            @if (a.fixId) {
              <dt>Fix proposal</dt>
              <dd><a [routerLink]="['/o', orgId(), 'fixes', a.fixId]">view patch</a></dd>
            }
            @if (a.decidedBy) {
              <dt>Decided by</dt>
              <dd>{{ a.decidedBy.display }} · {{ a.decidedAt | date: 'medium' }}</dd>
            }
            @if (a.reason) {
              <dt>Reason</dt>
              <dd>{{ a.reason }}</dd>
            }
          </dl>
        </section>

        @if (a.result; as result) {
          <h2>Result</h2>
          <dl class="details card">
            @for (entry of result | keyvalue; track entry.key) {
              <dt>{{ entry.key }}</dt>
              <dd>
                @if (isUrl(entry.value)) {
                  <a [href]="entry.value" target="_blank" rel="noopener noreferrer">{{ entry.value }}</a>
                } @else {
                  {{ entry.value }}
                }
              </dd>
            }
          </dl>
        }

        @if (feedback(); as f) {
          <p
            class="banner"
            [class.banner-ok]="f.ok"
            [class.banner-error]="!f.ok"
            role="status"
            data-testid="decision-feedback"
          >
            {{ f.text }}
          </p>
        }

        @if (a.status === 'pending') {
          @if (canDecide()) {
            <h2>Decision</h2>
            <form class="form card" [formGroup]="approveForm" (ngSubmit)="approve()" aria-label="Approve request">
              <p>
                To approve, type the code
                <span class="code-box" data-testid="approval-code">{{ a.approvalCode }}</span>. It confirms you checked
                the commit, patch and operation above.
              </p>
              <div class="field">
                <label for="code">Approval code</label>
                <input
                  id="code"
                  type="text"
                  formControlName="code"
                  autocomplete="off"
                  spellcheck="false"
                  maxlength="12"
                />
              </div>
              <button type="submit" class="btn btn-primary" [disabled]="approveForm.invalid || busy()">
                Approve and run
              </button>
            </form>
            <form class="form card" [formGroup]="rejectForm" (ngSubmit)="reject()" aria-label="Reject request">
              <div class="field">
                <label for="reason">Reason for rejecting (optional)</label>
                <textarea id="reason" formControlName="reason" rows="2" maxlength="500"></textarea>
              </div>
              <button type="submit" class="btn btn-danger" [disabled]="busy()">Reject</button>
            </form>
          } @else {
            <p class="muted">Viewers cannot decide approvals.</p>
          }
        }
      }
    </acr-async-state>
  `,
  styles: `
    form + form {
      margin-top: 1rem;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ApprovalDetailPage {
  private readonly api = inject(DashboardApi);
  private readonly session = inject(SessionStore);
  private readonly fb = inject(NonNullableFormBuilder);
  readonly orgId = input.required<string>();
  readonly approvalId = input.required<string>();

  protected readonly approval = httpResource(() => this.api.orgUrl(this.orgId(), `/approvals/${this.approvalId()}`), {
    parse: (v) => ApprovalDetailSchema.parse(v),
  });
  protected readonly loadError = computed(() => (this.approval.error() ? errorMessage(this.approval.error()) : null));
  protected readonly canDecide = computed(() => hasRole(this.session.membership(this.orgId())?.role, 'MEMBER'));
  protected readonly approveForm = this.fb.group({
    code: ['', [Validators.required, Validators.pattern(/^\s*[0-9a-fA-F]{12}\s*$/)]],
  });
  protected readonly rejectForm = this.fb.group({ reason: ['', Validators.maxLength(500)] });
  protected readonly busy = signal(false);
  protected readonly feedback = signal<{ ok: boolean; text: string } | null>(null);

  protected isUrl(value: unknown): value is string {
    return typeof value === 'string' && /^https:\/\//.test(value);
  }

  protected async approve(): Promise<void> {
    if (this.approveForm.invalid || this.busy()) return;
    await this.decide(async () => {
      const result = await this.api.approve(
        this.orgId(),
        this.approvalId(),
        this.approveForm.controls.code.value.trim(),
      );
      return `Approved. Execution was queued (job ${result.jobId ?? '-'}); refresh to see the result.`;
    });
  }

  protected async reject(): Promise<void> {
    if (this.busy()) return;
    await this.decide(async () => {
      await this.api.reject(this.orgId(), this.approvalId(), this.rejectForm.controls.reason.value.trim());
      return 'Rejected. Nothing will be written.';
    });
  }

  private async decide(action: () => Promise<string>): Promise<void> {
    this.busy.set(true);
    this.feedback.set(null);
    try {
      this.feedback.set({ ok: true, text: await action() });
      this.approveForm.reset();
      this.approval.reload();
    } catch (error) {
      this.feedback.set({ ok: false, text: errorMessage(error) });
    } finally {
      this.busy.set(false);
    }
  }
}
