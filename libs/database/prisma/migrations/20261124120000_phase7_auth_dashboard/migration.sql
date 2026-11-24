-- Phase 7: dashboard authentication (sessions, setup links) and organization review policy.

-- CreateEnum
CREATE TYPE "setup_token_purpose" AS ENUM ('INVITE', 'RESET');

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "failed_login_count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "last_login_at" TIMESTAMPTZ(3),
ADD COLUMN     "locked_until" TIMESTAMPTZ(3),
ADD COLUMN     "password_changed_at" TIMESTAMPTZ(3),
ADD COLUMN     "password_hash" VARCHAR(255);

-- CreateTable
CREATE TABLE "user_sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" CHAR(64) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),
    "ip_address" INET,
    "user_agent" VARCHAR(300),

    CONSTRAINT "user_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_setup_tokens" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" CHAR(64) NOT NULL,
    "purpose" "setup_token_purpose" NOT NULL,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "used_at" TIMESTAMPTZ(3),

    CONSTRAINT "user_setup_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organization_settings" (
    "organization_id" UUID NOT NULL,
    "reviews_enabled" BOOLEAN NOT NULL DEFAULT true,
    "allow_claude" BOOLEAN NOT NULL DEFAULT true,
    "allow_openai" BOOLEAN NOT NULL DEFAULT true,
    "allow_ollama" BOOLEAN NOT NULL DEFAULT true,
    "allow_fix_proposals" BOOLEAN NOT NULL DEFAULT true,
    "minimum_severity_floor" VARCHAR(10),
    "minimum_confidence_floor" DOUBLE PRECISION,
    "updated_by_id" UUID,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "organization_settings_pkey" PRIMARY KEY ("organization_id"),
    CONSTRAINT "organization_settings_severity_floor_check"
      CHECK ("minimum_severity_floor" IS NULL OR "minimum_severity_floor" IN ('critical', 'high', 'medium', 'low')),
    CONSTRAINT "organization_settings_confidence_floor_check"
      CHECK ("minimum_confidence_floor" IS NULL OR ("minimum_confidence_floor" >= 0 AND "minimum_confidence_floor" <= 1))
);

-- CreateIndex
CREATE UNIQUE INDEX "user_sessions_token_hash_key" ON "user_sessions"("token_hash");

-- CreateIndex
CREATE INDEX "user_sessions_user_id_expires_at_idx" ON "user_sessions"("user_id", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "user_setup_tokens_token_hash_key" ON "user_setup_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "user_setup_tokens_user_id_idx" ON "user_setup_tokens"("user_id");

-- AddForeignKey
ALTER TABLE "user_sessions" ADD CONSTRAINT "user_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_setup_tokens" ADD CONSTRAINT "user_setup_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_setup_tokens" ADD CONSTRAINT "user_setup_tokens_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_settings" ADD CONSTRAINT "organization_settings_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
