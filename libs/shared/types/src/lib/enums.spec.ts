import { GitProviderKindSchema, OrganizationRoleSchema } from './enums';

describe('shared enums', () => {
  it('accepts known organization roles', () => {
    expect(OrganizationRoleSchema.parse('OWNER')).toBe('OWNER');
  });

  it('rejects unknown values', () => {
    expect(GitProviderKindSchema.safeParse('BITBUCKET').success).toBe(false);
  });
});
