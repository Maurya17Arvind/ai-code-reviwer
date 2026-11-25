import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

export interface BarDatum {
  readonly label: string;
  readonly value: number;
}

/**
 * Minimal dependency-free bar chart (inline SVG). The SVG is decorative for screen readers; the
 * same data is available as a visually hidden table, so the chart never carries meaning alone.
 */
@Component({
  selector: 'acr-bar-chart',
  template: `
    <figure class="chart">
      <div class="chart-head">
        <figcaption class="chart-title">{{ title() }}</figcaption>
        <span class="chart-total" aria-hidden="true">{{ totalDisplay() }}</span>
      </div>
      <svg
        [attr.viewBox]="'0 0 ' + width + ' ' + height"
        preserveAspectRatio="none"
        aria-hidden="true"
        class="chart-svg"
      >
        @for (y of gridLines; track y) {
          <line x1="0" [attr.x2]="width" [attr.y1]="y" [attr.y2]="y" class="chart-grid" />
        }
        @for (bar of bars(); track bar.label) {
          <rect [attr.x]="bar.x" [attr.y]="bar.y" [attr.width]="bar.w" [attr.height]="bar.h" rx="1.5" class="chart-bar">
            <title>{{ bar.label }}: {{ bar.display }}</title>
          </rect>
        }
      </svg>
      <div class="chart-axis muted small">
        <span>{{ first() }}</span><span>max {{ maxDisplay() }}</span
        ><span>{{ last() }}</span>
      </div>
      <table class="visually-hidden">
        <caption>
          {{
            title()
          }}
        </caption>
        <thead>
          <tr>
            <th scope="col">Date</th>
            <th scope="col">Value</th>
          </tr>
        </thead>
        <tbody>
          @for (d of data(); track d.label) {
            <tr>
              <td>{{ d.label }}</td>
              <td>{{ format()(d.value) }}</td>
            </tr>
          }
        </tbody>
      </table>
    </figure>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BarChart {
  readonly title = input.required<string>();
  readonly data = input.required<readonly BarDatum[]>();
  readonly format = input<(value: number) => string>((value) => String(value));

  protected readonly width = 300;
  protected readonly height = 80;
  protected readonly gridLines = [0.5, 20, 40, 60, 79.5];

  private readonly max = computed(() => Math.max(0, ...this.data().map((d) => d.value)));
  protected readonly totalDisplay = computed(() => this.format()(this.data().reduce((sum, d) => sum + d.value, 0)));
  protected readonly maxDisplay = computed(() => this.format()(this.max()));
  protected readonly first = computed(() => this.data()[0]?.label ?? '');
  protected readonly last = computed(() => this.data().at(-1)?.label ?? '');
  protected readonly bars = computed(() => {
    const data = this.data();
    const max = this.max() || 1;
    const slot = this.width / Math.max(data.length, 1);
    return data.map((d, i) => {
      const h = d.value <= 0 ? 0 : Math.max(1, (d.value / max) * (this.height - 2));
      return {
        label: d.label,
        display: this.format()(d.value),
        x: i * slot + slot * 0.15,
        w: slot * 0.7,
        h,
        y: this.height - h,
      };
    });
  });
}
