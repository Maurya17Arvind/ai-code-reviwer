import {
  AuthStore,
  InsightsStore,
  type MemberRecord,
  type OrganizationPolicy,
  OrganizationStore,
  type RequestAuditContext,
  type TenantContext,
} from '@acra/database';
import {
  type AddMemberRequest,
  type AddMemberResponse,
  type AiProviderStatus,
  type Member,
  type Organization,
  type OrganizationSettings,
  type OrganizationSettingsInput,
  type SetupLink,
} from '@acra/shared-contracts';
import { type OrganizationRole, SEVERITY_ORDER, type Severity } from '@acra/shared-types';
import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { type AuthContext, hasRole, type MembershipContext } from '../auth/auth-context';
import { AuthService } from '../auth/auth.service';
import { mapErrors } from '../common/domain-errors';

const iso = (date: Date) => date.toISOString();

function toMember(m: MemberRecord): Member {
  return { ...m, lastLoginAt: m.lastLoginAt ? iso(m.lastLoginAt) : null, createdAt: iso(m.createdAt) };
}

/**
 * Organizations, members and the organization review policy. Role rules:
 *  - ADMIN and OWNER manage members; only an OWNER can grant, change or remove the OWNER role.
 *  - Nobody changes or removes their own membership here (prevents accidental lock-out).
 *  - An organization always keeps at least one OWNER (enforced transactionally in the store).
 */
@Injectable()
export class OrganizationsService {
  constructor(
    @Inject(OrganizationStore) private readonly store: OrganizationStore,
    @Inject(InsightsStore) private readonly insights: InsightsStore,
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(AuthStore) private readonly authStore: AuthStore,
  ) {}

  async create(auth: AuthContext, input: { name: string; slug: string }, meta: RequestMeta): Promise<Organization> {
    const org = await mapErrors(() =>
      this.store.createOrganization({ ...input, ownerUserId: auth.userId }, audit(auth, meta)),
    );
    return { ...org, role: 'OWNER', createdAt: iso(org.createdAt) };
  }

  async get(membership: MembershipContext): Promise<Organization> {
    const org = await this.store.getOrganization(tenant(membership));
    if (!org) throw new NotFoundException('Organization not found');
    return { ...org, role: membership.role, createdAt: iso(org.createdAt) };
  }

  async rename(auth: AuthContext, membership: MembershipContext, name: string, meta: RequestMeta) {
    const org = await this.store.renameOrganization(tenant(membership), name, audit(auth, meta));
    return { ...org, role: membership.role, createdAt: iso(org.createdAt) };
  }

  // ---------------- members ----------------

  async listMembers(membership: MembershipContext): Promise<Member[]> {
    return (await this.store.listMembers(tenant(membership))).map(toMember);
  }

  async addMember(
    auth: AuthContext,
    membership: MembershipContext,
    input: AddMemberRequest,
    meta: RequestMeta,
  ): Promise<AddMemberResponse> {
    assertCanAssign(membership.role, input.role);
    const member = await mapErrors(() => this.store.addMember(tenant(membership), input, audit(auth, meta)));
    // Only genuinely new people get an invitation link. An existing account (or one invited by another
    // organization) is never given a link here: whoever holds it could set that account's password.
    const setupLink = (await this.mayIssueInvitation(member))
      ? await this.auth.issueSetupLink(member.userId, 'INVITE', auth.userId)
      : null;
    return { member: toMember(member), setupLink };
  }

  async updateRole(
    auth: AuthContext,
    membership: MembershipContext,
    memberId: string,
    role: OrganizationRole,
    meta: RequestMeta,
  ): Promise<Member> {
    const target = await this.target(membership, memberId, auth);
    assertCanAssign(membership.role, target.role);
    assertCanAssign(membership.role, role);
    return toMember(
      await mapErrors(() => this.store.updateMemberRole(tenant(membership), memberId, role, audit(auth, meta))),
    );
  }

  async removeMember(auth: AuthContext, membership: MembershipContext, memberId: string, meta: RequestMeta) {
    const target = await this.target(membership, memberId, auth);
    assertCanAssign(membership.role, target.role);
    await mapErrors(() => this.store.removeMember(tenant(membership), memberId, audit(auth, meta)));
  }

