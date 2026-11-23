import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, DestroyRef, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { type DependencyName, type ReadinessResponse } from '@acra/shared-contracts';
import { HealthApi } from '../../core/api/health-api';

type ViewState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'loaded'; readonly data: ReadinessResponse }
  | { readonly kind: 'error' };

const DEPENDENCY_LABELS: Record<DependencyName, string> = {
  database: 'PostgreSQL',
  redis: 'Redis (job queue)',
};

@Component({
  selector: 'acr-system-status',
  imports: [DatePipe],
  templateUrl: './system-status.html',
  styleUrl: './system-status.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SystemStatusPage {
  private readonly healthApi = inject(HealthApi);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly state = signal<ViewState>({ kind: 'loading' });
  protected readonly labels = DEPENDENCY_LABELS;
  protected readonly isRefreshing = computed(() => this.state().kind === 'loading');
  protected readonly readiness = computed(() => {
    const state = this.state();
    return state.kind === 'loaded' ? state.data : null;
  });
  protected readonly summary = computed(() => {
    const readiness = this.readiness();
    if (readiness === null) return null;
    return readiness.status === 'ok' ? 'All systems operational' : 'Some dependencies are unavailable';
  });

  constructor() {
    this.refresh();
  }

  protected refresh(): void {
    this.state.set({ kind: 'loading' });
    this.healthApi
      .readiness()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (data) => this.state.set({ kind: 'loaded', data }),
        error: () => this.state.set({ kind: 'error' }),
      });
  }
}
