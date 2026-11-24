import { type OrganizationRole } from '@acra/shared-types';
import { createParamDecorator, type ExecutionContext, SetMetadata } from '@nestjs/common';
import { type Request } from 'express';

/** The signed-in user of a request (set by SessionGuard). */
export interface AuthContext {
  readonly userId: string;
  readonly email: string;
  readonly displayName: string;
  readonly lastLoginAt: Date | null;
  readonly sessionId: string;
  readonly sessionToken: string;
}

/** The caller's membership in the organization addressed by `:orgId` (set by OrganizationGuard). */
export interface MembershipContext {
  readonly organizationId: string;
  readonly role: OrganizationRole;
}

export type AuthenticatedRequest = Request & {
  id?: unknown;
  auth?: AuthContext;
  membership?: MembershipContext;
};

export const ROLE_RANK: Readonly<Record<OrganizationRole, number>> = { OWNER: 4, ADMIN: 3, MEMBER: 2, VIEWER: 1 };

export function hasRole(actual: OrganizationRole, minimum: OrganizationRole): boolean {
  return ROLE_RANK[actual] >= ROLE_RANK[minimum];
}

export const IS_PUBLIC = 'acra:isPublic';
/** Opts a route out of the global session requirement (health, webhooks, login). */
export const Public = () => SetMetadata(IS_PUBLIC, true);

export const MIN_ROLE = 'acra:minRole';
/** Minimum organization role for a route under `/organizations/:orgId`. Defaults to VIEWER. */
export const MinRole = (role: OrganizationRole) => SetMetadata(MIN_ROLE, role);

export const CurrentAuth = createParamDecorator((_data: unknown, context: ExecutionContext): AuthContext => {
  const auth = context.switchToHttp().getRequest<AuthenticatedRequest>().auth;
  if (!auth) throw new Error('CurrentAuth used on a route without SessionGuard');
  return auth;
});

export const CurrentMembership = createParamDecorator(
  (_data: unknown, context: ExecutionContext): MembershipContext => {
    const membership = context.switchToHttp().getRequest<AuthenticatedRequest>().membership;
    if (!membership) throw new Error('CurrentMembership used on a route without OrganizationGuard');
    return membership;
  },
);

/** Request id and client address for audit entries. */
export const RequestMeta = createParamDecorator(
  (_data: unknown, context: ExecutionContext): { requestId: string | null; ipAddress: string | null } => {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    return { requestId: typeof request.id === 'string' ? request.id : null, ipAddress: clientIp(request) };
  },
);

/** Client IP as seen by Express (honours `trust proxy` when configured). Normalises IPv4-mapped IPv6. */
export function clientIp(request: Request): string | null {
  const ip = request.ip ?? request.socket?.remoteAddress ?? null;
  if (!ip) return null;
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}