  /**
   * Re-sends an invitation link. Organization admins cannot reset passwords of existing accounts:
   * identities are platform-wide, so that would let the admin of any organization take over an
   * account that also belongs to other organizations. Resets are an operator action
   * (admin CLI `users-setup-link`) until e-mail delivery lets users reset their own password.
   */
  async issueSetupLink(auth: AuthContext, membership: MembershipContext, memberId: string): Promise<SetupLink> {
    const target = await this.target(membership, memberId, auth);
    assertCanAssign(membership.role, target.role);
    if (!(await this.mayIssueInvitation(target))) {
      throw new ForbiddenException(
        'This person already has an account or was invited by another organization. Password resets are done by a platform operator.',
      );
    }
    return this.auth.issueSetupLink(target.userId, 'INVITE', auth.userId);
  }

  /** An invitation may be (re)issued only for a user without a password who belongs to this organization only. */
  private async mayIssueInvitation(member: Pick<MemberRecord, 'userId' | 'hasPassword'>): Promise<boolean> {
    return !member.hasPassword && (await this.authStore.membershipCount(member.userId)) === 1;
  }

  private async target(membership: MembershipContext, memberId: string, auth: AuthContext): Promise<MemberRecord> {
    const target = await this.store.getMember(tenant(membership), memberId);
    if (!target) throw new NotFoundException('Member not found');
    if (target.userId === auth.userId) throw new ForbiddenException('You cannot change your own membership');
    return target;
  }

  // ---------------- policy ----------------

  async getSettings(membership: MembershipContext): Promise<OrganizationSettings> {
    const policy = await this.store.getPolicy(tenant(membership));
    return toSettings(policy);
  }

  async saveSettings(
    auth: AuthContext,
    membership: MembershipContext,
    input: OrganizationSettingsInput,
    meta: RequestMeta,
  ): Promise<OrganizationSettings> {
    return toSettings(await this.store.savePolicy(tenant(membership), input, audit(auth, meta)));
  }

  async providerStatus(membership: MembershipContext): Promise<AiProviderStatus[]> {
    const t = tenant(membership);
    const [policy, activity] = await Promise.all([
      this.store.getPolicy(t),
      this.insights.providerActivity(t, ['claude', 'gpt', 'ollama']),
    ]);
    const allowed = { claude: policy.allowClaude, gpt: policy.allowOpenai, ollama: policy.allowOllama } as const;
    return activity.map((a) => ({
      ...a,
      provider: a.provider as AiProviderStatus['provider'],
      allowedByPolicy: allowed[a.provider as keyof typeof allowed],
      lastExecutionAt: a.lastExecutionAt ? iso(a.lastExecutionAt) : null,
    }));
  }
}

export interface RequestMeta {
  readonly requestId: string | null;
  readonly ipAddress: string | null;
}

export const tenant = (membership: MembershipContext): TenantContext => ({ organizationId: membership.organizationId });

export function audit(auth: AuthContext, meta: RequestMeta): RequestAuditContext {
  return { actorUserId: auth.userId, requestId: meta.requestId, ipAddress: meta.ipAddress };
}

/** Only an OWNER may grant or touch the OWNER role; ADMIN manages everyone else. */
function assertCanAssign(actor: OrganizationRole, role: OrganizationRole): void {
  if (!hasRole(actor, 'ADMIN')) throw new ForbiddenException('Managing members requires the ADMIN role or higher');
  if (role === 'OWNER' && actor !== 'OWNER') throw new ForbiddenException('Only an owner can manage owners');
}

function toSettings(policy: OrganizationPolicy & { updatedAt: Date | null }): OrganizationSettings {
  return {
    reviewsEnabled: policy.reviewsEnabled,
    allowClaude: policy.allowClaude,
    allowOpenai: policy.allowOpenai,
    allowOllama: policy.allowOllama,
    allowFixProposals: policy.allowFixProposals,
    minimumSeverityFloor: (SEVERITY_ORDER as readonly string[]).includes(policy.minimumSeverityFloor ?? '')
      ? (policy.minimumSeverityFloor as Severity)
      : null,
    minimumConfidenceFloor: policy.minimumConfidenceFloor,
    updatedAt: policy.updatedAt ? iso(policy.updatedAt) : null,
  };
}
