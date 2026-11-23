import { AuditActorTypeSchema, GitProviderKindSchema, OrganizationRoleSchema } from '@acra/shared-types';
import { AuditActorType, GitProviderKind, OrganizationRole } from '../generated/prisma/enums';

/**
 * The dashboard and CLI use the browser-safe enums from @acra/shared-types, while the
 * server persists Prisma enums. This test fails if the two definitions drift apart.
 */
describe('shared enums match Prisma enums', () => {
  it.each([
    ['OrganizationRole', OrganizationRoleSchema.options, Object.values(OrganizationRole)],
    ['GitProviderKind', GitProviderKindSchema.options, Object.values(GitProviderKind)],
    ['AuditActorType', AuditActorTypeSchema.options, Object.values(AuditActorType)],
  ])('%s', (_name, shared, prisma) => {
    expect([...shared].sort()).toEqual([...prisma].sort());
  });
});
