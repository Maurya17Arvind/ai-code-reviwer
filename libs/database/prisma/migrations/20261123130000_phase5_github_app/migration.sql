-- AlterTable
ALTER TABLE "provider_connections" ADD COLUMN     "account_login" VARCHAR(100),
ADD COLUMN     "installation_id" VARCHAR(50),
ALTER COLUMN "encrypted_token" DROP NOT NULL,
ALTER COLUMN "token_key_id" DROP NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "provider_connections_provider_installation_id_key" ON "provider_connections"("provider", "installation_id");


-- Hand-written: each provider kind must carry its own credential reference.
ALTER TABLE "provider_connections" ADD CONSTRAINT "provider_connections_credentials_chk"
  CHECK (
    ("provider" <> 'GITLAB' OR ("encrypted_token" IS NOT NULL AND "token_key_id" IS NOT NULL))
    AND ("provider" <> 'GITHUB' OR "installation_id" IS NOT NULL)
  );
