import {
  type AddMemberRequest,
  AddMemberRequestSchema,
  type AddMemberResponse,
  type AiProviderStatus,
  type CreateOrganizationRequest,
  CreateOrganizationRequestSchema,
  IdSchema,
  type Member,
  type Organization,
  type OrganizationSettings,
  type OrganizationSettingsInput,
  OrganizationSettingsInputSchema,
  type SetupLink,
  type UpdateMemberRequest,
  UpdateMemberRequestSchema,
  type UpdateOrganizationRequest,
  UpdateOrganizationRequestSchema,
} from '@acra/shared-contracts';
import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Put, UseGuards } from '@nestjs/common';
import {
  type AuthContext,
  CurrentAuth,
  CurrentMembership,
  type MembershipContext,
  MinRole,
  RequestMeta,
} from '../auth/auth-context';
import { OrganizationGuard } from '../auth/guards';
import { zod } from '../common/zod-validation.pipe';
import { OrganizationsService, type RequestMeta as Meta } from './organizations.service';

/** Organizations the caller belongs to, and creating new ones (the creator becomes OWNER). */
@Controller('v1/organizations')
export class OrganizationsController {
  constructor(@Inject(OrganizationsService) private readonly organizations: OrganizationsService) {}

  @Post()
  create(
    @CurrentAuth() auth: AuthContext,
    @Body(zod(CreateOrganizationRequestSchema)) body: CreateOrganizationRequest,
    @RequestMeta() meta: Meta,
  ): Promise<Organization> {
    return this.organizations.create(auth, body, meta);
  }
}

/** One organization: details, members, review policy and AI provider status. */
@Controller('v1/organizations/:orgId')
@UseGuards(OrganizationGuard)
export class OrganizationController {
  constructor(@Inject(OrganizationsService) private readonly organizations: OrganizationsService) {}

  @Get()
  get(@CurrentMembership() membership: MembershipContext): Promise<Organization> {
    return this.organizations.get(membership);
  }

  @Patch()
  @MinRole('ADMIN')
  rename(
    @CurrentAuth() auth: AuthContext,
    @CurrentMembership() membership: MembershipContext,
    @Body(zod(UpdateOrganizationRequestSchema)) body: UpdateOrganizationRequest,
    @RequestMeta() meta: Meta,
  ): Promise<Organization> {
    return this.organizations.rename(auth, membership, body.name, meta);
  }

  @Get('members')
  listMembers(@CurrentMembership() membership: MembershipContext): Promise<Member[]> {
    return this.organizations.listMembers(membership);
  }

  @Post('members')
  @MinRole('ADMIN')
  addMember(
    @CurrentAuth() auth: AuthContext,
    @CurrentMembership() membership: MembershipContext,
    @Body(zod(AddMemberRequestSchema)) body: AddMemberRequest,
    @RequestMeta() meta: Meta,
  ): Promise<AddMemberResponse> {
    return this.organizations.addMember(auth, membership, body, meta);
  }

  @Patch('members/:memberId')
  @MinRole('ADMIN')
  updateMember(
    @CurrentAuth() auth: AuthContext,
    @CurrentMembership() membership: MembershipContext,
    @Param('memberId', zod(IdSchema)) memberId: string,
    @Body(zod(UpdateMemberRequestSchema)) body: UpdateMemberRequest,
    @RequestMeta() meta: Meta,
  ): Promise<Member> {
    return this.organizations.updateRole(auth, membership, memberId, body.role, meta);
  }

  @Delete('members/:memberId')
  @MinRole('ADMIN')
  @HttpCode(204)
  async removeMember(
    @CurrentAuth() auth: AuthContext,
    @CurrentMembership() membership: MembershipContext,
    @Param('memberId', zod(IdSchema)) memberId: string,
    @RequestMeta() meta: Meta,
  ): Promise<void> {
    await this.organizations.removeMember(auth, membership, memberId, meta);
  }

  @Post('members/:memberId/setup-link')
  @MinRole('ADMIN')
  setupLink(
    @CurrentAuth() auth: AuthContext,
    @CurrentMembership() membership: MembershipContext,
    @Param('memberId', zod(IdSchema)) memberId: string,
  ): Promise<SetupLink> {
    return this.organizations.issueSetupLink(auth, membership, memberId);
  }

  @Get('settings')
  settings(@CurrentMembership() membership: MembershipContext): Promise<OrganizationSettings> {
    return this.organizations.getSettings(membership);
  }

  @Put('settings')
  @MinRole('ADMIN')
  saveSettings(
    @CurrentAuth() auth: AuthContext,
    @CurrentMembership() membership: MembershipContext,
    @Body(zod(OrganizationSettingsInputSchema)) body: OrganizationSettingsInput,
    @RequestMeta() meta: Meta,
  ): Promise<OrganizationSettings> {
    return this.organizations.saveSettings(auth, membership, body, meta);
  }

  @Get('ai-providers')
  aiProviders(@CurrentMembership() membership: MembershipContext): Promise<AiProviderStatus[]> {
    return this.organizations.providerStatus(membership);
  }
}
