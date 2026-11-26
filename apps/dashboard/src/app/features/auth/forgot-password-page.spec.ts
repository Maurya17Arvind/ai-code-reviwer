import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { CSRF_HEADER } from '@acra/shared-contracts';
import { authInterceptor } from '../../core/auth/auth.interceptor';
import { ForgotPasswordPage } from './forgot-password-page';

describe('ForgotPasswordPage', () => {
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [ForgotPasswordPage],
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
    const fixture = TestBed.createComponent(ForgotPasswordPage);
    await fixture.whenStable();
    const element = fixture.nativeElement as HTMLElement;
    const submit = async (email: string) => {
      const input = element.querySelector<HTMLInputElement>('#email');
      if (!input) throw new Error('form not rendered');
      input.value = email;
      input.dispatchEvent(new Event('input'));
      element.querySelector<HTMLFormElement>('form')?.dispatchEvent(new Event('submit'));
      await fixture.whenStable();
    };
    const settle = async (check: () => void) =>
      vi.waitFor(async () => {
        await fixture.whenStable();
        check();
      });
    return { element, submit, settle };
  }

  it('validates the address before sending anything', async () => {
    const { element, submit } = await render();
    await submit('not-an-email');
    http.expectNone('/api/v1/auth/password-reset');
    expect(element.textContent).toContain('Enter a valid e-mail address.');
  });

  it('shows the same neutral confirmation after the request is accepted', async () => {
    const { element, submit, settle } = await render();
    await submit(' ana@example.com ');
    const request = http.expectOne('/api/v1/auth/password-reset');
    expect(request.request.method).toBe('POST');
    expect(request.request.body).toEqual({ email: 'ana@example.com' });
    expect(request.request.headers.has(CSRF_HEADER)).toBe(false); // anonymous: no session, no token
    request.flush(null, { status: 202, statusText: 'Accepted' });
    await settle(() => {
      const sent = element.querySelector('[data-testid="reset-sent"]')?.textContent ?? '';
      expect(sent).toContain('If an account exists for ana@example.com');
      expect(sent).toContain('expires in 2 hours');
    });
    expect(element.querySelector('form')).toBeNull();
  });

  it('explains rate limiting and installations without mail', async () => {
    const { element, submit, settle } = await render();
    await submit('ana@example.com');
    http.expectOne('/api/v1/auth/password-reset').flush(null, { status: 429, statusText: 'Too Many Requests' });
    await settle(() =>
      expect(element.querySelector('[data-testid="reset-error"]')?.textContent).toContain('Try again in an hour'),
    );

    await submit('ana@example.com');
    http.expectOne('/api/v1/auth/password-reset').flush(null, { status: 404, statusText: 'Not Found' });
    await settle(() =>
      expect(element.querySelector('[data-testid="reset-error"]')?.textContent).toContain('platform operator'),
    );
  });
});
