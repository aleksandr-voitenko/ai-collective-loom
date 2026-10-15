-- Parentage remains in resources. NULL area ownership is the implicit root.
ALTER TABLE loom.resources ADD COLUMN organization_version integer NOT NULL DEFAULT 1 CHECK (organization_version > 0);
GRANT UPDATE (organization_version) ON loom.resources TO loom_app;
CREATE TABLE loom.organization_state (
  id smallint PRIMARY KEY CHECK (id = 1),
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0)
);
INSERT INTO loom.organization_state(id) VALUES (1);
REVOKE INSERT, UPDATE, DELETE ON loom.organization_state FROM loom_app;
GRANT UPDATE (version) ON loom.organization_state TO loom_app;
ALTER TABLE loom.areas ADD COLUMN metadata_version integer NOT NULL DEFAULT 1 CHECK (metadata_version > 0);
GRANT UPDATE (title, description, metadata_version) ON loom.areas TO loom_app;
CREATE TABLE loom.area_metadata_revisions (
  id uuid PRIMARY KEY,
  area_id uuid NOT NULL REFERENCES loom.areas(id),
  version integer NOT NULL CHECK (version > 0),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 160),
  description text NOT NULL CHECK (octet_length(description) <= 2048),
  publisher_id uuid REFERENCES loom.participants(id),
  baseline boolean NOT NULL DEFAULT false,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((publisher_id IS NULL) = baseline),
  UNIQUE (area_id, version)
);
-- Existing metadata has no retained attribution: do not invent one on upgrade.
INSERT INTO loom.area_metadata_revisions(id,area_id,version,title,description,baseline)
  SELECT gen_random_uuid(),id,1,title,description,true FROM loom.areas;
REVOKE UPDATE, DELETE ON loom.area_metadata_revisions FROM loom_app;

ALTER TABLE loom.shared_activity ALTER COLUMN revision_id DROP NOT NULL;
ALTER TABLE loom.shared_activity DROP CONSTRAINT shared_activity_kind_check;
ALTER TABLE loom.shared_activity ADD CONSTRAINT shared_activity_kind_check CHECK (
  (kind='revision.published' AND revision_id IS NOT NULL) OR
  (kind='organization.changed' AND revision_id IS NULL));
ALTER TABLE loom.shared_activity ADD CONSTRAINT shared_activity_resource FOREIGN KEY (resource_id) REFERENCES loom.resources(id);
ALTER TABLE loom.shared_activity ADD COLUMN before_area_scope_ids uuid[];
ALTER TABLE loom.shared_activity ADD COLUMN after_area_scope_ids uuid[];
ALTER TABLE loom.shared_activity ADD CONSTRAINT structural_scopes CHECK (
  (kind='revision.published' AND before_area_scope_ids IS NULL AND after_area_scope_ids IS NULL) OR
  (kind='organization.changed' AND before_area_scope_ids IS NOT NULL AND after_area_scope_ids IS NOT NULL));
ALTER TABLE loom.outbox_intents DROP CONSTRAINT outbox_intents_kind_check;
ALTER TABLE loom.outbox_intents ADD CONSTRAINT outbox_intents_kind_check CHECK (kind IN ('publication.project','organization.project'));

CREATE TABLE loom.organization_operations (
  id uuid PRIMARY KEY,
  actor_id uuid NOT NULL REFERENCES loom.participants(id),
  operation_kind text NOT NULL CHECK (operation_kind IN ('area.create','area.edit','area.move','discussion.move','artifact.move','area.open','area.close')),
  idempotency_key uuid NOT NULL,
  semantic_version text NOT NULL CHECK (semantic_version='organization-v1'),
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  resource_id uuid NOT NULL REFERENCES loom.resources(id),
  original_parent_id uuid REFERENCES loom.resources(id),
  result_version integer NOT NULL,
  hierarchy_version integer NOT NULL,
  local_open boolean NOT NULL,
  source_event_id uuid NOT NULL UNIQUE REFERENCES loom.shared_activity(id),
  UNIQUE(actor_id,operation_kind,idempotency_key)
);
CREATE TABLE loom.organization_audit (
  operation_id uuid PRIMARY KEY REFERENCES loom.organization_operations(id),
  actor_credential_id uuid NOT NULL REFERENCES loom.participant_credentials(id),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
REVOKE UPDATE, DELETE ON loom.organization_operations, loom.organization_audit FROM loom_app;

-- An ordinary discussion can carry one stable affected-area reference. This is
-- metadata, not a proposal object, workflow state or execution instruction.
CREATE TABLE loom.discussion_area_references (
  discussion_id uuid PRIMARY KEY REFERENCES loom.discussions(id),
  area_id uuid NOT NULL REFERENCES loom.areas(id)
);
REVOKE UPDATE, DELETE ON loom.discussion_area_references FROM loom_app;
