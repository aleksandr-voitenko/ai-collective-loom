-- Owner-private desired state. Unsave retains a versioned tombstone so an old
-- command cannot regain the initial version. No shared clock/event/outbox writes.
CREATE TABLE loom.saved_collections (
  participant_id uuid PRIMARY KEY REFERENCES loom.participants(id),
  version integer NOT NULL DEFAULT 0 CHECK (version BETWEEN 0 AND 2147483646)
);
CREATE TABLE loom.saved_items (
  id uuid PRIMARY KEY,
  participant_id uuid NOT NULL REFERENCES loom.participants(id),
  target_kind text NOT NULL CHECK (target_kind IN ('discussion', 'contribution', 'artifact', 'revision')),
  resource_id uuid NOT NULL REFERENCES loom.resources(id),
  content_resource_id uuid NOT NULL REFERENCES loom.resources(id),
  revision_id uuid,
  observed_revision_id uuid,
  saved boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 0 CHECK (version BETWEEN 0 AND 2147483646),
  CHECK ((target_kind = 'revision') = (revision_id IS NOT NULL)),
  CHECK (target_kind = 'discussion' OR content_resource_id = resource_id),
  FOREIGN KEY (content_resource_id, revision_id) REFERENCES loom.revisions(resource_id, id),
  FOREIGN KEY (content_resource_id, observed_revision_id) REFERENCES loom.revisions(resource_id, id),
  UNIQUE NULLS NOT DISTINCT (participant_id, target_kind, resource_id, revision_id),
  UNIQUE (participant_id, id)
);
CREATE INDEX saved_items_collection ON loom.saved_items(participant_id, id) WHERE saved;

-- Enforce logical type and discussion-opening membership independently of HTTP.
CREATE FUNCTION loom.check_saved_target() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.target_kind = 'discussion' THEN
    IF NOT EXISTS (SELECT 1 FROM loom.discussions d JOIN loom.resources r ON r.id=d.id
      WHERE d.id=NEW.resource_id AND d.opening_id=NEW.content_resource_id AND r.kind='discussion') THEN
      RAISE EXCEPTION 'invalid saved target' USING ERRCODE='23514';
    END IF;
  ELSIF NOT EXISTS (SELECT 1 FROM loom.resources r WHERE r.id=NEW.resource_id
    AND ((NEW.target_kind='revision' AND r.kind IN ('contribution','artifact')) OR r.kind=NEW.target_kind)
    AND ((r.kind='contribution' AND EXISTS (SELECT 1 FROM loom.contributions c WHERE c.id=r.id))
      OR (r.kind='artifact' AND EXISTS (SELECT 1 FROM loom.artifacts a WHERE a.id=r.id)))) THEN
    RAISE EXCEPTION 'invalid saved target' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER saved_target_membership BEFORE INSERT ON loom.saved_items
  FOR EACH ROW EXECUTE FUNCTION loom.check_saved_target();

CREATE TABLE loom.saved_operations (
  id uuid PRIMARY KEY,
  participant_id uuid NOT NULL REFERENCES loom.participants(id),
  idempotency_key uuid NOT NULL,
  bookmark_id uuid NOT NULL,
  semantic_version text NOT NULL CHECK (semantic_version='saved-state-v1'),
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  desired_saved boolean NOT NULL,
  expected_version integer NOT NULL CHECK (expected_version BETWEEN 0 AND 2147483646),
  result_version integer NOT NULL CHECK (result_version BETWEEN 0 AND 2147483646),
  decision text NOT NULL CHECK (decision IN ('applied','version_conflict')),
  FOREIGN KEY (participant_id, bookmark_id) REFERENCES loom.saved_items(participant_id, id),
  UNIQUE (participant_id, idempotency_key)
);
REVOKE UPDATE, DELETE ON loom.saved_items, loom.saved_collections, loom.saved_operations FROM loom_app;
GRANT UPDATE (saved, version, observed_revision_id) ON loom.saved_items TO loom_app;
GRANT UPDATE (version) ON loom.saved_collections TO loom_app;
