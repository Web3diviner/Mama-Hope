CREATE TABLE IF NOT EXISTS calendar_events (
  id UUID PRIMARY KEY,
  external_id TEXT,
  title TEXT NOT NULL,
  description TEXT,
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ,
  timezone TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('INTERNAL', 'GOOGLE_CALENDAR', 'OBSERVANCE', 'MANUAL')),
  relevance_score INTEGER NOT NULL CHECK (relevance_score BETWEEN 0 AND 100),
  preparation_stage TEXT NOT NULL CHECK (preparation_stage IN ('AWARENESS', 'EVALUATION', 'PLANNING', 'EXECUTION', 'REVIEW', 'PUBLISH', 'EVENT_DAY')),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE (source, external_id)
);

CREATE TABLE IF NOT EXISTS planning_runs (
  id UUID PRIMARY KEY,
  run_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('SUCCEEDED', 'FAILED')),
  summary TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);