import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { CSRF, signIn } from '../../../testing/session';
import { authInterceptor } from './auth.interceptor';
import { SessionStore } from './session.store';

describe('authInterceptor', () => {
  let http: HttpTestingController;
  let client: HttpClient;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        provideHttpClient(withInterceptors([authInterceptor])),
        provideHttpClientTesting(),
      ],
    });
    http = TestBed.inject(HttpTestingController);
    client = TestBed.inject(HttpClient);
  });

  afterEach(() => http.verify());

  it('sends cookies and the CSRF token on writes, not on reads', async () => {
    await signIn();
    void firstValueFrom(client.get('/api/v1/organizations/x'));
    const read = http.expectOne('/api/v1/organizations/x');
    expect(read.request.withCredentials).toBe(true);
    expect(read.request.headers.has('x-csrf-token')).toBe(false);
    read.flush({});

    void firstValueFrom(client.post('/api/v1/organizations', {}));
    const write = http.expectOne('/api/v1/organizations');
    expect(write.request.headers.get('x-csrf-token')).toBe(CSRF);
    write.flush({});
  });

  it('never attaches credentials or tokens to other origins', async () => {
    await signIn();
    void firstValueFrom(client.post('https://elsewhere.example/collect', {}));
    const request = http.expectOne('https://elsewhere.example/collect');
    expect(request.request.withCredentials).toBe(false);
    expect(request.request.headers.has('x-csrf-token')).toBe(false);
    request.flush({});
  });

  it('signs out locally and redirects to sign-in on 401', async () => {
    const store = await signIn();
    const router = TestBed.inject(Router);
    const navigate = vi.spyOn(router, 'navigate').mockResolvedValue(true);
    const call = firstValueFrom(client.get('/api/v1/organizations/x')).catch((e: unknown) => e);
    http.expectOne('/api/v1/organizations/x').flush({}, { status: 401, statusText: 'Unauthorized' });
    await call;
    expect(TestBed.inject(SessionStore).status()).toBe('anonymous');
    expect(store.csrfToken()).toBeNull();
    expect(navigate).toHaveBeenCalledWith(['/login'], { queryParams: { returnUrl: '/' } });
  });
});
