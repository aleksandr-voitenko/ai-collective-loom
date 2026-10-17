-- Exact, owner-private state. No backfill and no shared/delivery clock effects.
CREATE TABLE loom.reading_owners (
  participant_id uuid PRIMARY KEY REFERENCES loom.participants(id),
  targets integer NOT NULL DEFAULT 0 CHECK (targets BETWEEN 0 AND 10000),
  operations integer NOT NULL DEFAULT 0 CHECK (operations BETWEEN 0 AND 50000),
  members integer NOT NULL DEFAULT 0 CHECK (members BETWEEN 0 AND 100000)
);
CREATE TABLE loom.reading_states (
  participant_id uuid NOT NULL REFERENCES loom.participants(id),
  resource_id uuid NOT NULL,
  revision_id uuid NOT NULL,
  is_read boolean NOT NULL,
  version integer NOT NULL CHECK (version BETWEEN 1 AND 2147483646),
  deliberate_version integer NOT NULL CHECK (deliberate_version BETWEEN 0 AND version),
  PRIMARY KEY (participant_id, revision_id),
  FOREIGN KEY (resource_id, revision_id) REFERENCES loom.revisions(resource_id,id)
);
CREATE FUNCTION loom.check_reading_target() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM loom.revisions v JOIN loom.resources r ON r.id=v.resource_id
    WHERE v.id=NEW.revision_id AND r.id=NEW.resource_id
    AND v.content_format IN ('loom-markdown-v1','loom-markdown-v2','loom-markdown-v3')
    AND ((r.kind='contribution' AND EXISTS (SELECT 1 FROM loom.contributions c WHERE c.id=r.id))
      OR (r.kind='artifact' AND EXISTS (SELECT 1 FROM loom.artifacts a WHERE a.id=r.id))
      OR (r.kind='summary' AND EXISTS (SELECT 1 FROM loom.summaries s WHERE s.id=r.id)))) THEN
    RAISE EXCEPTION 'invalid reading target' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER reading_target_membership BEFORE INSERT ON loom.reading_states
  FOR EACH ROW EXECUTE FUNCTION loom.check_reading_target();
CREATE TABLE loom.reading_operations (
  id uuid PRIMARY KEY,
  participant_id uuid NOT NULL REFERENCES loom.participants(id),
  idempotency_key uuid NOT NULL,
  semantic_version text NOT NULL CHECK (semantic_version='reading-state-1'),
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  decision text NOT NULL CHECK (decision IN ('applied','version_conflict')),
  outcome jsonb NOT NULL CHECK (jsonb_typeof(outcome)='object'
    AND jsonb_array_length(outcome->'targets') BETWEEN 1 AND 25
    AND octet_length(outcome::text)<=16384),
  UNIQUE (participant_id,idempotency_key)
);
REVOKE UPDATE, DELETE ON loom.reading_states, loom.reading_operations, loom.reading_owners FROM loom_app;
GRANT UPDATE (is_read,version,deliberate_version) ON loom.reading_states TO loom_app;
GRANT UPDATE (targets,operations,members) ON loom.reading_owners TO loom_app;
