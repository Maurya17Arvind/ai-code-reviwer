import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { type FindingSummary } from '@acra/shared-contracts';
import { ORG_ID, signIn } from '../../../testing/session';
import { authInterceptor } from '../../core/auth/auth.interceptor';
import { FindingsPage } from './findings-page';

const BASE = `/api/v1/organizations/${ORG_ID}`;

const finding: FindingSummary = {
  id: 'f1',
  repositoryId: 'r1',
  repositoryName: 'acme/shop',
  requestId: 7,
  filePath: 'src/cart.ts',
  lineNumber: 12,
  endLineNumber: null,
  severity: 'high',
  category: 'bug',
  title: '<img src=x onerror=alert(1)>',
  confidence: 0.91,
  sources: ['claude', 'gpt'],
  placement: 'inline',
  status: 'published',
  firstSeenSha: 'a'.repeat(40),
  lastSeenSha: 'a'.repeat(40),
  createdAt: '2026-11-24T10:00:00.000Z',
  updatedAt: '2026-11-24T10:00:00.000Z',
};

describe('FindingsPage', () => {
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [FindingsPage],
      providers: [
        provideRouter([]),
        provideHttpClient(withInterceptors([authInterceptor])),
        provideHttpClientTesting(),
      ],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  async function render() {
    await signIn();
    const fixture = TestBed.createComponent(FindingsPage);
    fixture.componentRef.setInput('orgId', ORG_ID);
    fixture.detectChanges();
    http.expectOne(`${BASE}/repositories`).flush([]);
    return { fixture, element: fixture.nativeElement as HTMLElement };
  }

  it('renders findings as text (model output cannot inject markup)', async () => {
    const { fixture, element } = await render();
    http.expectOne(`${BASE}/findings?limit=25`).flush({ items: [finding], nextCursor: null });
    await vi.waitFor(async () => {
      await fixture.whenStable();
      expect(element.querySelectorAll('tbody tr')).toHaveLength(1);
    });
    expect(element.querySelector('tbody img')).toBeNull();
    expect(element.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(element.textContent).toContain('91%');
  });

  it('reloads from the first page when a filter changes', async () => {
    const { fixture, element } = await render();
    http.expectOne(`${BASE}/findings?limit=25`).flush({ items: [finding], nextCursor: 'next' });
    await vi.waitFor(async () => {
      await fixture.whenStable();
      expect(element.textContent).toContain('Load more');
    });

    const select = element.querySelector<HTMLSelectElement>('[data-testid="filter-severity"]');
    if (!select) throw new Error('severity filter missing');
    select.value = 'critical';
    select.dispatchEvent(new Event('change'));
    await fixture.whenStable();
    http.expectOne(`${BASE}/findings?severity=critical&limit=25`).flush({ items: [], nextCursor: null });
    await vi.waitFor(async () => {
      await fixture.whenStable();
      expect(element.querySelector('[data-testid="state-empty"]')?.textContent).toContain(
        'No findings match these filters.',
      );
    });
  });

  it('shows an error state with retry', async () => {
    const { fixture, element } = await render();
    http.expectOne(`${BASE}/findings?limit=25`).flush({}, { status: 500, statusText: 'Server Error' });
    await vi.waitFor(async () => {
      await fixture.whenStable();
      expect(element.querySelector('[data-testid="state-error"]')).not.toBeNull();
    });
    element.querySelector<HTMLButtonElement>('[data-testid="state-error"] button')?.click();
    http.expectOne(`${BASE}/findings?limit=25`).flush({ items: [], nextCursor: null });
  });
});
