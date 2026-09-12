CREATE TABLE IF NOT EXISTS action_confirmations (
  id UUID PRIMARY KEY,
  public_id TEXT UNIQUE NOT NULL,
  requested_by UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action_type TEXT NOT NULL CHECK (action_type IN ('CREATE_EVERYONE_ANNOUNCEMENT', 'CANCEL_TASK')),
  draft JSONB NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'CONFIRMED', 'CANCELLED', 'EXPIRED')),
  expires_at TIMESTAMPTZ NOT NULL,
  confirmed_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS action_confirmations_requested_idx
  ON action_confirmations (requested_by, status, expires_at DESC);
