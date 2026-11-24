import {
  type FindingDetail,
  type FindingListQuery,
  FindingListQuerySchema,
  type FindingSummary,
  IdSchema,
  type Page,
  type ReviewDetail,
  type ReviewListQuery,
  ReviewListQuerySchema,
  type ReviewSummary,
  type UpdateFindingStatusRequest,
  UpdateFindingStatusRequestSchema,
} from '@acra/shared-contracts';
import { Body, Controller, Get, Inject, Param, Patch, Query, UseGuards } from '@nestjs/common';
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
import { type RequestMeta as Meta } from '../organizations/organizations.service';
import { ReviewsService } from './reviews.service';

@Controller('v1/organizations/:orgId')
@UseGuards(OrganizationGuard)
export class ReviewsController {
  constructor(@Inject(ReviewsService) private readonly reviews: ReviewsService) {}

  @Get('reviews')
  listReviews(
    @CurrentMembership() membership: MembershipContext,
    @Query(zod(ReviewListQuerySchema)) query: ReviewListQuery,
  ): Promise<Page<ReviewSummary>> {
    return this.reviews.listReviews(membership, query);
  }

  @Get('reviews/:reviewId')
  getReview(
    @CurrentMembership() membership: MembershipContext,
    @Param('reviewId', zod(IdSchema)) reviewId: string,
  ): Promise<ReviewDetail> {
    return this.reviews.getReview(membership, reviewId);
  }

  @Get('findings')
  listFindings(
    @CurrentMembership() membership: MembershipContext,
    @Query(zod(FindingListQuerySchema)) query: FindingListQuery,
  ): Promise<Page<FindingSummary>> {
    return this.reviews.listFindings(membership, query);
  }

  @Get('findings/:findingId')
  getFinding(
    @CurrentMembership() membership: MembershipContext,
    @Param('findingId', zod(IdSchema)) findingId: string,
  ): Promise<FindingDetail> {
    return this.reviews.getFinding(membership, findingId);
  }

  @Patch('findings/:findingId')
  @MinRole('MEMBER')
  updateFinding(
    @CurrentAuth() auth: AuthContext,
    @CurrentMembership() membership: MembershipContext,
    @Param('findingId', zod(IdSchema)) findingId: string,
    @Body(zod(UpdateFindingStatusRequestSchema)) body: UpdateFindingStatusRequest,
    @RequestMeta() meta: Meta,
  ): Promise<FindingDetail> {
    return this.reviews.updateFindingStatus(auth, membership, findingId, body, meta);
  }
}
