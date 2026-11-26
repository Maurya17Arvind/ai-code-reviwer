import { HttpTestingController } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { type SessionResponse } from '@acra/shared-contracts';
import { type OrganizationRole } from '@acra/shared-types';
import { SessionStore } from '../app/core/auth/session.store';

export const ORG_ID = '0194f000-0000-7000-8000-000000000001';
export const CSRF = 'csrf-token-for-tests';

export function sessionFixture(role: OrganizationRole = 'OWNER'): SessionResponse {
  return {
    user: { id: 'u1', email: 'owner@example.com', displayName: 'Owner', lastLoginAt: null, emailVerifiedAt: null },
    memberships: [{ organizationId: ORG_ID, slug: 'acme', name: 'Acme', role }],
    csrfToken: CSRF,
  };
}

/** Signs in through the real SessionStore by answering its login request. */
export async function signIn(role: OrganizationRole = 'OWNER'): Promise<SessionStore> {
  const store = TestBed.inject(SessionStore);
  const http = TestBed.inject(HttpTestingController);
  const pending = store.login({ email: 'owner@example.com', password: 'x' });
  http.expectOne('/api/v1/auth/login').flush(sessionFixture(role));
  await pending;
  return store;
}
