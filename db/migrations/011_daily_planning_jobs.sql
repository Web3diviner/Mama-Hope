ALTER TABLE scheduled_jobs
  DROP CONSTRAINT IF EXISTS scheduled_jobs_entity_type_check;

ALTER TABLE scheduled_jobs
  ADD CONSTRAINT scheduled_jobs_entity_type_check
  CHECK (entity_type IN ('TASK', 'ANNOUNCEMENT', 'SYSTEM'));

ALTER TABLE scheduled_jobs
  DROP CONSTRAINT IF EXISTS scheduled_jobs_job_type_check;

ALTER TABLE scheduled_jobs
  ADD CONSTRAINT scheduled_jobs_job_type_check
  CHECK (job_type IN ('TASK_PUBLISH', 'TASK_REMINDER', 'TASK_DEADLINE', 'TASK_RECURRENCE', 'ANNOUNCEMENT_PUBLISH', 'DAILY_PLANNING'));