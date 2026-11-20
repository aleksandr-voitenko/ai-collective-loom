-- Record direct-list events at the existing committed positions. The topic
-- index excludes unrelated activity from the bounded scan. Resource and topic
-- identities here are historical facts, never ordinary read authority.
CREATE TABLE loom.topic_discussion_activity (
  area_id uuid NOT NULL,
  position bigint NOT NULL,
  opening_id uuid NOT NULL,
  effect text NOT NULL CHECK(effect IN ('created','revised','arrived','departed')),
  PRIMARY KEY (area_id,position)
);
REVOKE UPDATE,DELETE ON loom.topic_discussion_activity FROM loom_app;

CREATE FUNCTION loom.record_topic_discussion_activity() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,loom AS $$
BEGIN
  IF NEW.kind='revision.published' THEN
    INSERT INTO loom.topic_discussion_activity(area_id,position,opening_id,effect)
      SELECT area_id,NEW.position,opening_id,
        CASE WHEN first_revision_id=NEW.revision_id THEN 'created' ELSE 'revised' END
      FROM loom.topic_discussion_openings WHERE opening_id=NEW.resource_id;
  ELSIF NEW.kind='organization.changed'
    AND NEW.before_area_scope_ids[1] IS DISTINCT FROM NEW.after_area_scope_ids[1] THEN
    INSERT INTO loom.topic_discussion_activity(area_id,position,opening_id,effect)
      SELECT placement.area_id,NEW.position,d.opening_id,placement.effect
        FROM loom.topic_discussion_openings d
        CROSS JOIN (VALUES (NEW.before_area_scope_ids[1],'departed'),
                           (NEW.after_area_scope_ids[1],'arrived')) placement(area_id,effect)
        WHERE d.discussion_id=NEW.resource_id AND placement.area_id IS NOT NULL;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER record_topic_discussion_activity AFTER INSERT ON loom.shared_activity
  FOR EACH ROW EXECUTE FUNCTION loom.record_topic_discussion_activity();

-- A moved discussion may remain on a previously accepted list. Scan opening
-- and whole-discussion visibility independently of event-time topic placement.
CREATE TABLE loom.topic_discussion_visibility (
  visibility_version bigint PRIMARY KEY,
  area_id uuid NOT NULL,
  opening_id uuid NOT NULL,
  revision_id uuid
);
REVOKE UPDATE,DELETE ON loom.topic_discussion_visibility FROM loom_app;

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
    IF NEW.kind='discussion' THEN
      INSERT INTO loom.topic_discussion_visibility(visibility_version,area_id,opening_id)
        SELECT generation,area_id,opening_id FROM loom.topic_discussion_openings WHERE discussion_id=NEW.id;
    ELSIF NEW.kind='contribution' THEN
      INSERT INTO loom.topic_discussion_visibility(visibility_version,area_id,opening_id)
        SELECT generation,area_id,opening_id FROM loom.topic_discussion_openings WHERE opening_id=NEW.id;
    END IF;
  ELSIF TG_TABLE_NAME='revisions' THEN
    IF NEW.availability='available' AND EXISTS (
      SELECT 1 FROM loom.resources WHERE id=NEW.resource_id AND current_revision_id=NEW.id
    ) THEN contribution_id := NEW.resource_id; END IF;
    INSERT INTO loom.topic_discussion_visibility(visibility_version,area_id,opening_id,revision_id)
      SELECT generation,area_id,opening_id,NEW.id FROM loom.topic_discussion_openings WHERE opening_id=NEW.resource_id;
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
