// Browser-safe: `zod/mini` keeps dashboard bundles small.
import { OrganizationRoleSchema } from '@acra/shared-types';
import * as z from 'zod/mini';
import { NullableTimestampSchema } from './common';

/** E-mail as accepted by the platform (stored lower-case). */
export const EmailSchema = z.email().check(z.maxLength(320));

/**
 * Password policy (NIST SP 800-63B style): length over composition rules. 12–200 characters;
 * the upper bound keeps scrypt input bounded.
 */
export const PASSWORD_MIN_LENGTH = 12;
export const PasswordSchema = z.string().check(z.minLength(PASSWORD_MIN_LENGTH), z.maxLength(200));

/** Header the dashboard sends on every state-changing request (double-submit CSRF defence). */
export const CSRF_HEADER = 'x-csrf-token';

export const LoginRequestSchema = z.object({
  email: EmailSchema,
  // Not the full policy: existing passwords are checked, not re-validated.
  password: z.string().check(z.minLength(1), z.maxLength(200)),
});
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

export const SessionUserSchema = z.object({
  id: z.string(),
  email: z.string(),
  displayName: z.string(),
  lastLoginAt: NullableTimestampSchema,
});
export type SessionUser = z.infer<typeof SessionUserSchema>;

export const MembershipSchema = z.object({
  organizationId: z.string(),
  slug: z.string(),
  name: z.string(),
  role: OrganizationRoleSchema,
});
export type Membership = z.infer<typeof MembershipSchema>;

/** Returned by login and `GET /auth/session`. The CSRF token is bound to the session cookie. */
export const SessionResponseSchema = z.object({
  user: SessionUserSchema,
  memberships: z.array(MembershipSchema),
  csrfToken: z.string(),
});
export type SessionResponse = z.infer<typeof SessionResponseSchema>;

/** Accepts an invitation or an admin-issued reset link. */
export const SetupPasswordRequestSchema = z.object({
  token: z.string().check(z.minLength(20), z.maxLength(200)),
  password: PasswordSchema,
});
export type SetupPasswordRequest = z.infer<typeof SetupPasswordRequestSchema>;

export const ChangePasswordRequestSchema = z.object({
  currentPassword: z.string().check(z.minLength(1), z.maxLength(200)),
  newPassword: PasswordSchema,
});
export type ChangePasswordRequest = z.infer<typeof ChangePasswordRequestSchema>;

/**
 * Self-service password reset (Phase 9). The API answers 202 with the same body whether or not the
 * address has an account; the reset link arrives by e-mail only.
 */
export const PasswordResetRequestSchema = z.object({
  email: EmailSchema,
});
export type PasswordResetRequest = z.infer<typeof PasswordResetRequestSchema>;

/** Public: which self-service features this installation offers (they need transactional mail). */
export const AuthFeaturesResponseSchema = z.object({
  passwordReset: z.boolean(),
});
export type AuthFeaturesResponse = z.infer<typeof AuthFeaturesResponseSchema>;
