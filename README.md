# Mama Hope

Mama Hope is DeExclusives Music Organization’s WhatsApp-first AI operations assistant for a Super Admin, officials, and community members. It turns approved natural-language instructions into database-backed tasks, reminders, announcements, reports, and auditable WhatsApp actions.

The full product blueprint is in [MAMA_HOPE_DEVELOPER_PRD.md](./MAMA_HOPE_DEVELOPER_PRD.md).

## What is implemented

- Fastify/TypeScript service with strict request validation and structured errors.
- PostgreSQL migrations and a durable repository for users, groups, tasks, task assignments, submissions, attachments, announcements, opportunities, jobs, and audit logs.
- Durable PostgreSQL job ledger scheduling. The bot process polls and atomically claims due ledger entries, so scheduled work survives restarts without a separate queue service.
- Core task lifecycle: create, schedule, publish, mention officials, remind, accept submission, track blockers, mark overdue, complete, cancel, and report.
- Community announcements, configurable mention strategies, active opportunity records, and media attachments.
- A Groq natural-language provider with strict structured extraction, a stable primary personality model, model failover, and a safe rule-based fallback.
- Layered conversation memory for Super Admin instructions, member conversations, and recent group context; recent turns are capped and stored durably when PostgreSQL is enabled.
- Natural WhatsApp operations for task edits/cancellation, progress and blocker updates, recurring routines, official registration, organization knowledge, and approved community check-ins.
- Live group-member synchronization, real WhatsApp mentions, interest-based announcements, opportunity search, and daily/weekly action-oriented reporting.
- `AIProvider`, `WhatsAppGateway`, `MediaStore`, and `OperationsStore` interfaces so providers can be changed without rewriting domain logic.
- A memory WhatsApp gateway for local development/tests and a Baileys gateway for a dedicated production bot number.
- Local filesystem and S3-compatible (including Cloudflare R2) media storage adapters.
- Inbound permission checks based on canonical WhatsApp JID—not names—and immutable audit records for sensitive operations.

## Project layout

```text
src/
  modules/              # task, announcement, reports, automation, inbound routing
  infrastructure/
    whatsapp/           # Memory + Baileys gateway adapters
    store/              # memory + PostgreSQL stores
    scheduler/          # PostgreSQL-ledger scheduler
    media/              # local filesystem + S3-compatible storage
    database/           # migration and seed commands
  http/                 # protected internal/admin HTTP API
db/migrations/          # PostgreSQL migrations
test/                   # end-to-end local MVP tests
```

## Local quick start

Requirements: Node.js 22+, npm, and optionally Docker Desktop for PostgreSQL.

```powershell
Copy-Item .env.example .env
npm.cmd install
npm.cmd run dev
```

The default `.env.example` runs safely with the in-memory WhatsApp simulator and seeds these local records:

| Record | Value |
| --- | --- |
| Officials group ID | `00000000-0000-4000-8000-000000000011` |
| Community group ID | `00000000-0000-4000-8000-000000000012` |
| David | `00000000-0000-4000-8000-000000000002` |
| Deborah | `00000000-0000-4000-8000-000000000003` |
| Precious | `00000000-0000-4000-8000-000000000004` |

Set a real long `INTERNAL_API_TOKEN`, your own `SUPER_ADMIN_WHATSAPP_JID`, and a separate `BOT_WHATSAPP_JID` before using anything beyond the local simulator.

The service runs at `http://localhost:3000`.

The memory store is only for local testing and is intentionally rejected when `NODE_ENV=production`. Production requires PostgreSQL so task records and scheduled work survive restarts. The readiness endpoint reports whether storage and scheduling are durable.

## Groq AI

Create a Groq API key in the Groq Console, then configure `.env` without sharing the key in WhatsApp or committing it to source control:

```dotenv
AI_PROVIDER=groq
AI_API_KEY=gsk_your_private_key
AI_MODELS=openai/gpt-oss-20b,qwen/qwen3.8-27b,openai/gpt-oss-120b
AI_REQUEST_TIMEOUT_MS=15000
```

Mama Hope uses the first configured model as her stable personality anchor and tries later models only when it is unavailable or rate-limited. Only compatible chat models should be listed; audio transcription, text-to-speech, prompt-guard, and safeguard models are not command interpreters. If every Groq model fails, administrative parsing falls back to the local deterministic parser and conversational replies use a safe fixed response.

Task details can be supplied conversationally. Mama Hope retains recent corrections and follow-up details without requiring the whole instruction to be repeated. Context is isolated by Super Admin and chat, retains at most ten recent turns, and expires after 30 minutes. Send `start over` to clear the current thread.

Mama Hope now minimizes clarification for task delegation. From the work description she creates a concise task title, infers LOW/NORMAL/HIGH/URGENT priority, and applies a policy deadline when none is stated (urgent: 4 hours, high: 24 hours, normal: 48 hours, low: 72 hours). She asks only when the assignee or requested action is genuinely unclear. Administrative execution remains restricted to the authenticated Super Admin.

Recurring wording creates a durable task series. Examples include `every day at 9 AM`, `every Monday at 10 AM`, `weekdays`, and `monthly`. Each occurrence creates a fresh tracked task with reminders, submissions, overdue handling, and the same real-number mentions. Add `once`, `one-time`, `only this time`, or `do not repeat` to suppress recurrence.

Useful WhatsApp examples:

```text
Add Janet +234 811 222 3333 as Social Media Manager
Assign Philip to prepare the release notes by Friday at 5 PM
Every Monday at 9 AM assign Deborah to publish the weekly design update by 4 PM
Change the release notes deadline to tomorrow at noon
Cancel the release notes task
Remember that our rehearsal venue is ...
Give me today's report
Approve check-ins
```

