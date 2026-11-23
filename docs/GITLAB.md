# GitLab Integration

> Implemented in Phase 4. Verified end to end against a fake GitLab REST v4 server
> (`tools/testing/fake-gitlab.ts`). **Not yet run against a real GitLab instance.**

## How it works

```text
GitLab MR opened / new commits
        │  POST /api/webhooks/gitlab/<repositoryId>   (X-Gitlab-Token)
        ▼
apps/api  ── verify token hash · project id match · event filter · dedupe delivery ──► BullMQ "reviews"
                                                                                          │
apps/worker ◄─────────────────────────────────────────────────────────────────────────────┘
  fetch MR + diffs at head SHA → ai-review.yaml at head → review pipeline (Claude / GPT / Ollama)
  → re-check MR head (never publish stale results)
  → inline comments on diff lines · one summary note (updated in place) · resolve fixed threads
  → PostgreSQL: session, executions, findings lifecycle, comments, audit log
```

- **Triggers:** MR `open`, `reopen`, and `update` _with new commits_ (`oldrev`). Title or description edits,
  closes and merges are ignored.
- **One review per head commit:** the idempotency key and the BullMQ job id are both
  `(repository, MR, head SHA)`.
- **Superseded commits:** a job whose head SHA is no longer the MR head is skipped. If a newer commit lands
  while the models are running, nothing is published.
- **Comments:**
  - Inline discussions are only placed on lines that are in the diff (added or unchanged context).
    Everything else goes into the summary note.
  - Each bot comment carries a hidden fingerprint marker, so re-reviews never duplicate a comment.
    Markers are honoured **only on notes authored by the bot account**.
  - When a finding disappears in a later commit, its thread is **resolved** and the finding becomes
    `RESOLVED`.
- **The bot never approves, merges or changes code.** Model-written text is escaped:
  - GitLab quick actions (`/merge`, `/approve`, …) and `@mentions` are neutralised;
  - Markdown and HTML are escaped.

## 1. Create a token

Use a **project access token**, or a token of a dedicated bot user, with:

| Need                                                | Scope / role                                           |
| --------------------------------------------------- | ------------------------------------------------------ |
| Read MRs, diffs and files; comment; resolve threads | `api` scope, role **Developer**                        |
| Register the project webhook automatically          | role **Maintainer** (otherwise use `--manual-webhook`) |

Do not use a personal token of a human administrator.

## 2. Configure the server (`.env` or environment)

```dotenv
CREDENTIALS_MASTER_KEY=<base64 32 bytes>   # node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
GITLAB_ALLOWED_HOSTS=gitlab.com            # comma-separated; add your self-hosted host
GITLAB_ALLOW_PRIVATE_NETWORK=false         # true only for on-prem GitLab on a private network
WEBHOOK_PUBLIC_BASE_URL=https://<public URL of apps/api>
```

For local development, expose the API with a tunnel. For example: `cloudflared tunnel --url http://127.0.0.1:3000`
or `ngrok http 3000`. Then use the tunnel's https URL as `WEBHOOK_PUBLIC_BASE_URL`.

## 3. Connect a project

```powershell
pnpm nx build api
$env:GITLAB_TOKEN = Read-Host 'GitLab token' -MaskInput   # never pass tokens as arguments
node dist/apps/api/admin.js connect-gitlab --org acme --org-name "Acme" --project group/app --base-url https://gitlab.com
Remove-Item Env:GITLAB_TOKEN
```

The command does the following:

1. Validates the host against the SSRF policy.
2. Proves the token can read the project.
3. Stores the token envelope-encrypted, bound to the connection id.
4. Registers the repository.
5. Creates a project hook for **merge request events** with a random per-repository secret. Only the secret's
   SHA-256 is stored.

Re-running it is safe: it upserts the records and rotates the webhook secret.

Options: `--manual-webhook` prints the URL and the secret once, for manual setup under Settings → Webhooks.
`--no-webhook` skips webhook setup entirely.

## 4. Run

```powershell
pnpm infra:up; pnpm db:migrate
pnpm dev:api        # webhook intake
pnpm dev:worker     # reviews (needs AI provider settings, see CLI.md: ANTHROPIC_*, OPENAI_*, OLLAMA_*)
```

Open or push to a merge request. The worker logs the review, and the MR receives inline comments plus a summary.
Repository behaviour is controlled by `ai-review.yaml` at the MR's head commit (providers, thresholds,
exclusions, `publishing.inlineComments` / `summary`).

## Limitations

- GitLab's `diff_refs` are computed asynchronously right after a push. A job arriving too early is retried
  with backoff.
- Files whose diff GitLab withholds (too large / collapsed) are listed as omitted and never reviewed.
- There is no management UI or API yet (Phase 7). Connecting is an operator command.
