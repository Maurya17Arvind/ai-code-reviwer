import { AuthStore } from '@acra/database';
import { CSRF_HEADER } from '@acra/shared-contracts';
import { type OrganizationRole } from '@acra/shared-types';
import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { API_CONFIG, type ApiConfig, isSecureCookie } from '../api-config';
import { type AuthenticatedRequest, hasRole, IS_PUBLIC, MIN_ROLE } from './auth-context';
import { AuthService } from './auth.service';
import { csrfTokenMatches, readCookie, sessionCookieName } from './session-token';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Global guard: every route requires a valid session unless marked @Public() (deny by default).
 * State-changing requests must also carry the session's CSRF token in `X-CSRF-Token`.
 */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [context.getHandler(), context.getClass()]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = readCookie(request.headers, sessionCookieName(isSecureCookie(this.config)));
    const auth = await this.auth.authenticate(token);
    if (!auth) throw new UnauthorizedException('Sign in to continue');
    if (!SAFE_METHODS.has(request.method) && !csrfTokenMatches(auth.sessionToken, request.headers[CSRF_HEADER])) {
      throw new ForbiddenException('Missing or invalid CSRF token');
    }
    request.auth = auth;
    return true;
  }
}

/**
 * Tenant guard for `/organizations/:orgId/...`: the caller must be a member. Non-members get 404
 * (an organization's existence is not disclosed); members below @MinRole get 403.
 */
@Injectable()
export class OrganizationGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(AuthStore) private readonly store: AuthStore,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const orgId = request.params['orgId'];
    if (!request.auth) throw new UnauthorizedException('Sign in to continue');
    if (typeof orgId !== 'string' || !UUID.test(orgId)) throw new NotFoundException('Organization not found');
    const role = await this.store.roleIn(request.auth.userId, orgId);
    if (!role) throw new NotFoundException('Organization not found');
    const minimum =
      this.reflector.getAllAndOverride<OrganizationRole | undefined>(MIN_ROLE, [
        context.getHandler(),
        context.getClass(),
      ]) ?? 'VIEWER';
    if (!hasRole(role, minimum)) throw new ForbiddenException(`This action requires the ${minimum} role or higher`);
    request.membership = { organizationId: orgId, role };
    return true;
  }
}
