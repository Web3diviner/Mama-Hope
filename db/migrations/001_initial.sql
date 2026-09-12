CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY,
  whatsapp_jid TEXT UNIQUE NOT NULL,
  phone_e164 TEXT UNIQUE,
  display_name TEXT,
  role TEXT NOT NULL CHECK (role IN ('SUPER_ADMIN', 'OFFICIAL', 'COMMUNITY_MEMBER', 'SYSTEM')),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS officials (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE RESTRICT,
  full_name TEXT NOT NULL,
  job_role TEXT,
  department TEXT,
  capabilities TEXT[] NOT NULL DEFAULT '{}',
  active BOOLEAN NOT NULL DEFAULT TRUE,
  interest_tags TEXT[] NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS groups (
  id UUID PRIMARY KEY,
  whatsapp_jid TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('OFFICIALS', 'COMMUNITY', 'OTHER')),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  timezone TEXT NOT NULL DEFAULT 'Africa/Lagos',
  mention_all_max_participants INTEGER NOT NULL DEFAULT 150 CHECK (mention_all_max_participants >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS group_members (
  group_id UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  is_admin BOOLEAN NOT NULL DEFAULT FALSE,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  last_synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, user_id)
);

CREATE TABLE IF NOT EXISTS tasks (
  id UUID PRIMARY KEY,
  public_id TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  group_id UUID NOT NULL REFERENCES groups(id) ON DELETE RESTRICT,
  created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  required_capability TEXT,
  source_message_id TEXT,
  source_message_text TEXT,
  status TEXT NOT NULL CHECK (status IN ('DRAFT', 'SCHEDULED', 'ACTIVE', 'SUBMITTED', 'COMPLETED', 'OVERDUE', 'CANCELLED')),
  priority TEXT NOT NULL CHECK (priority IN ('LOW', 'NORMAL', 'HIGH', 'URGENT')),
  completion_policy TEXT NOT NULL CHECK (completion_policy IN ('ALL_ASSIGNEES_SUBMIT', 'ADMIN_CONFIRMATION')),
  publish_at TIMESTAMPTZ,
  published_at TIMESTAMPTZ,
  published_message_id TEXT UNIQUE,
  deadline_at TIMESTAMPTZ,
  reminder_offsets_minutes INTEGER[] NOT NULL DEFAULT ARRAY[1440, 360, 60, 0],
  completion_notes TEXT,
  completed_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  cancellation_reason TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (publish_at IS NULL OR deadline_at IS NULL OR deadline_at > publish_at)
);

CREATE TABLE IF NOT EXISTS task_assignees (
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'ACKNOWLEDGED', 'IN_PROGRESS', 'BLOCKED', 'SUBMITTED', 'COMPLETED', 'OVERDUE')),
  acknowledged_at TIMESTAMPTZ,
  submitted_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  overdue_at TIMESTAMPTZ,
  blocked_reason TEXT,
  latest_submission_id UUID,
  PRIMARY KEY (task_id, user_id)
);

