import {
  type ApprovalDecisionResponse,
  type ApprovalDetail,
  type ApprovalListQuery,
  ApprovalListQuerySchema,
  type ApprovalSummary,
  type ApproveRequest,
  ApproveRequestSchema,
  type CreateApprovalRequest,
  CreateApprovalRequestSchema,
  type FixDetail,
  type FixSummary,
  IdSchema,
  type RejectRequest,
  RejectRequestSchema,
} from '@acra/shared-contracts';
import { Body, Controller, Get, Header, HttpCode, Inject, Param, Post, Query, UseGuards } from '@nestjs/common';
import {
  type AuthContext,
  CurrentAuth,
  CurrentMembership,
  type MembershipContext,
  MinRole,
} from '../auth/auth-context';
import { OrganizationGuard } from '../auth/guards';
import { zod } from '../common/zod-validation.pipe';
import { ApprovalsService } from './approvals.service';

/**
 * Fix proposals and approvals. Viewing is open to every member; requesting and deciding needs
 * MEMBER or higher (the approvals state machine enforces the same rule independently).
 */
@Controller('v1/organizations/:orgId')
@UseGuards(OrganizationGuard)
export class ApprovalsController {
  constructor(@Inject(ApprovalsService) private readonly approvals: ApprovalsService) {}

  @Get('fixes')
  listFixes(@CurrentMembership() membership: MembershipContext): Promise<FixSummary[]> {
    return this.approvals.listFixes(membership);
  }

  @Get('fixes/:fixId')
  getFix(
    @CurrentMembership() membership: MembershipContext,
    @Param('fixId', zod(IdSchema)) fixId: string,
  ): Promise<FixDetail> {
    return this.approvals.getFix(membership, fixId);
  }

  @Get('approvals')
  listApprovals(
    @CurrentMembership() membership: MembershipContext,
    @Query(zod(ApprovalListQuerySchema)) query: ApprovalListQuery,
  ): Promise<ApprovalSummary[]> {
    return this.approvals.listApprovals(membership, query.scope);
  }

  @Get('approvals/:approvalId')
  @Header('Cache-Control', 'no-store')
  getApproval(
    @CurrentMembership() membership: MembershipContext,
    @Param('approvalId', zod(IdSchema)) approvalId: string,
  ): Promise<ApprovalDetail> {
    return this.approvals.getApproval(membership, approvalId);
  }

  @Post('approvals')
  @MinRole('MEMBER')
  request(
    @CurrentAuth() auth: AuthContext,
    @CurrentMembership() membership: MembershipContext,
    @Body(zod(CreateApprovalRequestSchema)) body: CreateApprovalRequest,
  ): Promise<ApprovalDetail> {
    return this.approvals.request(auth, membership, body);
  }

  @Post('approvals/:approvalId/approve')
  @MinRole('MEMBER')
  @HttpCode(200)
  approve(
    @CurrentAuth() auth: AuthContext,
    @CurrentMembership() membership: MembershipContext,
    @Param('approvalId', zod(IdSchema)) approvalId: string,
    @Body(zod(ApproveRequestSchema)) body: ApproveRequest,
  ): Promise<ApprovalDecisionResponse> {
    return this.approvals.approve(auth, membership, approvalId, body.code);
  }

  @Post('approvals/:approvalId/reject')
  @MinRole('MEMBER')
  @HttpCode(200)
  reject(
    @CurrentAuth() auth: AuthContext,
    @CurrentMembership() membership: MembershipContext,
    @Param('approvalId', zod(IdSchema)) approvalId: string,
    @Body(zod(RejectRequestSchema)) body: RejectRequest,
  ): Promise<ApprovalDecisionResponse> {
    return this.approvals.reject(auth, membership, approvalId, body.reason);
  }
}
