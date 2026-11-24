import {
  type Connection,
  type ConnectGitLabRequest,
  ConnectGitLabRequestSchema,
  type ConnectGitLabResponse,
  IdSchema,
  type IntegrationCapabilities,
  type Repository,
  type UpdateRepositoryRequest,
  UpdateRepositoryRequestSchema,
} from '@acra/shared-contracts';
import { Body, Controller, Get, Header, Inject, Optional, Param, Patch, Post, UseGuards } from '@nestjs/common';
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
import { GITLAB_FETCH, RepositoriesService } from './repositories.service';

@Controller('v1/organizations/:orgId')
@UseGuards(OrganizationGuard)
export class RepositoriesController {
  constructor(
    @Inject(RepositoriesService) private readonly repositories: RepositoriesService,
    @Optional() @Inject(GITLAB_FETCH) private readonly gitlabFetch?: typeof fetch,
  ) {}

  @Get('repositories')
  list(@CurrentMembership() membership: MembershipContext): Promise<Repository[]> {
    return this.repositories.list(membership);
  }

  /** Pause or resume reviews for one repository (webhooks for inactive repositories are ignored). */
  @Patch('repositories/:repositoryId')
  @MinRole('ADMIN')
  update(
    @CurrentAuth() auth: AuthContext,
    @CurrentMembership() membership: MembershipContext,
    @Param('repositoryId', zod(IdSchema)) repositoryId: string,
    @Body(zod(UpdateRepositoryRequestSchema)) body: UpdateRepositoryRequest,
    @RequestMeta() meta: Meta,
  ): Promise<Repository> {
    return this.repositories.setActive(auth, membership, repositoryId, body.isActive, meta);
  }

  @Get('connections')
  connections(@CurrentMembership() membership: MembershipContext): Promise<Connection[]> {
    return this.repositories.listConnections(membership);
  }

  @Get('integrations')
  capabilities(): IntegrationCapabilities {
    return this.repositories.capabilities();
  }

  @Post('connections/gitlab')
  @MinRole('ADMIN')
  @Header('Cache-Control', 'no-store')
  connectGitLab(
    @CurrentAuth() auth: AuthContext,
    @CurrentMembership() membership: MembershipContext,
    @Body(zod(ConnectGitLabRequestSchema)) body: ConnectGitLabRequest,
    @RequestMeta() meta: Meta,
  ): Promise<ConnectGitLabResponse> {
    return this.repositories.connectGitLab(auth, membership, body, meta, this.gitlabFetch);
  }
}
