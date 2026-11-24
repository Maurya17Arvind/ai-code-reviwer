import { TestBed } from '@angular/core/testing';
import { DiffView } from './diff-view';

describe('DiffView', () => {
  it('classifies lines and renders patch content as text only', async () => {
    const fixture = TestBed.createComponent(DiffView);
    fixture.componentRef.setInput(
      'patch',
      'diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1,2 +1,2 @@\n context\n-old\n+<script>alert(1)</script>\n',
    );
    await fixture.whenStable();
    const element = fixture.nativeElement as HTMLElement;
    const kinds = [...element.querySelectorAll('.diff-line')].map((l) => l.className.replace('diff-line ', ''));
    expect(kinds).toEqual(['diff-meta', 'diff-meta', 'diff-meta', 'diff-hunk', 'diff-ctx', 'diff-del', 'diff-add']);
    expect(element.querySelector('script')).toBeNull();
    expect(element.textContent).toContain('+<script>alert(1)</script>');
  });
});
