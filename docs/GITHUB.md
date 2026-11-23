# GitHub Integration (GitHub App)

> Implemented in Phase 5. Verified end to end against a fake GitHub REST + GraphQL server
> (`tools/testing/fake-github.ts`). **Not yet run against real GitHub.**

## How it works

```text
PR opened / reopened / new commits / ready for review
        │  POST /api/webhooks/github   (X-Hub-Signature-256 = HMAC-SHA256 of the raw body)
        ▼
apps/api ── verify signature · route by (installation, repository) · event filter · dedupe delivery ──► BullMQ "reviews"
                                                                                                          │
apps/worker ◄─────────────────────────────────────────────────────────────────────────────────────────────┘
  App JWT → installation token scoped to this one repository (contents:read, pull_requests:write)
  → PR + files at head SHA → ai-review.yaml at head → review pipeline (Claude / GPT / Ollama)
  → re-check PR head (never publish stale results)
  → review comments on diff lines · one summary issue comment (updated in place) · resolve fixed threads (GraphQL)
  → PostgreSQL: session, executions, findings lifecycle, comments, audit log
```

- **One webhook URL for the whole App.** Deliveries are routed by the signed payload's installation id and
  repository id. Only installations an operator connected to an organization are used. Every other delivery
  is ignored.
- **Triggers:** `pull_request` with action `opened`, `reopened`, `synchronize` (new commits) or
  `ready_for_review`, while the PR is open. Edits, labels, closes and merges are ignored.
- **Repository access follows the installation.**
  - `installation_repositories` events add or deactivate repositories.
  - Uninstalling the App deactivates all of its repositories and soft-deletes the connection. Suspending it
    deactivates the repositories only.
  - The first PR from a new repository of a connected installation registers that repository.
- **Nothing secret is stored per connection.** Installation tokens are minted per job, last one hour, are
  cached in worker memory only and are **scoped to the single repository being reviewed**.
- **Same review semantics as GitLab:**
  - one review per head SHA;
  - superseded commits are skipped;
  - fingerprint markers are trusted only on comments written by the App's bot account;
  - fixed findings resolve their review thread.
- **The App never approves, merges or changes code.** It does not request permissions to do so (see below).

## 1. Create the GitHub App

Go to GitHub → Settings → Developer settings → GitHub Apps → **New GitHub App**. For an organization app, use the
organization's settings.

| Field                     | Value                                                                                            |
| ------------------------- | ------------------------------------------------------------------------------------------------ |
| Webhook URL               | `https://<public URL of apps/api>/api/webhooks/github`                                           |
| Webhook secret            | random, at least 20 characters (`openssl rand -hex 32`); becomes `GITHUB_WEBHOOK_SECRET`         |
| Repository permissions    | **Contents: Read and write**, **Pull requests: Read and write**, Metadata: Read-only (mandatory) |
| Subscribe to events       | **Pull request** (installation events are always sent)                                           |
| Where can it be installed | "Only on this account" unless you serve several GitHub organizations                             |

Do **not** grant Administration, Checks, Actions or Workflows. Tokens are narrowed further per job:

- **Review jobs** request only `contents:read`, `metadata:read` and `pull_requests:write`.
- **Approved fix executions** (Phase 6, see [APPROVAL_WORKFLOW.md](./APPROVAL_WORKFLOW.md)) request
  `contents:write`, so they can create the `ai-review/fix-*` branch and commit.

Every token is scoped to the single repository. GitHub refuses to issue more than the App was granted. If you
never want fixes pushed, keep Contents read-only: executions will then fail with 403, and nothing else changes.

After creating the App:

1. Note the **App ID**.
2. Generate a **private key** (`.pem`) and store it outside the repository with permissions `600`.
   `*.pem` is in `.gitignore`.
3. **Install** the App on the repositories to review. The installation id is the number at the end of the
   installation settings URL: `…/settings/installations/<id>`.

## 2. Configure the server

```dotenv
# worker + admin CLI
GITHUB_APP_ID=123456
GITHUB_APP_PRIVATE_KEY_PATH=/run/secrets/github-app.pem   # or GITHUB_APP_PRIVATE_KEY with \n escapes
# api
GITHUB_WEBHOOK_SECRET=<the webhook secret>
# GitHub Enterprise Server only:
# GITHUB_API_URL=https://ghe.example.com/api/v3
# GITHUB_ALLOWED_HOSTS=ghe.example.com
```

- The API needs only the webhook secret. The private key is read only by the worker and the admin command.
- When `GITHUB_WEBHOOK_SECRET` is unset, `POST /api/webhooks/github` answers `404`.

For local development, expose the API with a tunnel (`ngrok http 3000` or
`cloudflared tunnel --url http://127.0.0.1:3000`). Then set the App's webhook URL to the tunnel URL.

## 3. Connect the installation

```powershell
pnpm nx build api
node dist/apps/api/admin.js connect-github --org acme --org-name "Acme" --installation 12345678
```

The command:

1. Authenticates as the App (RS256 JWT) and verifies the installation.
2. Stores the connection: installation id and account login, with no secret.
3. Registers every repository the installation can access and deactivates the ones it no longer can.

Re-running it is safe. It also restores a connection after the App was uninstalled and reinstalled
with the same installation id. An installation can belong to **one** organization only; claiming it from
another organization is refused.

## 4. Run

```powershell
pnpm infra:up; pnpm db:migrate
pnpm dev:api        # webhook intake
pnpm dev:worker     # reviews (AI provider settings: see CLI.md)
```

Open or push to a pull request. The PR receives review comments on changed lines plus one summary comment.
Repository behaviour is controlled by `ai-review.yaml` at the PR's head commit.

## Limitations

- Files whose patch GitHub omits are listed as omitted and never reviewed. GitHub omits the patch for very large
  diffs and for binary files.
- The PR files API returns at most 3,000 files.
- Inline comments use `line`/`side: RIGHT` on the head commit. Findings on lines outside the diff go to the
  summary.
- Manually resolving a thread does not yet dismiss the finding. That is planned for Phase 7, as with GitLab.
- There is no management UI or API yet (Phase 7). Connecting is an operator command.
