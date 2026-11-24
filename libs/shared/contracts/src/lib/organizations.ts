// Browser-safe: `zod/mini` keeps dashboard bundles small.
import { OrganizationRoleSchema, SeveritySchema } from '@acra/shared-types';
import * as z from 'zod/mini';
import { EmailSchema } from './auth';
import { NullableTimestampSchema, TimestampSchema } from './common';

export const OrganizationSlugSchema = z
  .string()
  .check(
    z.minLength(2),
    z.maxLength(100),
    z.regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'lower-case letters, digits and dashes'),
  );

const NameSchema = z.string().check(z.trim(), z.minLength(1), z.maxLength(200));

export const CreateOrganizationRequestSchema = z.object({ name: NameSchema, slug: OrganizationSlugSchema });
export type CreateOrganizationRequest = z.infer<typeof CreateOrganizationRequestSchema>;

export const UpdateOrganizationRequestSchema = z.object({ name: NameSchema });
export type UpdateOrganizationRequest = z.infer<typeof UpdateOrganizationRequestSchema>;

export const OrganizationSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  /** The caller's role in this organization. */
  role: OrganizationRoleSchema,
  createdAt: TimestampSchema,
});
export type Organization = z.infer<typeof OrganizationSchema>;

export const MemberSchema = z.object({
  id: z.string(),
  userId: z.string(),
  email: z.string(),
  displayName: z.string(),
  role: OrganizationRoleSchema,
  /** False until the user accepted the invitation and chose a password. */
  hasPassword: z.boolean(),
  lastLoginAt: NullableTimestampSchema,
  createdAt: TimestampSchema,
});
export type Member = z.infer<typeof MemberSchema>;

export const AddMemberRequestSchema = z.object({
  email: EmailSchema,
  displayName: NameSchema,
  role: OrganizationRoleSchema,
});
export type AddMemberRequest = z.infer<typeof AddMemberRequestSchema>;

export const UpdateMemberRequestSchema = z.object({ role: OrganizationRoleSchema });
export type UpdateMemberRequest = z.infer<typeof UpdateMemberRequestSchema>;

/** One-time password setup link. Shown once; only its hash is stored. */
export const SetupLinkSchema = z.object({ setupUrl: z.string(), expiresAt: TimestampSchema });
export type SetupLink = z.infer<typeof SetupLinkSchema>;

export const AddMemberResponseSchema = z.object({ member: MemberSchema, setupLink: z.nullable(SetupLinkSchema) });
export type AddMemberResponse = z.infer<typeof AddMemberResponseSchema>;

/**
 * Organization review policy. It can only make a repository's ai-review.yaml stricter: a provider
 * or fix proposals disabled here stay disabled, and the floors raise the repository's thresholds.
 */
export const OrganizationSettingsInputSchema = z.object({
  reviewsEnabled: z.boolean(),
  allowClaude: z.boolean(),
  allowOpenai: z.boolean(),
  allowOllama: z.boolean(),
  allowFixProposals: z.boolean(),
  minimumSeverityFloor: z.nullable(SeveritySchema),
  minimumConfidenceFloor: z.nullable(z.number().check(z.gte(0), z.lte(1))),
});
export type OrganizationSettingsInput = z.infer<typeof OrganizationSettingsInputSchema>;

export const OrganizationSettingsSchema = z.object({
  ...OrganizationSettingsInputSchema.shape,
  updatedAt: NullableTimestampSchema,
});
export type OrganizationSettings = z.infer<typeof OrganizationSettingsSchema>;

export const AiProviderNameSchema = z.enum(['claude', 'gpt', 'ollama']);
export type AiProviderName = z.infer<typeof AiProviderNameSchema>;

/**
 * What the platform has observed for one AI provider (the API never sees worker API keys, so
 * availability is derived from recorded executions).
 */
export const AiProviderStatusSchema = z.object({
  provider: AiProviderNameSchema,
  allowedByPolicy: z.boolean(),
  lastExecutionAt: NullableTimestampSchema,
  lastStatus: z.nullable(z.string()),
  lastErrorKind: z.nullable(z.string()),
  lastModel: z.nullable(z.string()),
  executions30d: z.int(),
  failures30d: z.int(),
});
export type AiProviderStatus = z.infer<typeof AiProviderStatusSchema>;
