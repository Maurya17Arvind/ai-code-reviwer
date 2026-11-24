import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

export type Tone = 'neutral' | 'danger' | 'warning' | 'success' | 'info';

const TONES: Readonly<Record<string, Tone>> = {
  critical: 'danger',
  high: 'danger',
  medium: 'warning',
  low: 'info',
  failed: 'danger',
  rejected: 'danger',
  false_positive: 'neutral',
  dismissed: 'neutral',
  superseded: 'neutral',
  skipped: 'neutral',
  expired: 'neutral',
  invalidated: 'neutral',
  partial: 'warning',
  pending: 'warning',
  queued: 'info',
  running: 'info',
  executing: 'info',
  new: 'info',
  validated: 'info',
  proposed: 'info',
  published: 'warning',
  completed: 'success',
  resolved: 'success',
  approved: 'success',
  executed: 'success',
  applied: 'success',
  opened: 'success',
  succeeded: 'success',
};

/** Maps a status or severity to a colour tone (text always carries the meaning, not colour alone). */
export function toneFor(value: string): Tone {
  return TONES[value.toLowerCase()] ?? 'neutral';
}

/** "false_positive" → "false positive". */
export function humanize(value: string): string {
  return value.toLowerCase().replace(/_/g, ' ');
}

@Component({
  selector: 'acr-badge',
  template: `<span class="badge" [class]="'badge badge-' + tone()">{{ text() }}</span>`,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Badge {
  readonly value = input.required<string>();
  readonly label = input<string | null>(null);
  protected readonly tone = computed(() => toneFor(this.value()));
  protected readonly text = computed(() => this.label() ?? humanize(this.value()));
}
