import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';

/**
 * Consistent loading / error / empty states. Content is projected only when there is data.
 * Status changes are announced to screen readers through a polite live region.
 */
@Component({
  selector: 'acr-async-state',
  template: `
    <div aria-live="polite">
      @if (error(); as message) {
        <div class="banner banner-error" role="alert" data-testid="state-error">
          <span>{{ message }}</span>
          <button type="button" class="btn btn-small" (click)="retry.emit()">Retry</button>
        </div>
      } @else if (loading() && !hasData()) {
        <p class="muted" data-testid="state-loading">{{ loadingText() }}</p>
      } @else if (empty()) {
        <div class="empty" data-testid="state-empty">
          <p>{{ emptyText() }}</p>
          <ng-content select="[empty-action]" />
        </div>
      }
    </div>
    @if (!error() && !empty() && hasData()) {
      <ng-content />
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AsyncState {
  readonly loading = input(false);
  readonly error = input<string | null>(null);
  readonly empty = input(false);
  /** True once there is something to render (lists keep showing items while loading more). */
  readonly hasData = input(true);
  readonly loadingText = input('Loading…');
  readonly emptyText = input('Nothing here yet.');
  readonly retry = output<void>();
}
