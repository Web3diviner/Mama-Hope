CREATE TABLE IF NOT EXISTS conversation_memory (
  id UUID PRIMARY KEY,
  scope_key TEXT NOT NULL UNIQUE,
  group_id UUID REFERENCES groups(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  turns JSONB NOT NULL DEFAULT '[]'::jsonb,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS conversation_memory_expiry_idx
  ON conversation_memory (expires_at);
