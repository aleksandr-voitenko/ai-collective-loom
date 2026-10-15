-- Search is a separate consumer; immutable publication/organization intents stay intact.
CREATE TABLE loom.search_state (
  id smallint PRIMARY KEY CHECK (id=1),
  generation integer NOT NULL DEFAULT 1 CHECK (generation>0),
  index_version bigint NOT NULL DEFAULT 0,
  visibility_version bigint NOT NULL DEFAULT 0,
  source_after uuid,
  scan_complete boolean NOT NULL DEFAULT false,
  event_after bigint NOT NULL DEFAULT 0,
  heartbeat_at timestamptz,
  capacity_limited boolean NOT NULL DEFAULT false
);
INSERT INTO loom.search_state(id) VALUES (1);
CREATE TABLE loom.search_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  generation integer NOT NULL CHECK (generation>0),
  resource_id uuid REFERENCES loom.resources(id),
  revision_id uuid,
  source_event_id uuid REFERENCES loom.shared_activity(id),
  kind text NOT NULL CHECK (kind IN ('revision','organization','unsupported')),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','running','succeeded','failed')),
  outcome text CHECK (outcome IN ('indexed','superseded','not_applicable')),
  claim_generation integer NOT NULL DEFAULT 0 CHECK (claim_generation>=0),
  owner uuid,
  lease_until timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 3),
  due_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  failure text CHECK (failure IN ('unsupported_event','unsupported_source','source_limit','processing_failed','lease_expired')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  FOREIGN KEY (resource_id, revision_id) REFERENCES loom.revisions(resource_id,id),
  CHECK (revision_id IS NOT NULL OR source_event_id IS NOT NULL),
  CHECK ((state='running') = (owner IS NOT NULL AND lease_until IS NOT NULL))
);
CREATE UNIQUE INDEX search_revision_work ON loom.search_jobs(generation,revision_id) WHERE revision_id IS NOT NULL;
CREATE UNIQUE INDEX search_event_work ON loom.search_jobs(generation,source_event_id) WHERE revision_id IS NULL;
CREATE INDEX search_due_work ON loom.search_jobs(generation,state,due_at,lease_until,id);
CREATE TABLE loom.search_documents (
  resource_id uuid PRIMARY KEY REFERENCES loom.resources(id),
  revision_id uuid NOT NULL,
  revision_number bigint NOT NULL,
  generation integer NOT NULL,
  job_id uuid NOT NULL REFERENCES loom.search_jobs(id),
  title text NOT NULL,
  body text NOT NULL CHECK (octet_length(body)<=16384),
  document tsvector NOT NULL,
  indexed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (resource_id,revision_id) REFERENCES loom.revisions(resource_id,id)
);
CREATE INDEX search_lexical ON loom.search_documents USING gin(document);
-- Lifecycle writers already guard source rows. This tail only invalidates derived
-- selections, never creates activity or changes retained source/publication bytes.
CREATE FUNCTION loom.invalidate_search_visibility() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, loom AS $$
BEGIN
  UPDATE loom.search_state SET visibility_version=visibility_version+1 WHERE id=1;
  RETURN NEW;
END
$$;
CREATE TRIGGER resource_search_visibility AFTER UPDATE OF state ON loom.resources
  FOR EACH ROW WHEN (OLD.state IS DISTINCT FROM NEW.state)
  EXECUTE FUNCTION loom.invalidate_search_visibility();
CREATE TRIGGER revision_search_visibility AFTER UPDATE OF availability ON loom.revisions
  FOR EACH ROW WHEN (OLD.availability IS DISTINCT FROM NEW.availability)
  EXECUTE FUNCTION loom.invalidate_search_visibility();
REVOKE INSERT, DELETE ON loom.search_state FROM loom_app;
REVOKE DELETE ON loom.search_jobs FROM loom_app;
