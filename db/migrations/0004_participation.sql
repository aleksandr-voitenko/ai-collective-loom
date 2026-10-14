-- Additive text participation. Existing internal envelopes/revisions stay valid.
ALTER TABLE loom.revisions DROP CONSTRAINT revisions_content_format_check;
ALTER TABLE loom.revisions ADD CONSTRAINT revisions_content_format_check
  CHECK (content_format IN ('text/plain', 'loom-markdown-v1'));
ALTER TABLE loom.revisions ADD COLUMN title text CHECK (char_length(title) BETWEEN 1 AND 160);
ALTER TABLE loom.resources ADD COLUMN editors_version integer NOT NULL DEFAULT 0;
GRANT UPDATE (editors_version) ON loom.resources TO loom_app;
CREATE TABLE loom.areas (
  id uuid PRIMARY KEY REFERENCES loom.resources(id),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 160),
  description text NOT NULL CHECK (octet_length(description) <= 2048)
);
CREATE TABLE loom.discussions (
  id uuid PRIMARY KEY REFERENCES loom.resources(id),
  opening_id uuid NOT NULL UNIQUE
);
CREATE TABLE loom.contributions (
  id uuid PRIMARY KEY REFERENCES loom.resources(id),
  discussion_id uuid NOT NULL REFERENCES loom.discussions(id),
  parent_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (discussion_id, id),
  CHECK (parent_id IS DISTINCT FROM id),
  FOREIGN KEY (discussion_id, parent_id) REFERENCES loom.contributions(discussion_id, id)
);
ALTER TABLE loom.discussions ADD CONSTRAINT discussion_opening
  FOREIGN KEY (id, opening_id) REFERENCES loom.contributions(discussion_id, id) DEFERRABLE INITIALLY DEFERRED;
CREATE UNIQUE INDEX one_opening ON loom.contributions(discussion_id) WHERE parent_id IS NULL;
CREATE INDEX contribution_children ON loom.contributions(parent_id, created_at, id);
CREATE TABLE loom.artifacts (id uuid PRIMARY KEY REFERENCES loom.resources(id));
CREATE TABLE loom.revision_mentions (
  revision_id uuid NOT NULL REFERENCES loom.revisions(id),
  token text NOT NULL CHECK (token ~ '^[a-z][a-z0-9_]{0,31}$'),
  participant_id uuid NOT NULL REFERENCES loom.participants(id),
  PRIMARY KEY (revision_id, token)
);
CREATE TABLE loom.community_settings (
  id smallint PRIMARY KEY CHECK (id = 1),
  instance_id uuid NOT NULL DEFAULT gen_random_uuid(),
  version integer NOT NULL DEFAULT 0,
  community_name text NOT NULL DEFAULT 'Collective Loom',
  overview_id uuid REFERENCES loom.artifacts(id),
  proposal_area_id uuid REFERENCES loom.areas(id)
);
INSERT INTO loom.community_settings(id) VALUES (1);
CREATE TABLE loom.participation_audit (
  id uuid PRIMARY KEY,
  actor_id uuid NOT NULL REFERENCES loom.participants(id),
  actor_credential_id uuid NOT NULL REFERENCES loom.participant_credentials(id),
  operation_kind text NOT NULL,
  target_id uuid NOT NULL,
  idempotency_key uuid NOT NULL,
  request_digest text NOT NULL,
  result_version integer NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (actor_id, operation_kind, idempotency_key)
);
REVOKE UPDATE, DELETE ON loom.areas, loom.discussions, loom.contributions,
  loom.artifacts, loom.revision_mentions, loom.participation_audit FROM loom_app;
REVOKE INSERT, UPDATE, DELETE ON loom.community_settings FROM loom_app;
GRANT UPDATE (version, community_name, overview_id, proposal_area_id) ON loom.community_settings TO loom_app;
