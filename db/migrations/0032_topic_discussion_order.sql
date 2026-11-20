-- Transactional directory keys keep the chronological candidate scan indexed
-- within its current topic. Source authorization and publication facts stay in
-- their existing tables. Backfill from the immutable opening and current owner.
CREATE TABLE loom.topic_discussion_openings (
  discussion_id uuid PRIMARY KEY REFERENCES loom.discussions(id),
  area_id uuid NOT NULL REFERENCES loom.resources(id),
  opening_id uuid NOT NULL UNIQUE REFERENCES loom.contributions(id),
  opening_created_at timestamptz NOT NULL,
  first_revision_id uuid NOT NULL,
  FOREIGN KEY (opening_id,first_revision_id) REFERENCES loom.revisions(resource_id,id)
);

INSERT INTO loom.topic_discussion_openings(discussion_id,area_id,opening_id,opening_created_at,first_revision_id)
SELECT d.id,r.owner_resource_id,c.id,c.created_at,v.id
FROM loom.discussions d JOIN loom.resources r ON r.id=d.id
JOIN loom.contributions c ON c.id=d.opening_id
JOIN loom.revisions v ON v.resource_id=c.id AND v.revision_number=1;

CREATE INDEX topic_discussion_openings_by_creation ON loom.topic_discussion_openings
  (area_id,opening_created_at DESC,opening_id DESC) INCLUDE (first_revision_id);
REVOKE UPDATE,DELETE ON loom.topic_discussion_openings FROM loom_app;
GRANT UPDATE (area_id) ON loom.topic_discussion_openings TO loom_app;

CREATE FUNCTION loom.record_topic_discussion_opening() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,loom AS $$
BEGIN
  INSERT INTO loom.topic_discussion_openings(discussion_id,area_id,opening_id,opening_created_at,first_revision_id)
    SELECT d.id,r.owner_resource_id,c.id,c.created_at,NEW.id
    FROM loom.contributions c JOIN loom.discussions d ON d.id=c.discussion_id AND d.opening_id=c.id
    JOIN loom.resources r ON r.id=d.id WHERE c.id=NEW.resource_id AND c.parent_id IS NULL;
  RETURN NEW;
END
$$;

CREATE TRIGGER record_topic_discussion_opening AFTER INSERT ON loom.revisions
  FOR EACH ROW WHEN (NEW.revision_number=1) EXECUTE FUNCTION loom.record_topic_discussion_opening();

CREATE FUNCTION loom.move_topic_discussion_opening() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,loom AS $$
BEGIN
  UPDATE loom.topic_discussion_openings SET area_id=NEW.owner_resource_id WHERE discussion_id=NEW.id;
  RETURN NEW;
END
$$;

CREATE TRIGGER move_topic_discussion_opening AFTER UPDATE OF owner_resource_id ON loom.resources
  FOR EACH ROW WHEN (NEW.kind='discussion' AND OLD.owner_resource_id IS DISTINCT FROM NEW.owner_resource_id)
  EXECUTE FUNCTION loom.move_topic_discussion_opening();
