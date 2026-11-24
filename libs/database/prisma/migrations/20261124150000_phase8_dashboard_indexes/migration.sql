-- Phase 8: indexes for dashboard list queries (keyset pagination over created_at, id).

-- CreateIndex
CREATE INDEX "review_sessions_organization_id_status_created_at_idx" ON "review_sessions"("organization_id", "status", "created_at" DESC);

-- CreateIndex
CREATE INDEX "review_findings_organization_id_created_at_id_idx" ON "review_findings"("organization_id", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "review_findings_organization_id_severity_created_at_idx" ON "review_findings"("organization_id", "severity", "created_at" DESC);

-- CreateIndex
CREATE INDEX "review_findings_last_session_id_idx" ON "review_findings"("last_session_id");

-- CreateIndex
CREATE INDEX "approval_requests_organization_id_created_at_idx" ON "approval_requests"("organization_id", "created_at" DESC);
