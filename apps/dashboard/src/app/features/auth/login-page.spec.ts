import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { sessionFixture } from '../../../testing/session';
import { authInterceptor } from '../../core/auth/auth.interceptor';
import { LoginPage, safeReturnUrl } from './login-page';

describe('LoginPage', () => {
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [LoginPage],
      providers: [
        provideRouter([]),
        provideHttpClient(withInterceptors([authInterceptor])),
        provideHttpClientTesting(),
      ],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  async function render(returnUrl?: string) {
    const fixture = TestBed.createComponent(LoginPage);
    if (returnUrl) fixture.componentRef.setInput('returnUrl', returnUrl);
    await fixture.whenStable();
    const element = fixture.nativeElement as HTMLElement;
    const fill = async (email: string, password: string) => {
      const emailInput = element.querySelector<HTMLInputElement>('#email');
      const passwordInput = element.querySelector<HTMLInputElement>('#password');
      if (!emailInput || !passwordInput) throw new Error('form not rendered');
      emailInput.value = email;
      emailInput.dispatchEvent(new Event('input'));
      passwordInput.value = password;
      passwordInput.dispatchEvent(new Event('input'));
      element.querySelector<HTMLFormElement>('form')?.dispatchEvent(new Event('submit'));
      await fixture.whenStable();
    };
    return { fixture, element, fill };
  }

  it('does not submit an incomplete form', async () => {
    const { element, fill } = await render();
    await fill('not-an-email', '');
    http.expectNone('/api/v1/auth/login');
    expect(element.textContent).toContain('Enter your e-mail address and password.');
  });

  it('signs in and returns to the requested page', async () => {
    const { fill } = await render('/o/abc/findings');
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
    await fill('owner@example.com', 'correct horse battery staple');
    const request = http.expectOne('/api/v1/auth/login');
    expect(request.request.body).toEqual({ email: 'owner@example.com', password: 'correct horse battery staple' });
    request.flush(sessionFixture());
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith('/o/abc/findings'));
  });

  it('shows the API message and clears the password on failure', async () => {
    const { fixture, element, fill } = await render();
    await fill('owner@example.com', 'wrong');
    http
      .expectOne('/api/v1/auth/login')
      .flush(
        { statusCode: 401, error: 'Unauthorized', message: 'Invalid e-mail or password' },
        { status: 401, statusText: 'Unauthorized' },
      );
    await vi.waitFor(async () => {
      await fixture.whenStable();
      expect(element.querySelector('[data-testid="login-error"]')?.textContent).toContain('Invalid e-mail or password');
    });
    expect(element.querySelector<HTMLInputElement>('#password')?.value).toBe('');
  });

  it('only accepts same-app return URLs (no open redirect)', () => {
    expect(safeReturnUrl('/o/x')).toBe('/o/x');
    expect(safeReturnUrl('https://evil.example')).toBe('/');
    expect(safeReturnUrl('//evil.example')).toBe('/');
    expect(safeReturnUrl('/\\evil.example')).toBe('/');
    expect(safeReturnUrl(undefined)).toBe('/');
  });
});
