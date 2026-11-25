import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { Icon } from './icon';

/**
 * Consistent loading / error / empty states. Content is projected only when there is data.
 * Status changes are announced to screen readers through a polite live region.
 */
@Component({
  selector: 'acr-async-state',
  imports: [Icon],
  template: `
    <div aria-live="polite">
      @if (error(); as message) {
        <div class="banner banner-error" role="alert" data-testid="state-error">
          <span class="row"><acr-icon name="alert" [size]="18" />{{ message }}</span>
          <button type="button" class="btn btn-small" (click)="retry.emit()">
            <acr-icon name="refresh" [size]="14" />Retry
          </button>
        </div>
      } @else if (loading() && !hasData()) {
        <div class="skeleton" data-testid="state-loading">
          <span class="visually-hidden">{{ loadingText() }}</span>
          <div class="skeleton-line"></div>
          <div class="skeleton-line"></div>
          <div class="skeleton-line"></div>
          <div class="skeleton-line"></div>
        </div>
      } @else if (empty()) {
        <div class="empty" data-testid="state-empty">
          <span class="empty-icon"><acr-icon name="inbox" [size]="22" /></span>
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