CREATE TABLE IF NOT EXISTS task_updates (
  id UUID PRIMARY KEY,
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  update_type TEXT NOT NULL,
  body TEXT,
  source_message_id TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS attachments (
  id UUID PRIMARY KEY,
  storage_key TEXT UNIQUE,
  source_url TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('IMAGE', 'VIDEO', 'AUDIO', 'DOCUMENT', 'LINK')),
  mime_type TEXT,
  file_name TEXT,
  size_bytes BIGINT,
  sha256 TEXT,
  uploaded_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (storage_key IS NOT NULL OR source_url IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS task_submissions (
  id UUID PRIMARY KEY,
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  submitter_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  note TEXT,
  source_message_id TEXT UNIQUE,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS task_submission_attachments (
  submission_id UUID NOT NULL REFERENCES task_submissions(id) ON DELETE CASCADE,
  attachment_id UUID NOT NULL REFERENCES attachments(id) ON DELETE RESTRICT,
  PRIMARY KEY (submission_id, attachment_id)
);

ALTER TABLE task_assignees
  DROP CONSTRAINT IF EXISTS task_assignees_latest_submission_fk;
ALTER TABLE task_assignees
  ADD CONSTRAINT task_assignees_latest_submission_fk
  FOREIGN KEY (latest_submission_id) REFERENCES task_submissions(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS announcements (
  id UUID PRIMARY KEY,
  public_id TEXT UNIQUE NOT NULL,
  group_id UUID NOT NULL REFERENCES groups(id) ON DELETE RESTRICT,
  created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  source_message_id TEXT,
  category TEXT,
  title TEXT,
  body TEXT NOT NULL,
  mention_strategy TEXT NOT NULL CHECK (mention_strategy IN ('NONE', 'RELEVANT_MEMBERS', 'OFFICIALS_ONLY', 'EVERYONE')),
  interest_tags TEXT[] NOT NULL DEFAULT '{}',
  status TEXT NOT NULL CHECK (status IN ('DRAFT', 'SCHEDULED', 'PUBLISHED', 'FAILED', 'CANCELLED')),
  publish_at TIMESTAMPTZ,
  published_at TIMESTAMPTZ,
  published_message_id TEXT UNIQUE,
  expires_at TIMESTAMPTZ,
  failure_reason TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS announcement_attachments (
  announcement_id UUID NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
  attachment_id UUID NOT NULL REFERENCES attachments(id) ON DELETE RESTRICT,
  PRIMARY KEY (announcement_id, attachment_id)
);

CREATE TABLE IF NOT EXISTS opportunities (
  id UUID PRIMARY KEY,
  announcement_id UUID UNIQUE REFERENCES announcements(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  category TEXT NOT NULL,
  summary TEXT NOT NULL,
  eligibility TEXT,
  application_url TEXT,
  deadline_at TIMESTAMPTZ,
  source_name TEXT,
  source_url TEXT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS scheduled_jobs (
  id UUID PRIMARY KEY,
  job_key TEXT UNIQUE NOT NULL,
  job_type TEXT NOT NULL CHECK (job_type IN ('TASK_PUBLISH', 'TASK_REMINDER', 'TASK_DEADLINE', 'TASK_RECURRENCE', 'ANNOUNCEMENT_PUBLISH', 'DAILY_PLANNING')),
  entity_type TEXT NOT NULL CHECK (entity_type IN ('TASK', 'ANNOUNCEMENT')),
  entity_id UUID NOT NULL,
  run_at TIMESTAMPTZ NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'PROCESSING', 'SUCCEEDED', 'FAILED', 'CANCELLED')),
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  completed_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS processed_messages (
  whatsapp_message_id TEXT PRIMARY KEY,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id UUID PRIMARY KEY,
  correlation_id UUID NOT NULL,
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  source_message_id TEXT,
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id UUID,
  original_input TEXT,
  interpreted_payload JSONB,
  executed_payload JSONB,
  outcome TEXT NOT NULL CHECK (outcome IN ('SUCCEEDED', 'REJECTED', 'FAILED', 'PENDING_CONFIRMATION')),
  error_code TEXT,
  error_detail TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS tasks_due_idx ON tasks (deadline_at) WHERE status IN ('SCHEDULED', 'ACTIVE', 'OVERDUE');
CREATE INDEX IF NOT EXISTS task_assignees_user_status_idx ON task_assignees (user_id, status);
CREATE INDEX IF NOT EXISTS announcements_schedule_idx ON announcements (publish_at) WHERE status = 'SCHEDULED';
CREATE INDEX IF NOT EXISTS opportunities_active_deadline_idx ON opportunities (active, deadline_at);
CREATE INDEX IF NOT EXISTS scheduled_jobs_due_idx ON scheduled_jobs (run_at) WHERE status = 'PENDING';
CREATE INDEX IF NOT EXISTS audit_logs_entity_idx ON audit_logs (entity_type, entity_id, created_at DESC);
