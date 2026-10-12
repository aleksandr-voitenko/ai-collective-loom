-- Minimal publication/authority envelopes. No participants or credentials are seeded.
-- Domain constructors, authentication, administrative lifecycle operations and
-- worker consumption remain separate operations; this is not a generic CRUD API.
CREATE TABLE loom.participants (
  id uuid PRIMARY KEY,
  state text NOT NULL CHECK (state IN ('active', 'suspended', 'revoked')),
  role text NOT NULL DEFAULT 'participant' CHECK (role IN ('participant', 'administrator'))
);
CREATE TABLE loom.participant_credentials (
  id uuid PRIMARY KEY,
  participant_id uuid NOT NULL REFERENCES loom.participants(id),
  state text NOT NULL CHECK (state IN ('active', 'revoked'))
);
CREATE TABLE loom.resources (
  id uuid PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('area', 'discussion', 'contribution', 'summary', 'artifact')),
  owner_resource_id uuid REFERENCES loom.resources(id),
  original_author_id uuid REFERENCES loom.participants(id),
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'suppressed', 'removed')),
  publication_open boolean NOT NULL DEFAULT true,
  current_revision_id uuid,
  CHECK (owner_resource_id IS DISTINCT FROM id),
  CHECK (kind = 'area' OR owner_resource_id IS NOT NULL),
  CHECK (kind IN ('area', 'discussion') OR original_author_id IS NOT NULL)
);
CREATE INDEX resources_owner ON loom.resources(owner_resource_id);
CREATE TABLE loom.resource_editors (
  resource_id uuid NOT NULL REFERENCES loom.resources(id),
  participant_id uuid NOT NULL REFERENCES loom.participants(id),
  PRIMARY KEY (resource_id, participant_id)
);
CREATE TABLE loom.revisions (
  id uuid PRIMARY KEY,
  resource_id uuid NOT NULL REFERENCES loom.resources(id),
  revision_number bigint NOT NULL CHECK (revision_number > 0),
  publisher_id uuid NOT NULL REFERENCES loom.participants(id),
  content_format text NOT NULL CHECK (content_format = 'text/plain'),
  content_text text NOT NULL CHECK (length(content_text) > 0),
  availability text NOT NULL DEFAULT 'available' CHECK (availability IN ('available', 'suppressed', 'removed')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (resource_id, revision_number),
  UNIQUE (resource_id, id)
);
ALTER TABLE loom.resources ADD CONSTRAINT resource_current_revision
  FOREIGN KEY (id, current_revision_id) REFERENCES loom.revisions(resource_id, id);

-- A transactional row, never a sequence/MAX(event_id), is the committed upper bound.
CREATE TABLE loom.community_clocks (
  id smallint PRIMARY KEY CHECK (id = 1),
  shared_position bigint NOT NULL CHECK (shared_position >= 0)
);
INSERT INTO loom.community_clocks VALUES (1, 0);
CREATE TABLE loom.shared_activity (
  id uuid PRIMARY KEY,
  position bigint NOT NULL UNIQUE CHECK (position > 0),
  kind text NOT NULL CHECK (kind = 'revision.published'),
  resource_id uuid NOT NULL,
  revision_id uuid NOT NULL,
  publisher_id uuid NOT NULL REFERENCES loom.participants(id),
  area_scope_ids uuid[] NOT NULL CHECK (cardinality(area_scope_ids) > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (resource_id, revision_id) REFERENCES loom.revisions(resource_id, id),
  UNIQUE (resource_id, revision_id),
  UNIQUE (resource_id, revision_id, id)
);
CREATE TABLE loom.outbox_intents (
  id uuid PRIMARY KEY,
  source_event_id uuid NOT NULL REFERENCES loom.shared_activity(id),
  kind text NOT NULL CHECK (kind = 'publication.project'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (source_event_id, kind)
);
CREATE TABLE loom.idempotency_records (
  id uuid PRIMARY KEY,
  participant_id uuid NOT NULL REFERENCES loom.participants(id),
  operation_kind text NOT NULL,
  idempotency_key uuid NOT NULL,
  semantic_version text NOT NULL,
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  resource_id uuid NOT NULL,
  revision_id uuid NOT NULL,
  source_event_id uuid NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (participant_id, operation_kind, idempotency_key),
  FOREIGN KEY (resource_id, revision_id, source_event_id)
    REFERENCES loom.shared_activity(resource_id, revision_id, id)
);

-- Keep authored bytes/identities and recovery records immutable for ordinary SQL.
-- Lifecycle flags have separate column grants; their writers must use the guards
-- documented in ADR-006. Explicit erasure/retention needs a later reviewed procedure.
REVOKE UPDATE, DELETE ON loom.revisions, loom.resources FROM loom_app;
GRANT UPDATE (availability) ON loom.revisions TO loom_app;
GRANT UPDATE (owner_resource_id, state, publication_open, current_revision_id) ON loom.resources TO loom_app;
REVOKE UPDATE, DELETE ON loom.shared_activity, loom.outbox_intents, loom.idempotency_records FROM loom_app;
REVOKE INSERT, UPDATE, DELETE ON loom.community_clocks FROM loom_app;
GRANT UPDATE (shared_position) ON loom.community_clocks TO loom_app;
