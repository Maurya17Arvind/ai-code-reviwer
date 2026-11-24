import { HttpClient, HttpParams } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import {
  type AddMemberRequest,
  type AddMemberResponse,
  AddMemberResponseSchema,
  type ApprovalDecisionResponse,
  ApprovalDecisionResponseSchema,
  type ApprovalDetail,
  ApprovalDetailSchema,
  type ConnectGitLabRequest,
  type ConnectGitLabResponse,
  ConnectGitLabResponseSchema,
  type CreateApprovalRequest,
  type CreateOrganizationRequest,
  type FindingDetail,
  FindingDetailSchema,
  type Member,
  MemberSchema,
  type Organization,
  OrganizationSchema,
  type OrganizationSettings,
  type OrganizationSettingsInput,
  OrganizationSettingsSchema,
  type Page,
  pageOf,
  type Repository,
  RepositorySchema,
  type SetupLink,
  SetupLinkSchema,
  type UpdateFindingStatusRequest,
} from '@acra/shared-contracts';
import { type OrganizationRole } from '@acra/shared-types';
import { firstValueFrom } from 'rxjs';
import type * as z from 'zod/mini';
import { API_BASE_URL } from './health-api';

/** Query parameters with empty values removed. */
export function queryString(params: Record<string, string | number | null | undefined>): string {
  let httpParams = new HttpParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined && value !== '') httpParams = httpParams.set(key, String(value));
  }
  const text = httpParams.toString();
  return text ? `?${text}` : '';
}

/**
 * Typed client for the dashboard API. Every response is validated against the shared contract
 * before it reaches a component. Reads used reactively go through `httpResource` with `orgUrl()`;
 * writes and paged reads go through the methods below.
 */
@Injectable({ providedIn: 'root' })
export class DashboardApi {
  private readonly http = inject(HttpClient);
  readonly baseUrl = inject(API_BASE_URL);

  orgUrl(orgId: string, path = ''): string {
    return `${this.baseUrl}/v1/organizations/${encodeURIComponent(orgId)}${path}`;
  }

  async page<T extends z.ZodMiniType>(url: string, item: T): Promise<Page<z.infer<T>>> {
    return pageOf(item).parse(await firstValueFrom(this.http.get<unknown>(url))) as Page<z.infer<T>>;
  }

  private async send<T extends z.ZodMiniType>(
    method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    url: string,
    body: unknown,
    schema: T,
  ): Promise<z.infer<T>> {
    const response = await firstValueFrom(this.http.request<unknown>(method, url, { body }));
    return schema.parse(response) as z.infer<T>;
  }

  private async sendNoContent(method: 'POST' | 'DELETE', url: string, body?: unknown): Promise<void> {
    await firstValueFrom(this.http.request(method, url, body === undefined ? {} : { body }));
  }

  createOrganization(input: CreateOrganizationRequest): Promise<Organization> {
    return this.send('POST', `${this.baseUrl}/v1/organizations`, input, OrganizationSchema);
  }

  renameOrganization(orgId: string, name: string): Promise<Organization> {
    return this.send('PATCH', this.orgUrl(orgId), { name }, OrganizationSchema);
  }

  addMember(orgId: string, input: AddMemberRequest): Promise<AddMemberResponse> {
    return this.send('POST', this.orgUrl(orgId, '/members'), input, AddMemberResponseSchema);
  }

  updateMemberRole(orgId: string, memberId: string, role: OrganizationRole): Promise<Member> {
    return this.send('PATCH', this.orgUrl(orgId, `/members/${memberId}`), { role }, MemberSchema);
  }

  removeMember(orgId: string, memberId: string): Promise<void> {
    return this.sendNoContent('DELETE', this.orgUrl(orgId, `/members/${memberId}`));
  }

  issueSetupLink(orgId: string, memberId: string): Promise<SetupLink> {
    return this.send('POST', this.orgUrl(orgId, `/members/${memberId}/setup-link`), {}, SetupLinkSchema);
  }

  saveSettings(orgId: string, input: OrganizationSettingsInput): Promise<OrganizationSettings> {
    return this.send('PUT', this.orgUrl(orgId, '/settings'), input, OrganizationSettingsSchema);
  }

  setRepositoryActive(orgId: string, repositoryId: string, isActive: boolean): Promise<Repository> {
    return this.send('PATCH', this.orgUrl(orgId, `/repositories/${repositoryId}`), { isActive }, RepositorySchema);
  }

  connectGitLab(orgId: string, input: ConnectGitLabRequest): Promise<ConnectGitLabResponse> {
    return this.send('POST', this.orgUrl(orgId, '/connections/gitlab'), input, ConnectGitLabResponseSchema);
  }

  updateFindingStatus(orgId: string, findingId: string, input: UpdateFindingStatusRequest): Promise<FindingDetail> {
    return this.send('PATCH', this.orgUrl(orgId, `/findings/${findingId}`), input, FindingDetailSchema);
  }

  requestApproval(orgId: string, input: CreateApprovalRequest): Promise<ApprovalDetail> {
    return this.send('POST', this.orgUrl(orgId, '/approvals'), input, ApprovalDetailSchema);
  }

  approve(orgId: string, approvalId: string, code: string): Promise<ApprovalDecisionResponse> {
    return this.send(
      'POST',
      this.orgUrl(orgId, `/approvals/${approvalId}/approve`),
      { code },
      ApprovalDecisionResponseSchema,
    );
  }

  reject(orgId: string, approvalId: string, reason: string): Promise<ApprovalDecisionResponse> {
    return this.send(
      'POST',
      this.orgUrl(orgId, `/approvals/${approvalId}/reject`),
      reason ? { reason } : {},
      ApprovalDecisionResponseSchema,
    );
  }
}