Officials can reply to an assignment with `started`, `blocked because ...`, or `done` (with an attachment where required). If an unthreaded update could refer to more than one task, Mama Hope presents a numbered choice instead of changing the wrong record.

Creative requests such as `Write a lively Instagram caption for our launch` use a dedicated generation mode. Mama Hope can freely draft and rewrite wording, hooks, structure, and tone, but creative generation does not automatically publish the content or create a database action. Use a separate explicit scheduling instruction when the approved draft is ready to post.

## Exercise the API locally

All administrative HTTP endpoints require `x-internal-api-token`. WhatsApp remains the main user interface; the API is intended for controlled integration, diagnostics, and a future dashboard.

```powershell
$headers = @{ 'x-internal-api-token' = 'replace-with-your-token' }

Invoke-RestMethod http://localhost:3000/v1/admin/groups -Headers $headers

$body = @{
  title = 'Mission 150 Launch Content'
  description = 'Prepare teaser flyer, caption and launch thread.'
  groupId = '00000000-0000-4000-8000-000000000011'
  assigneeIds = @(
    '00000000-0000-4000-8000-000000000002',
    '00000000-0000-4000-8000-000000000003'
  )
  publishAt = '2026-09-02T07:00:00.000Z'
  deadlineAt = '2026-09-04T16:00:00.000Z'
} | ConvertTo-Json

Invoke-RestMethod http://localhost:3000/v1/admin/tasks -Method Post -Headers $headers -ContentType 'application/json' -Body $body
```

For a controlled inbound simulation, post a normalised WhatsApp message to `POST /v1/internal/whatsapp/inbound` with the same token. This route is not for public exposure.

## PostgreSQL

Start local dependencies:

```powershell
docker compose up -d postgres
```

Update `.env`:

```dotenv
STORE_DRIVER=postgres
DATABASE_URL=postgresql://mama_hope:local-dev-password@localhost:5432/mama_hope
```

Then run:

```powershell
npm.cmd run db:migrate
npm.cmd run db:seed
npm.cmd run dev
```

`db:seed` creates the safe local demo users/groups once. Replace them with the real organisation’s verified records before launch.

## Connecting the dedicated WhatsApp number

Do not connect a personal Super Admin account. Use a dedicated organisation SIM/number and protect the session directory.

In `.env`:

```dotenv
WHATSAPP_GATEWAY=baileys
WHATSAPP_SESSION_DIR=./data/whatsapp-session
# Optional one-time pairing-code destination; country code + number, digits only.
WHATSAPP_PAIRING_PHONE=234XXXXXXXXXX
```

Start one bot process only:

```powershell
npm.cmd run dev
```

Mama Hope owns the Baileys connection, message intake, job recovery, and scheduled sends in that single process. Do not run a second live Baileys process against the same session directory.

The Baileys package is pinned to the version recorded in `package-lock.json`. Test any version update in a staging group before production. Keep messaging low-volume, consent-based, and rate-limited.

## Media storage

Local development defaults to `MEDIA_DRIVER=local`. For a durable deployment, use S3-compatible storage:

```dotenv
MEDIA_DRIVER=s3
S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
S3_REGION=auto
S3_BUCKET=mama-hope-media
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...
```

Inbound files are stored before they are linked to a task submission. Scheduled announcement media is read from managed storage before send; Mama Hope deliberately fails the job rather than post a text-only announcement when an expected file is unavailable.

## Production deployment

The checked-in Compose setup is production-oriented: PostgreSQL is private to the Docker network and stores operational records plus the durable job ledger; the API is non-root with a read-only filesystem, and the API port is bound to loopback by default. The Dockerfile is at the repository root, which also matches Render's default Dockerfile location. Run exactly one API/bot replica; a second Baileys process must never share the WhatsApp session.

1. Copy `.env.production.example` to `.env.production` and replace every placeholder. Use a URL-encoded value in `DATABASE_URL` when its password contains URL-reserved characters.
2. Keep `WHATSAPP_SEND_ENABLED=false` while pairing and validating in a staging group. Configure a dedicated bot number, S3/R2 media storage, and a token of at least 32 random characters.
3. Start the stack with the production environment file:

```powershell
docker compose --env-file .env.production up -d --build
```

4. Watch startup and check liveness locally:

```powershell
docker compose --env-file .env.production logs -f api
Invoke-RestMethod http://127.0.0.1:3000/health/live
```

Migrations run before the bot starts. Provision the real Super Admin and group records before enabling outbound messaging; do not run the demo seed in production.

Put a TLS reverse proxy with an identity layer in front of the API if it must be reached off-host. Do not expose PostgreSQL, `/v1/internal/whatsapp/inbound`, or the admin API directly to the internet. Back up PostgreSQL and the encrypted WhatsApp session volume, test restoration, and rotate database, S3, AI, calendar, and internal API credentials on a defined schedule.

## Verification

```powershell
npm.cmd run build
npm.cmd test
```

The integration suite verifies:

- natural Super Admin task creation;
- real mention resolution for David, Deborah, and Precious;
- scheduled publication, submission attachment capture, and overdue handling;
- a rejected community-member admin/prompt-injection attempt; and
- protected admin API access.

## Security notes

- Privileges are checked by WhatsApp JID and role, never by profile/display name.
- The LLM/rule provider supplies a draft only. It never performs SQL, sends a broadcast, or bypasses deterministic permission checks.
- Sensitive operations write an audit record with actor, source message, executed action, and outcome.
- Future dashboard calls are protected by a separate internal token; do not expose those routes directly to the internet without an identity layer.
- `EVERYONE` announcements are constrained by group thresholds and should require an explicit Super Admin confirmation in the operating interface.
