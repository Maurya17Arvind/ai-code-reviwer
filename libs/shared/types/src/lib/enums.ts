// Browser-safe: `zod/mini` keeps dashboard bundles small.
import * as z from 'zod/mini';

/**
 * Domain enumerations shared by every layer (browser-safe).
 * Values MUST stay identical to the Prisma enums in libs/database/prisma/schema.prisma —
 * this is enforced by libs/database/src/lib/enum-alignment.spec.ts.
 */

export const OrganizationRoleSchema = z.enum(['OWNER', 'ADMIN', 'MEMBER', 'VIEWER']);
export type OrganizationRole = z.infer<typeof OrganizationRoleSchema>;

export const GitProviderKindSchema = z.enum(['GITHUB', 'GITLAB', 'LOCAL']);
export type GitProviderKind = z.infer<typeof GitProviderKindSchema>;

export const AuditActorTypeSchema = z.enum(['USER', 'SYSTEM', 'WEBHOOK']);
export type AuditActorType = z.infer<typeof AuditActorTypeSchema>;
