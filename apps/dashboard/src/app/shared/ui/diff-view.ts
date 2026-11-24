import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

type LineKind = 'add' | 'del' | 'hunk' | 'meta' | 'ctx';

/**
 * Read-only unified diff. Lines are rendered with text interpolation only (never innerHTML), so
 * patch content from repositories or models cannot inject markup.
 */
@Component({
  selector: 'acr-diff-view',
  template: `
    <pre
      class="diff"
      tabindex="0"
      [attr.aria-label]="label()"
    ><code>@for (line of lines(); track $index) {<span class="diff-line" [class]="'diff-line diff-' + line.kind">{{ line.text }}</span>
}</code></pre>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DiffView {
  readonly patch = input.required<string>();
  readonly label = input('Proposed patch');

  protected readonly lines = computed(() =>
    this.patch()
      .replace(/\n$/, '')
      .split('\n')
      .map((text) => ({ text: text || ' ', kind: kindOf(text) })),
  );
}

function kindOf(line: string): LineKind {
  if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') || line.startsWith('index ')) {
    return 'meta';
  }
  if (line.startsWith('@@')) return 'hunk';
  if (line.startsWith('+')) return 'add';
  if (line.startsWith('-')) return 'del';
  return 'ctx';
}
