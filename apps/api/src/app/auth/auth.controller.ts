import {
  type AuthFeaturesResponse,
  type ChangePasswordRequest,
  ChangePasswordRequestSchema,
  type LoginRequest,
  LoginRequestSchema,
  type PasswordResetRequest,
  PasswordResetRequestSchema,
  type SessionResponse,
  type SetupPasswordRequest,
  SetupPasswordRequestSchema,
} from '@acra/shared-contracts';
import { Body, Controller, Get, Header, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import { type Response } from 'express';
import { API_CONFIG, type ApiConfig, isSecureCookie } from '../api-config';
import { zod } from '../common/zod-validation.pipe';
import { type AuthContext, type AuthenticatedRequest, clientIp, CurrentAuth, Public } from './auth-context';
import { AuthService } from './auth.service';
import { clearedSessionCookie, serializeSessionCookie, sessionCookieName } from './session-token';

function requestInfo(request: AuthenticatedRequest) {
  const userAgent = request.headers['user-agent'];
  return {
    ipAddress: clientIp(request),
    userAgent: typeof userAgent === 'string' ? userAgent : null,
    requestId: typeof request.id === 'string' ? request.id : null,
  };
}

/** Sign-in, session and password endpoints for the dashboard (ADR-035). */
@Controller('v1/auth')
export class AuthController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  private get cookieName(): string {
    return sessionCookieName(isSecureCookie(this.config));
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async login(
    @Body(zod(LoginRequestSchema)) body: LoginRequest,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<SessionResponse> {
    const { token, session } = await this.auth.login(body.email, body.password, requestInfo(request));
    response.setHeader(
      'Set-Cookie',
      serializeSessionCookie({
        name: this.cookieName,
        value: token,
        maxAgeSeconds: this.auth.sessionTtlMs / 1000,
        secure: isSecureCookie(this.config),
      }),
    );
    return session;
  }

  @Get('session')
  @Header('Cache-Control', 'no-store')
  session(@CurrentAuth() auth: AuthContext): Promise<SessionResponse> {
    return this.auth.sessionResponse(auth, auth.sessionToken);
  }

  @Post('logout')
  @HttpCode(204)
  async logout(
    @CurrentAuth() auth: AuthContext,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    await this.auth.logout(auth, requestInfo(request));
    response.setHeader('Set-Cookie', clearedSessionCookie(this.cookieName, isSecureCookie(this.config)));
  }

  @Post('password')
  @HttpCode(204)
  async changePassword(
    @CurrentAuth() auth: AuthContext,
    @Body(zod(ChangePasswordRequestSchema)) body: ChangePasswordRequest,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    await this.auth.changePassword(auth, body.currentPassword, body.newPassword, requestInfo(request));
  }

  /** Self-service features offered by this installation, so the dashboard shows only what works. */
  @Public()
  @Get('features')
  @Header('Cache-Control', 'no-store')
  features(): AuthFeaturesResponse {
    return { passwordReset: this.auth.mailEnabled };
  }

  /**
   * Requests a password reset link by e-mail. Always 202 with no body, whether or not the address has an
   * account (no enumeration). 404 when mail is not configured; 429 when the client IP is over its budget.
   */
  @Public()
  @Post('password-reset')
  @HttpCode(202)
  @Header('Cache-Control', 'no-store')
  async requestPasswordReset(
    @Body(zod(PasswordResetRequestSchema)) body: PasswordResetRequest,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    await this.auth.requestPasswordReset(body.email, requestInfo(request));
  }

  /** Accepts an invitation / reset link. The user signs in afterwards with the new password. */
  @Public()
  @Post('setup-password')
  @HttpCode(204)
  async setupPassword(
    @Body(zod(SetupPasswordRequestSchema)) body: SetupPasswordRequest,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    await this.auth.setupPassword(body.token, body.password, requestInfo(request));
  }
}
