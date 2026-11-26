-- Phase 9 step 4: e-mail verification.
-- Existing users stay unverified (NULL) until they use a link that arrived by e-mail.

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "email_verified_at" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "user_setup_tokens" ADD COLUMN     "delivered_by_email" BOOLEAN NOT NULL DEFAULT false;
