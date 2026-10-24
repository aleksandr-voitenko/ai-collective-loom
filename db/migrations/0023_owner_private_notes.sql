-- These identities never join shared resource, revision, event or reference tables.
CREATE TABLE loom.note_owners (
  participant_id uuid PRIMARY KEY REFERENCES loom.participants(id),
  version integer NOT NULL DEFAULT 0 CHECK(version>=0),
  identities integer NOT NULL DEFAULT 0 CHECK(identities BETWEEN 0 AND 500),
  active integer NOT NULL DEFAULT 0 CHECK(active BETWEEN 0 AND 128),
  decisions integer NOT NULL DEFAULT 0 CHECK(decisions BETWEEN 0 AND 10000)
);
REVOKE ALL ON loom.note_owners FROM loom_app;
GRANT SELECT, INSERT, UPDATE(version,identities,active,decisions) ON loom.note_owners TO loom_app;
CREATE TABLE loom.private_notes (
  participant_id uuid NOT NULL REFERENCES loom.participants(id),
  id uuid NOT NULL,
  version integer NOT NULL CHECK(version>0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  deleted_at timestamptz,
  title text CHECK(octet_length(title)<=256),
  body text CHECK(octet_length(body) BETWEEN 1 AND 16384),
  links jsonb CHECK(jsonb_typeof(links)='array' AND jsonb_array_length(links)<=8 AND octet_length(links::text)<=2048),
  lexical tsvector GENERATED ALWAYS AS (to_tsvector('simple'::regconfig,title || ' ' || body)) STORED,
  PRIMARY KEY(participant_id,id),
  CHECK((deleted_at IS NULL AND title IS NOT NULL AND body IS NOT NULL AND links IS NOT NULL)
    OR (deleted_at IS NOT NULL AND title IS NULL AND body IS NULL AND links IS NULL))
);
CREATE INDEX private_notes_current_owner ON loom.private_notes(participant_id,id) WHERE deleted_at IS NULL;
CREATE FUNCTION loom.guard_deleted_note() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.deleted_at IS NOT NULL THEN RAISE EXCEPTION 'Terminal private identity'; END IF;
  IF NEW.version <> OLD.version+1 THEN RAISE EXCEPTION 'Invalid private version'; END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER private_note_terminal BEFORE UPDATE ON loom.private_notes FOR EACH ROW EXECUTE FUNCTION loom.guard_deleted_note();
REVOKE ALL ON loom.private_notes FROM loom_app;
GRANT SELECT, INSERT, UPDATE(version,updated_at,deleted_at,title,body,links) ON loom.private_notes TO loom_app;
CREATE TABLE loom.note_operations (
  id uuid PRIMARY KEY,
  participant_id uuid NOT NULL,
  action text NOT NULL CHECK(action IN ('create','update','delete')),
  idempotency_key uuid NOT NULL,
  note_id uuid NOT NULL,
  semantic_version text NOT NULL CHECK(semantic_version='owner-notes-1'),
  request_digest text NOT NULL CHECK(length(request_digest)=64),
  expected_version integer NOT NULL CHECK(expected_version>=0),
  result_version integer NOT NULL CHECK(result_version>0),
  decision text NOT NULL CHECK(decision IN ('applied','version_conflict')),
  decided_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(participant_id,action,idempotency_key),
  FOREIGN KEY(participant_id,note_id) REFERENCES loom.private_notes(participant_id,id)
);
-- A successful terminal delete has capacity reserved when its identity is admitted.
CREATE UNIQUE INDEX note_one_deletion ON loom.note_operations(participant_id,note_id) WHERE action='delete' AND decision='applied';
REVOKE ALL ON loom.note_operations FROM loom_app;
GRANT SELECT, INSERT ON loom.note_operations TO loom_app;
