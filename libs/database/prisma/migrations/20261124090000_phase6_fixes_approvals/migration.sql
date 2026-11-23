-- CreateEnum
CREATE TYPE "proposed_fix_status" AS ENUM ('PROPOSED', 'APPLIED', 'OPENED', 'SUPERSEDED', 'REJECTED');

-- CreateEnum
CREATE TYPE "approval_status" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED', 'INVALIDATED', 'EXECUTING', 'EXECUTED', 'FAILED');

-- CreateEnum
CREATE TYPE "approval_operation_kind" AS ENUM ('APPLY_FIX', 'STAGE_CHANGES', 'COMMIT_CHANGES', 'PUSH_BRANCH', 'COMMIT_AND_PUSH_FIX', 'CREATE_MERGE_REQUEST', 'CREATE_PULL_REQUEST');

-- CreateTable
CREATE TABLE "proposed_fixes" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "repository_id" UUID NOT NULL,
    "review_session_id" UUID NOT NULL,
    "finding_id" UUID NOT NULL,
    "request_id" INTEGER NOT NULL,
    "fingerprint" VARCHAR(64) NOT NULL,
    "file_path" VARCHAR(1000) NOT NULL,
    "base_sha" VARCHAR(64) NOT NULL,
    "target_branch" VARCHAR(255) NOT NULL,
    "explanation" TEXT NOT NULL,
    "changes" JSONB NOT NULL,
    "patch" TEXT NOT NULL,
    "patch_sha256" CHAR(64) NOT NULL,
    "original_sha256" CHAR(64) NOT NULL,
    "result_sha256" CHAR(64) NOT NULL,
    "additions" INTEGER NOT NULL,
    "deletions" INTEGER NOT NULL,
    "provider" VARCHAR(20) NOT NULL,
    "model" VARCHAR(100) NOT NULL,
    "cost_micros" BIGINT,
    "status" "proposed_fix_status" NOT NULL DEFAULT 'PROPOSED',
    "branch" VARCHAR(255) NOT NULL,
    "commit_sha" VARCHAR(64),
    "review_request_url" VARCHAR(2048),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "proposed_fixes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_requests" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "repository_id" UUID NOT NULL,
    "review_session_id" UUID NOT NULL,
    "proposed_fix_id" UUID,
    "request_id" INTEGER NOT NULL,
    "head_sha" VARCHAR(64) NOT NULL,
    "operation_kind" "approval_operation_kind" NOT NULL,
    "operation" JSONB NOT NULL,
    "patch_sha256" CHAR(64),
    "binding_hash" CHAR(64) NOT NULL,
    "status" "approval_status" NOT NULL DEFAULT 'PENDING',
    "requested_by_id" UUID NOT NULL,
    "requested_by" JSONB NOT NULL,
    "decided_by_id" UUID,
    "decided_by" JSONB,
    "decided_at" TIMESTAMPTZ(3),
    "reason" VARCHAR(500),
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "executed_at" TIMESTAMPTZ(3),
    "result" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "approval_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "proposed_fixes_repository_id_request_id_status_idx" ON "proposed_fixes"("repository_id", "request_id", "status");

-- CreateIndex
CREATE INDEX "proposed_fixes_organization_id_created_at_idx" ON "proposed_fixes"("organization_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "approval_requests_organization_id_status_expires_at_idx" ON "approval_requests"("organization_id", "status", "expires_at");

-- CreateIndex
CREATE INDEX "approval_requests_repository_id_request_id_status_idx" ON "approval_requests"("repository_id", "request_id", "status");

-- CreateIndex
CREATE INDEX "approval_requests_proposed_fix_id_idx" ON "approval_requests"("proposed_fix_id");

-- AddForeignKey
ALTER TABLE "proposed_fixes" ADD CONSTRAINT "proposed_fixes_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "proposed_fixes" ADD CONSTRAINT "proposed_fixes_review_session_id_fkey" FOREIGN KEY ("review_session_id") REFERENCES "review_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "proposed_fixes" ADD CONSTRAINT "proposed_fixes_finding_id_fkey" FOREIGN KEY ("finding_id") REFERENCES "review_findings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_review_session_id_fkey" FOREIGN KEY ("review_session_id") REFERENCES "review_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_proposed_fix_id_fkey" FOREIGN KEY ("proposed_fix_id") REFERENCES "proposed_fixes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_requested_by_id_fkey" FOREIGN KEY ("requested_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_decided_by_id_fkey" FOREIGN KEY ("decided_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Defence in depth (also enforced in @acra/approvals):
-- operations that write a fix are bound to the patch hash; a decision needs a decider;
-- executed requests must have been approved by a user.
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_patch_bound_chk"
  CHECK ("operation_kind" NOT IN ('APPLY_FIX', 'COMMIT_AND_PUSH_FIX') OR "patch_sha256" IS NOT NULL);
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_decision_chk"
  CHECK ("status" NOT IN ('APPROVED', 'REJECTED', 'EXECUTING', 'EXECUTED', 'FAILED')
         OR ("decided_by_id" IS NOT NULL AND "decided_at" IS NOT NULL));
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_expiry_chk"
  CHECK ("expires_at" > "created_at" AND "expires_at" <= "created_at" + interval '7 days');
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_hashes_chk"
  CHECK ("binding_hash" ~ '^[0-9a-f]{64}$' AND ("patch_sha256" IS NULL OR "patch_sha256" ~ '^[0-9a-f]{64}$'));
ALTER TABLE "proposed_fixes" ADD CONSTRAINT "proposed_fixes_counts_chk"
  CHECK ("additions" >= 0 AND "deletions" >= 0 AND "patch_sha256" ~ '^[0-9a-f]{64}$');
ALTER TABLE "proposed_fixes" ADD CONSTRAINT "proposed_fixes_branch_chk"
  CHECK ("branch" ~ '^ai-review/fix-[0-9a-f]{8,40}$');
