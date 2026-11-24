import { DatePipe } from '@angular/common';
import { httpResource } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import {
  AiProviderStatusSchema,
  type OrganizationSettingsInput,
  OrganizationSettingsSchema,
} from '@acra/shared-contracts';
import { SEVERITY_ORDER, type Severity } from '@acra/shared-types';
import * as z from 'zod/mini';
import { errorMessage } from '../../core/api/api-error';
import { DashboardApi } from '../../core/api/dashboard-api';
import { hasRole } from '../../core/auth/roles';
import { SessionStore } from '../../core/auth/session.store';
import { AsyncState } from '../../shared/ui/async-state';
import { Badge } from '../../shared/ui/badge';
import { HumanizePipe } from '../../shared/ui/pipes';

const PROVIDER_LABELS = { claude: 'Anthropic Claude', gpt: 'OpenAI GPT', ollama: 'Local model (Ollama)' } as const;

/**
 * Organization review policy (AI providers, fix proposals, thresholds) plus what the platform has
 * observed for each AI provider. The policy only tightens each repository's ai-review.yaml.
 */
@Component({
  selector: 'acr-settings-page',
  imports: [AsyncState, Badge, DatePipe, HumanizePipe, ReactiveFormsModule],
  template: `
    <div class="page-header">
      <div>
        <h1>Review policy</h1>
        <p class="muted">
          Applies to every repository on top of its <code>ai-review.yaml</code>. The stricter setting always wins;
          approvals can never be relaxed and merging is never automated.
        </p>
      </div>
    </div>

    <h2>AI providers</h2>
    <p class="muted small">
      API keys live only in the worker's environment and are never shown here. Status is based on recent reviews.
    </p>
    @if (providers.value(); as list) {
      <div class="grid">
        @for (p of list; track p.provider) {
          <section class="card" [attr.aria-label]="labels[p.provider]">
            <div class="row">
              <strong>{{ labels[p.provider] }}</strong
              ><span class="spacer"></span
              ><acr-badge
                [value]="p.allowedByPolicy ? 'approved' : 'skipped'"
                [label]="p.allowedByPolicy ? 'allowed' : 'disabled by policy'"
              />
            </div>
            @if (p.lastExecutionAt) {
              <p class="small">
                Last run {{ p.lastExecutionAt | date: 'short' }} · {{ p.lastModel }} ·
                <acr-badge [value]="p.lastStatus ?? 'unknown'" />
                @if (p.lastErrorKind) {
                  <span class="muted">({{ p.lastErrorKind | humanize }})</span>
                }
              </p>
              <p class="muted small">{{ p.executions30d }} runs, {{ p.failures30d }} failed in 30 days</p>
            } @else {
              <p class="muted small">Not used yet (not configured on the worker, or no reviews so far).</p>
            }
          </section>
        }
      </div>
    }

    <h2>Policy</h2>
    @if (feedback(); as f) {
      <p class="banner" [class.banner-ok]="f.ok" [class.banner-error]="!f.ok" role="status">{{ f.text }}</p>
    }
    <acr-async-state
      [loading]="settings.isLoading()"
      [error]="loadError()"
      [hasData]="settings.hasValue()"
      (retry)="settings.reload()"
    >
      <form class="form card" [formGroup]="form" (ngSubmit)="save()" novalidate>
        <fieldset [disabled]="!canEdit()">
          <legend>Reviews</legend>
          <label class="checkbox-row"
            ><input type="checkbox" formControlName="reviewsEnabled" /> Run automatic reviews</label
          >
          <label class="checkbox-row"
            ><input type="checkbox" formControlName="allowClaude" /> Allow Anthropic Claude</label
          >
          <label class="checkbox-row"><input type="checkbox" formControlName="allowOpenai" /> Allow OpenAI GPT</label>
          <label class="checkbox-row"
            ><input type="checkbox" formControlName="allowOllama" /> Allow local model (Ollama)</label
          >
          <label class="checkbox-row"
            ><input type="checkbox" formControlName="allowFixProposals" /> Allow automatic fix proposals (uses AI
            credits)</label
          >
        </fieldset>
        <fieldset [disabled]="!canEdit()">
          <legend>Minimum thresholds</legend>
          <div class="field">
            <label for="severity">Report findings at or above</label>
            <select id="severity" formControlName="minimumSeverityFloor">
              <option value="">Repository decides</option>
              @for (s of severities; track s) {
                <option [value]="s">{{ s | humanize }}</option>
              }
            </select>
          </div>
          <div class="field">
            <label for="confidence">Minimum confidence (%)</label>
            <input
              id="confidence"
              type="number"
              min="0"
              max="100"
              step="5"
              formControlName="minimumConfidencePercent"
            />
            <span class="hint">Leave empty to let each repository decide.</span>
          </div>
        </fieldset>
        @if (canEdit()) {
          <button type="submit" class="btn btn-primary" [disabled]="form.invalid || saving()">Save policy</button>
        } @else {
          <p class="muted">Only admins and owners can change the policy.</p>
        }
        @if (settings.value()?.updatedAt; as updated) {
          <p class="muted small">Last changed {{ updated | date: 'medium' }}</p>
        }
      </form>
    </acr-async-state>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SettingsPage {
  private readonly api = inject(DashboardApi);
  private readonly session = inject(SessionStore);
  private readonly fb = inject(NonNullableFormBuilder);
  readonly orgId = input.required<string>();

  protected readonly labels = PROVIDER_LABELS;
  protected readonly severities = SEVERITY_ORDER;
  protected readonly settings = httpResource(() => this.api.orgUrl(this.orgId(), '/settings'), {
    parse: (v) => OrganizationSettingsSchema.parse(v),
  });
  protected readonly providers = httpResource(() => this.api.orgUrl(this.orgId(), '/ai-providers'), {
    parse: (v) => z.array(AiProviderStatusSchema).parse(v),
  });
  protected readonly loadError = computed(() => (this.settings.error() ? errorMessage(this.settings.error()) : null));
  protected readonly canEdit = computed(() => hasRole(this.session.membership(this.orgId())?.role, 'ADMIN'));
  protected readonly form = this.fb.group({
    reviewsEnabled: true,
    allowClaude: true,
    allowOpenai: true,
    allowOllama: true,
    allowFixProposals: true,
    minimumSeverityFloor: this.fb.control<Severity | ''>(''),
    minimumConfidencePercent: this.fb.control<number | null>(null, [Validators.min(0), Validators.max(100)]),
  });
  protected readonly saving = signal(false);
  protected readonly feedback = signal<{ ok: boolean; text: string } | null>(null);

  constructor() {
    // Load the stored policy into the form whenever it (re)loads.
    effect(() => {
      const s = this.settings.value();
      if (!s) return;
      this.form.reset({
        reviewsEnabled: s.reviewsEnabled,
        allowClaude: s.allowClaude,
        allowOpenai: s.allowOpenai,
        allowOllama: s.allowOllama,
        allowFixProposals: s.allowFixProposals,
        minimumSeverityFloor: s.minimumSeverityFloor ?? '',
        minimumConfidencePercent: s.minimumConfidenceFloor === null ? null : Math.round(s.minimumConfidenceFloor * 100),
      });
    });
  }

  protected async save(): Promise<void> {
    if (this.form.invalid || this.saving()) return;
    const v = this.form.getRawValue();
    const input: OrganizationSettingsInput = {
      reviewsEnabled: v.reviewsEnabled,
      allowClaude: v.allowClaude,
      allowOpenai: v.allowOpenai,
      allowOllama: v.allowOllama,
      allowFixProposals: v.allowFixProposals,
      minimumSeverityFloor: v.minimumSeverityFloor || null,
      minimumConfidenceFloor: v.minimumConfidencePercent === null ? null : v.minimumConfidencePercent / 100,
    };
    this.saving.set(true);
    this.feedback.set(null);
    try {
      this.settings.set(await this.api.saveSettings(this.orgId(), input));
      this.providers.reload();
      this.feedback.set({ ok: true, text: 'Policy saved. It applies to the next review.' });
    } catch (error) {
      this.feedback.set({ ok: false, text: errorMessage(error) });
    } finally {
      this.saving.set(false);
    }
  }
}
