-- CreateEnum
CREATE TYPE "review_session_status" AS ENUM ('QUEUED', 'RUNNING', 'COMPLETED', 'PARTIAL', 'FAILED', 'SUPERSEDED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "finding_status" AS ENUM ('NEW', 'VALIDATED', 'PUBLISHED', 'RESOLVED', 'DISMISSED', 'FALSE_POSITIVE');

-- CreateEnum
CREATE TYPE "comment_kind" AS ENUM ('INLINE', 'SUMMARY');

-- CreateEnum
CREATE TYPE "webhook_delivery_status" AS ENUM ('ACCEPTED', 'IGNORED', 'REJECTED');

-- AlterTable
ALTER TABLE "repositories" ADD COLUMN     "connection_id" UUID,
ADD COLUMN     "webhook_id" VARCHAR(100),
ADD COLUMN     "webhook_secret_hash" VARCHAR(64);

-- CreateTable
CREATE TABLE "provider_connections" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "provider" "git_provider_kind" NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "base_url" VARCHAR(2048) NOT NULL,
    "encrypted_token" JSONB NOT NULL,
    "token_key_id" VARCHAR(32) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "provider_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "review_sessions" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "repository_id" UUID NOT NULL,
    "request_id" INTEGER,
    "base_sha" VARCHAR(64),
    "head_sha" VARCHAR(64) NOT NULL,
    "context_hash" VARCHAR(64),
    "prompt_hash" VARCHAR(64),
    "status" "review_session_status" NOT NULL DEFAULT 'QUEUED',
    "idempotency_key" VARCHAR(200) NOT NULL,
    "report" JSONB,
    "error_code" VARCHAR(100),
    "error_message" VARCHAR(1000),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMPTZ(3),
    "finished_at" TIMESTAMPTZ(3),

    CONSTRAINT "review_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "model_executions" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "review_session_id" UUID NOT NULL,
    "provider" VARCHAR(20) NOT NULL,
    "model" VARCHAR(100) NOT NULL,
    "served_by_model" VARCHAR(100),
    "status" VARCHAR(20) NOT NULL,
    "error_kind" VARCHAR(50),
    "input_tokens" INTEGER NOT NULL DEFAULT 0,
    "output_tokens" INTEGER NOT NULL DEFAULT 0,
    "cache_read_tokens" INTEGER NOT NULL DEFAULT 0,
    "cost_micros" BIGINT,
    "latency_ms" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "model_executions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "review_findings" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "repository_id" UUID NOT NULL,
    "request_id" INTEGER NOT NULL,
    "fingerprint" VARCHAR(64) NOT NULL,
    "last_session_id" UUID NOT NULL,
    "file_path" VARCHAR(1000) NOT NULL,
    "line_number" INTEGER,
    "end_line_number" INTEGER,
    "severity" VARCHAR(10) NOT NULL,
    "category" VARCHAR(40) NOT NULL,
    "title" VARCHAR(300) NOT NULL,
    "description" TEXT NOT NULL,
    "evidence" TEXT NOT NULL,
    "suggestion" TEXT,
    "confidence" DOUBLE PRECISION NOT NULL,
    "sources" TEXT[],
    "placement" VARCHAR(10) NOT NULL,
    "status" "finding_status" NOT NULL,
    "first_seen_sha" VARCHAR(64) NOT NULL,
    "last_seen_sha" VARCHAR(64) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "review_findings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "review_comments" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "review_session_id" UUID NOT NULL,
    "finding_id" UUID,
    "kind" "comment_kind" NOT NULL,
    "provider_discussion_id" VARCHAR(100),
    "provider_note_id" VARCHAR(100) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "review_comments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_deliveries" (
    "id" UUID NOT NULL,
    "provider" "git_provider_kind" NOT NULL,
    "delivery_id" VARCHAR(200) NOT NULL,
    "repository_id" UUID,
    "event" VARCHAR(100) NOT NULL,
    "status" "webhook_delivery_status" NOT NULL,
    "reason" VARCHAR(200),
    "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "provider_connections_organization_id_provider_name_key" ON "provider_connections"("organization_id", "provider", "name");

-- CreateIndex
CREATE UNIQUE INDEX "review_sessions_idempotency_key_key" ON "review_sessions"("idempotency_key");

-- CreateIndex
CREATE INDEX "review_sessions_repository_id_request_id_created_at_idx" ON "review_sessions"("repository_id", "request_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "review_sessions_organization_id_created_at_idx" ON "review_sessions"("organization_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "model_executions_review_session_id_idx" ON "model_executions"("review_session_id");

-- CreateIndex
CREATE INDEX "model_executions_organization_id_created_at_idx" ON "model_executions"("organization_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "review_findings_organization_id_status_idx" ON "review_findings"("organization_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "review_findings_repository_id_request_id_fingerprint_key" ON "review_findings"("repository_id", "request_id", "fingerprint");

-- CreateIndex
CREATE INDEX "review_comments_review_session_id_idx" ON "review_comments"("review_session_id");

-- CreateIndex
CREATE INDEX "review_comments_finding_id_idx" ON "review_comments"("finding_id");

-- CreateIndex
CREATE INDEX "webhook_deliveries_repository_id_received_at_idx" ON "webhook_deliveries"("repository_id", "received_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "webhook_deliveries_provider_delivery_id_key" ON "webhook_deliveries"("provider", "delivery_id");

-- AddForeignKey
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "provider_connections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_connections" ADD CONSTRAINT "provider_connections_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_sessions" ADD CONSTRAINT "review_sessions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_sessions" ADD CONSTRAINT "review_sessions_repository_id_fkey" FOREIGN KEY ("repository_id") REFERENCES "repositories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "model_executions" ADD CONSTRAINT "model_executions_review_session_id_fkey" FOREIGN KEY ("review_session_id") REFERENCES "review_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_findings" ADD CONSTRAINT "review_findings_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_findings" ADD CONSTRAINT "review_findings_repository_id_fkey" FOREIGN KEY ("repository_id") REFERENCES "repositories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_comments" ADD CONSTRAINT "review_comments_review_session_id_fkey" FOREIGN KEY ("review_session_id") REFERENCES "review_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_comments" ADD CONSTRAINT "review_comments_finding_id_fkey" FOREIGN KEY ("finding_id") REFERENCES "review_findings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Hand-written additions: value constraints for columns stored as text.
-- ---------------------------------------------------------------------------
ALTER TABLE "review_findings" ADD CONSTRAINT "review_findings_severity_chk"
  CHECK ("severity" IN ('critical', 'high', 'medium', 'low'));
ALTER TABLE "review_findings" ADD CONSTRAINT "review_findings_placement_chk"
  CHECK ("placement" IN ('inline', 'summary'));
ALTER TABLE "review_findings" ADD CONSTRAINT "review_findings_confidence_chk"
  CHECK ("confidence" >= 0 AND "confidence" <= 1);
ALTER TABLE "model_executions" ADD CONSTRAINT "model_executions_status_chk"
  CHECK ("status" IN ('succeeded', 'failed', 'skipped'));
