import { type OrganizationRole } from '@acra/shared-types';

const RANK: Readonly<Record<OrganizationRole, number>> = { OWNER: 4, ADMIN: 3, MEMBER: 2, VIEWER: 1 };

/** UI-only role check (hides actions the API would refuse anyway). */
export function hasRole(actual: OrganizationRole | null | undefined, minimum: OrganizationRole): boolean {
  return actual !== null && actual !== undefined && RANK[actual] >= RANK[minimum];
}

export const ROLE_LABELS: Readonly<Record<OrganizationRole, string>> = {
  OWNER: 'Owner',
  ADMIN: 'Admin',
  MEMBER: 'Member',
  VIEWER: 'Viewer',
};

export const ROLE_DESCRIPTIONS: Readonly<Record<OrganizationRole, string>> = {
  OWNER: 'Everything, including managing owners',
  ADMIN: 'Members, repositories, connections and policy',
  MEMBER: 'Triage findings, request and decide approvals',
  VIEWER: 'Read-only access',
};
