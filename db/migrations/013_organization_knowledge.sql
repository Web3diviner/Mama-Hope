CREATE TABLE IF NOT EXISTS organization_knowledge (
  id UUID PRIMARY KEY,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  tags TEXT[] NOT NULL DEFAULT '{}',
  active BOOLEAN NOT NULL DEFAULT TRUE,
  search_document TSVECTOR GENERATED ALWAYS AS (
    to_tsvector('english'::regconfig, coalesce(title, '') || ' ' || coalesce(content, ''))
  ) STORED,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS organization_knowledge_search_idx
  ON organization_knowledge USING GIN (search_document);
