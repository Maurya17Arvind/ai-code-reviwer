import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { type ApprovalDetail } from '@acra/shared-contracts';
import { type OrganizationRole } from '@acra/shared-types';
import { CSRF, ORG_ID, signIn } from '../../../testing/session';
import { authInterceptor } from '../../core/auth/auth.interceptor';
import { ApprovalDetailPage } from './approval-detail-page';

const APPROVAL_ID = '0194f000-0000-7000-8000-0000000000aa';
const URL = `/api/v1/organizations/${ORG_ID}/approvals/${APPROVAL_ID}`;

const approval: ApprovalDetail = {
  id: APPROVAL_ID,
  operationKind: 'commit_and_push_fix',
  status: 'pending',
  fixId: '0194f000-0000-7000-8000-0000000000bb',
  repositoryId: 'r1',
  requestId: 7,
  headSha: 'a'.repeat(40),
  requestedBy: { kind: 'user', display: 'owner@example.com' },
  decidedBy: null,
  reason: null,
  createdAt: '2026-11-24T10:00:00.000Z',
  expiresAt: '2026-11-25T10:00:00.000Z',
  decidedAt: null,
  executedAt: null,
  description: ['Create branch ai-review/fix-abc from aaaaaaa', 'Commit exactly the proposed patch to src/a.ts'],
  patchSha256: 'b'.repeat(64),
  approvalCode: '0123456789ab',
  result: null,
};

describe('ApprovalDetailPage', () => {
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [ApprovalDetailPage],
      providers: [
        provideRouter([]),
        provideHttpClient(withInterceptors([authInterceptor])),
        provideHttpClientTesting(),
      ],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  async function render(role: OrganizationRole) {
    await signIn(role);
    const fixture = TestBed.createComponent(ApprovalDetailPage);
    fixture.componentRef.setInput('orgId', ORG_ID);
    fixture.componentRef.setInput('approvalId', APPROVAL_ID);
    fixture.detectChanges();
    http.expectOne(URL).flush(approval);
    await fixture.whenStable();
    return { fixture, element: fixture.nativeElement as HTMLElement };
  }

  it('shows exactly what will happen and the code to type', async () => {
    const { element } = await render('MEMBER');
    expect(element.querySelector('[data-testid="approval-description"]')?.textContent).toContain('ai-review/fix-abc');
    expect(element.querySelector('[data-testid="approval-code"]')?.textContent).toBe('0123456789ab');
    expect(element.textContent).not.toMatch(/merge it|auto-merge/i);
  });

  it('enables approval only with a well-formed code and sends it with the CSRF token', async () => {
    const { fixture, element } = await render('MEMBER');
    const approve = [...element.querySelectorAll('button')].find((b) => b.textContent?.includes('Approve'));
    expect(approve?.disabled).toBe(true);

    const input = element.querySelector<HTMLInputElement>('#code');
    if (!input) throw new Error('code input missing');
    input.value = '0123456789AB';
    input.dispatchEvent(new Event('input'));
    await fixture.whenStable();
    expect(approve?.disabled).toBe(false);
    approve?.closest('form')?.dispatchEvent(new Event('submit'));

    const request = http.expectOne(`${URL}/approve`);
    expect(request.request.body).toEqual({ code: '0123456789AB' });
    expect(request.request.headers.get('x-csrf-token')).toBe(CSRF);
    request.flush({ approval: { ...approval, status: 'approved' }, jobId: 'job-1' });
    await vi.waitFor(() => http.expectOne(URL).flush({ ...approval, status: 'approved' }));
    await fixture.whenStable();
    expect(element.querySelector('[data-testid="decision-feedback"]')?.textContent).toContain('job-1');
  });

  it('offers no decision to viewers', async () => {
    const { element } = await render('VIEWER');
    expect(element.querySelector('#code')).toBeNull();
    expect(element.textContent).toContain('Viewers cannot decide approvals.');
  });
});
