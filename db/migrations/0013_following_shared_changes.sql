-- Owner-private desired state. Unfollow tombstones and decisions never auto-expire.
CREATE TABLE loom.following_collections (
  participant_id uuid PRIMARY KEY REFERENCES loom.participants(id),
  version integer NOT NULL DEFAULT 0 CHECK(version>=0)
);
CREATE TABLE loom.following_targets (
  id uuid PRIMARY KEY,
  participant_id uuid NOT NULL REFERENCES loom.participants(id),
  target_kind text NOT NULL CHECK(target_kind IN ('area','discussion','artifact')),
  resource_id uuid NOT NULL REFERENCES loom.resources(id),
  following boolean NOT NULL DEFAULT false,
  include_descendants boolean NOT NULL DEFAULT false,
  preferences text[] NOT NULL,
  version integer NOT NULL DEFAULT 0 CHECK(version>=0),
  UNIQUE(participant_id,target_kind,resource_id),
  UNIQUE(participant_id,id),
  CHECK(target_kind='area' OR NOT include_descendants),
  CHECK(cardinality(preferences) BETWEEN 1 AND 7 AND preferences <@ ARRAY[
    'new_discussions','discussion_edits','replies','artifact_revisions','summaries','change_notes','structural']::text[])
);
CREATE INDEX following_active ON loom.following_targets(participant_id,id) WHERE following;
CREATE TABLE loom.following_operations (
  id uuid PRIMARY KEY,
  participant_id uuid NOT NULL REFERENCES loom.participants(id),
  idempotency_key uuid NOT NULL,
  target_id uuid NOT NULL,
  request_digest text NOT NULL CHECK(request_digest ~ '^[0-9a-f]{64}$'),
  desired_following boolean NOT NULL,
  include_descendants boolean NOT NULL,
  preferences text[] NOT NULL,
  expected_version integer NOT NULL,
  result_version integer NOT NULL,
  decision text NOT NULL CHECK(decision IN ('applied','version_conflict')),
  UNIQUE(participant_id,idempotency_key),
  FOREIGN KEY(participant_id,target_id) REFERENCES loom.following_targets(participant_id,id)
);
CREATE FUNCTION loom.validate_following_target() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,loom AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM loom.resources WHERE id=NEW.resource_id AND kind=NEW.target_kind)
    THEN RAISE EXCEPTION 'Invalid Following target'; END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER following_target_type BEFORE INSERT ON loom.following_targets
  FOR EACH ROW EXECUTE FUNCTION loom.validate_following_target();
REVOKE UPDATE,DELETE ON loom.following_targets FROM loom_app;
GRANT UPDATE(following,include_descendants,preferences,version) ON loom.following_targets TO loom_app;
REVOKE UPDATE,DELETE ON loom.following_operations FROM loom_app;
REVOKE UPDATE,DELETE ON loom.following_collections FROM loom_app;
GRANT UPDATE(version) ON loom.following_collections TO loom_app;

-- NULL means the old event did not retain descendant impacts. Never backfill
-- historical membership from today's ancestry. Arrays are facts, not FK guards.
ALTER TABLE loom.shared_activity ADD COLUMN affected_target_ids uuid[];
ALTER TABLE loom.shared_activity ADD CONSTRAINT shared_impact_bound CHECK(
  affected_target_ids IS NULL OR (kind='organization.changed' AND cardinality(affected_target_ids) BETWEEN 1 AND 5500));

-- Independent custody and recovery controls: existing personal tokens are untouched.
CREATE TABLE loom.shared_retrieval_state (
  id smallint PRIMARY KEY CHECK(id=1),
  cursor_key bytea NOT NULL CHECK(octet_length(cursor_key)=32),
  recovery_epoch uuid NOT NULL,
  visibility_version bigint NOT NULL DEFAULT 0,
  retained_after bigint NOT NULL DEFAULT 0 CHECK(retained_after>=0)
);
INSERT INTO loom.shared_retrieval_state(id,cursor_key,recovery_epoch)
  VALUES(1,decode(replace(gen_random_uuid()::text,'-','')||replace(gen_random_uuid()::text,'-',''),'hex'),gen_random_uuid());
REVOKE INSERT,UPDATE,DELETE ON loom.shared_retrieval_state FROM loom_app;
GRANT UPDATE(visibility_version) ON loom.shared_retrieval_state TO loom_app;
CREATE FUNCTION loom.invalidate_shared_retrieval_visibility() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,loom AS $$
BEGIN
  UPDATE loom.shared_retrieval_state SET visibility_version=visibility_version+1 WHERE id=1;
  RETURN NEW;
END
$$;
CREATE TRIGGER resource_shared_retrieval_visibility AFTER UPDATE OF state ON loom.resources
  FOR EACH ROW WHEN(OLD.state IS DISTINCT FROM NEW.state)
  EXECUTE FUNCTION loom.invalidate_shared_retrieval_visibility();
CREATE TRIGGER revision_shared_retrieval_visibility AFTER UPDATE OF availability ON loom.revisions
  FOR EACH ROW WHEN(OLD.availability IS DISTINCT FROM NEW.availability)
  EXECUTE FUNCTION loom.invalidate_shared_retrieval_visibility();
