ALTER TABLE action_confirmations
  DROP CONSTRAINT IF EXISTS action_confirmations_action_type_check;

ALTER TABLE action_confirmations
  ADD CONSTRAINT action_confirmations_action_type_check
  CHECK (action_type IN ('CREATE_EVERYONE_ANNOUNCEMENT', 'CANCEL_TASK'));
