-- Local lifecycle fencing is independent of publication/editor/organization state.
ALTER TABLE loom.resources ADD COLUMN lifecycle_version integer NOT NULL DEFAULT 1
  CHECK (lifecycle_version > 0);
GRANT UPDATE(lifecycle_version) ON loom.resources TO loom_app;
CREATE INDEX moderation_suppressed_resources ON loom.resources(id) WHERE state='suppressed';

CREATE TABLE loom.moderation_state (
  id integer PRIMARY KEY CHECK(id=1),
  version bigint NOT NULL DEFAULT 0,
  decisions integer NOT NULL DEFAULT 0 CHECK(decisions BETWEEN 0 AND 10000)
);
INSERT INTO loom.moderation_state(id) VALUES(1);
REVOKE ALL ON loom.moderation_state FROM loom_app;
GRANT SELECT, UPDATE(version,decisions) ON loom.moderation_state TO loom_app;

CREATE TABLE loom.moderation_operations (
  id uuid PRIMARY KEY,
  actor_id uuid NOT NULL REFERENCES loom.participants(id),
  idempotency_key uuid NOT NULL,
  semantic_version text NOT NULL CHECK(semantic_version='moderation-state-1'),
  request_digest text NOT NULL CHECK(length(request_digest)=64),
  resource_id uuid NOT NULL REFERENCES loom.resources(id),
  target_kind text NOT NULL CHECK(target_kind IN ('discussion','comment','summary','artifact')),
  suppressed boolean NOT NULL,
  result_version integer NOT NULL CHECK(result_version>1),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(actor_id,idempotency_key)
);
CREATE INDEX moderation_target_operations ON loom.moderation_operations(resource_id,id);
REVOKE ALL ON loom.moderation_operations FROM loom_app;
GRANT SELECT, INSERT ON loom.moderation_operations TO loom_app;

CREATE TABLE loom.moderation_audit (
  operation_id uuid PRIMARY KEY REFERENCES loom.moderation_operations(id),
  actor_credential_id uuid NOT NULL REFERENCES loom.participant_credentials(id)
);
REVOKE ALL ON loom.moderation_audit FROM loom_app;
GRANT SELECT, INSERT ON loom.moderation_audit TO loom_app;
