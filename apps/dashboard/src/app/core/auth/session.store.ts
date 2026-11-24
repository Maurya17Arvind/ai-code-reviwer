import { HttpClient } from '@angular/common/http';
import { computed, inject, Injectable, signal } from '@angular/core';
import {
  type ChangePasswordRequest,
  type LoginRequest,
  type Membership,
  type SessionResponse,
  SessionResponseSchema,
  type SetupPasswordRequest,
} from '@acra/shared-contracts';
import { firstValueFrom } from 'rxjs';
import { API_BASE_URL } from '../api/health-api';

type SessionState =
  | { readonly status: 'unknown' }
  | { readonly status: 'anonymous' }
  | { readonly status: 'authenticated'; readonly session: SessionResponse };

/**
 * The signed-in user, held in memory only. The session token lives in an HttpOnly cookie the
 * dashboard cannot read; the CSRF token is kept here and sent on every write (see csrf interceptor).
 * Nothing is stored in localStorage, so a page reload asks the API again.
 */
@Injectable({ providedIn: 'root' })
export class SessionStore {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = inject(API_BASE_URL);
  private readonly state = signal<SessionState>({ status: 'unknown' });
  private restoring: Promise<boolean> | null = null;

  readonly status = computed(() => this.state().status);
  readonly session = computed(() => {
    const state = this.state();
    return state.status === 'authenticated' ? state.session : null;
  });
  readonly user = computed(() => this.session()?.user ?? null);
  readonly memberships = computed<readonly Membership[]>(() => this.session()?.memberships ?? []);
  readonly csrfToken = computed(() => this.session()?.csrfToken ?? null);

  /** Resolves the session once per page load (guards await this). */
  ensureLoaded(): Promise<boolean> {
    const state = this.state();
    if (state.status !== 'unknown') return Promise.resolve(state.status === 'authenticated');
    this.restoring ??= this.refresh().finally(() => (this.restoring = null));
    return this.restoring;
  }

  /** Re-reads the session (e.g. after creating an organization, to refresh memberships). */
  async refresh(): Promise<boolean> {
    try {
      const body = await firstValueFrom(this.http.get<unknown>(`${this.baseUrl}/v1/auth/session`));
      this.state.set({ status: 'authenticated', session: SessionResponseSchema.parse(body) });
      return true;
    } catch {
      this.state.set({ status: 'anonymous' });
      return false;
    }
  }

  async login(credentials: LoginRequest): Promise<SessionResponse> {
    const body = await firstValueFrom(this.http.post<unknown>(`${this.baseUrl}/v1/auth/login`, credentials));
    const session = SessionResponseSchema.parse(body);
    this.state.set({ status: 'authenticated', session });
    return session;
  }

  async logout(): Promise<void> {
    try {
      await firstValueFrom(this.http.post(`${this.baseUrl}/v1/auth/logout`, {}));
    } finally {
      this.markSignedOut();
    }
  }

  async changePassword(input: ChangePasswordRequest): Promise<void> {
    await firstValueFrom(this.http.post(`${this.baseUrl}/v1/auth/password`, input));
  }

  async setupPassword(input: SetupPasswordRequest): Promise<void> {
    await firstValueFrom(this.http.post(`${this.baseUrl}/v1/auth/setup-password`, input));
  }

  /** Called when the API answers 401 (expired or revoked session). */
  markSignedOut(): void {
    this.state.set({ status: 'anonymous' });
  }

  membership(organizationId: string): Membership | null {
    return this.memberships().find((m) => m.organizationId === organizationId) ?? null;
  }
}
