-- Preserve the existing global visibility generation while recording which
-- contribution became available at each committed generation. Freshness scans
-- this immutable, indexed stream with a fixed budget.
CREATE TABLE loom.discussion_freshness_visibility (
  visibility_version bigint PRIMARY KEY,
  resource_id uuid NOT NULL,
  discussion_id uuid NOT NULL
);
REVOKE UPDATE,DELETE ON loom.discussion_freshness_visibility FROM loom_app;

CREATE OR REPLACE FUNCTION loom.invalidate_shared_retrieval_visibility() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,loom AS $$
DECLARE
  generation bigint;
  contribution_id uuid;
  contribution_discussion uuid;
BEGIN
  UPDATE loom.shared_retrieval_state SET visibility_version=visibility_version+1
    WHERE id=1 RETURNING visibility_version INTO generation;
  IF TG_TABLE_NAME='resources' THEN
    IF NEW.state='active' THEN contribution_id := NEW.id; END IF;
  ELSIF TG_TABLE_NAME='revisions' THEN
    IF NEW.availability='available' AND EXISTS (
      SELECT 1 FROM loom.resources WHERE id=NEW.resource_id AND current_revision_id=NEW.id
    ) THEN contribution_id := NEW.resource_id; END IF;
  END IF;
  IF contribution_id IS NOT NULL THEN
    SELECT discussion_id INTO contribution_discussion FROM loom.contributions
      WHERE id=contribution_id;
    IF contribution_discussion IS NOT NULL THEN
      INSERT INTO loom.discussion_freshness_visibility
        (visibility_version,resource_id,discussion_id)
        VALUES(generation,contribution_id,contribution_discussion);
    END IF;
  END IF;
  RETURN NEW;
END
$$;
