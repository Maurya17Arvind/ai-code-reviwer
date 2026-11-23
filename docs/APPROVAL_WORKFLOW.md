# Approval Workflow

> Status: **not implemented** — requirements baseline. Implementation in Phase 6.

| Operation                                                     | Permission                     |
| ------------------------------------------------------------- | ------------------------------ |
| Receive webhook, fetch changes, run review, validate findings | Automatic                      |
| Publish validated comments, generate fix proposals            | Automatic                      |
| Apply code fixes, stage, commit, push branch                  | **Human approval**             |
| Create GitLab MR / GitHub PR                                  | **Human approval**             |
| Merge MR/PR                                                   | **Disabled — not implemented** |

Every approval request is bound to: user, organization, repository, review session, commit SHA, the exact
operation, the exact patch (stored with its SHA-256), and an expiry. A change of the reviewed head SHA
invalidates all pending approvals for the previous SHA. Untrusted content (code, comments, AI output) can
never create, approve or widen an approval.

To be documented in Phase 6: state machine, API, audit events, sandboxed validation runner.
