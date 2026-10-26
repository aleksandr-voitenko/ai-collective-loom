-- Observational samples, never an audit or publication/recovery outcome store.
-- Fixed reusable slots bound storage across API processes. No existing data changes.
CREATE TABLE loom.operational_capture (
  id integer PRIMARY KEY CHECK(id=1),
  position bigint NOT NULL DEFAULT 0 CHECK(position BETWEEN 0 AND 999999999999999),
  admitted_at timestamptz
);
INSERT INTO loom.operational_capture(id) VALUES (1);
CREATE TABLE loom.operational_observations (
  slot integer PRIMARY KEY CHECK(slot BETWEEN 0 AND 1023),
  position bigint NOT NULL UNIQUE CHECK(position BETWEEN 1 AND 999999999999999),
  request_id uuid NOT NULL,
  observed_at timestamptz NOT NULL,
  family text NOT NULL CHECK(family IN ('publication','uploads','shared_recovery','personal_recovery','combined_recovery','administration','participation','identity')),
  code text NOT NULL CHECK(code IN (
    'revision_conflict','idempotency_conflict','forbidden','invalid_actor','unauthenticated','invalid_proof',
    'file_storage_unavailable','file_mismatch','file_size_limit','file_unfinished_capacity','file_reserved_capacity','file_capacity',
    'notification_history_gap','notification_epoch_changed','notification_descriptor_expired','visibility_replay_required','notification_work_limit',
    'shared_history_gap','shared_epoch_changed','shared_descriptor_expired','shared_visibility_replay_required','shared_work_limit',
    'updates_shared_history_gap','updates_personal_history_gap','updates_epoch_changed','updates_state_unavailable',
    'updates_descriptor_expired','updates_visibility_replay_required','updates_work_limit','updates_capacity')),
  status integer NOT NULL CHECK(status BETWEEN 400 AND 599)
);
REVOKE ALL ON loom.operational_capture,loom.operational_observations FROM loom_app;
GRANT SELECT, UPDATE ON loom.operational_capture TO loom_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON loom.operational_observations TO loom_app;
