CREATE TABLE IF NOT EXISTS task_attachments (
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  attachment_id UUID NOT NULL REFERENCES attachments(id) ON DELETE RESTRICT,
  PRIMARY KEY (task_id, attachment_id)
);