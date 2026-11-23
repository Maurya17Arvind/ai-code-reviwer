import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { type ReadinessResponse } from '@acra/shared-contracts';
import { SystemStatusPage } from './system-status';

const timestamp = '2026-11-23T10:00:00.000Z';

describe('SystemStatusPage', () => {
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [SystemStatusPage],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  async function render(respond: (http: HttpTestingController) => void): Promise<HTMLElement> {
    const fixture = TestBed.createComponent(SystemStatusPage);
    await fixture.whenStable();
    respond(http);
    await fixture.whenStable();
    return fixture.nativeElement as HTMLElement;
  }

  it('shows a loading state before the response arrives', async () => {
    const fixture = TestBed.createComponent(SystemStatusPage);
    await fixture.whenStable();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('Checking backend health');
    http.expectOne('/api/health/ready').flush({ status: 'ok', timestamp, checks: [] });
  });

  it('renders operational dependencies', async () => {
    const body: ReadinessResponse = {
      status: 'ok',
      timestamp,
      checks: [
        { name: 'database', status: 'up', latencyMs: 3 },
        { name: 'redis', status: 'up', latencyMs: 1 },
      ],
    };
    const element = await render((h) => h.expectOne('/api/health/ready').flush(body));
    expect(element.querySelector('[data-testid="status-summary"]')?.textContent).toContain('All systems operational');
    expect(element.querySelectorAll('.check')).toHaveLength(2);
    expect(element.textContent).toContain('PostgreSQL');
  });

  it('treats a 503 readiness body as data, not as an outage of the API', async () => {
    const body: ReadinessResponse = {
      status: 'unavailable',
      timestamp,
      checks: [
        { name: 'database', status: 'up', latencyMs: 3 },
        { name: 'redis', status: 'down', latencyMs: 2000, reason: 'timeout' },
      ],
    };
    const element = await render((h) =>
      h.expectOne('/api/health/ready').flush(body, { status: 503, statusText: 'Service Unavailable' }),
    );
    expect(element.querySelector('[data-testid="status-summary"]')?.textContent).toContain(
      'Some dependencies are unavailable',
    );
    expect(element.textContent).toContain('(timed out)');
  });

  it('shows an error state when the API is unreachable or returns an invalid payload', async () => {
    const element = await render((h) => h.expectOne('/api/health/ready').flush({ unexpected: true }));
    expect(element.querySelector('[data-testid="status-error"]')).not.toBeNull();
  });
});
