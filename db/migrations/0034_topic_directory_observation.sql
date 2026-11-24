-- One row for the implicit root and one per typed topic. Membership continues
-- to live exclusively in resources.owner_resource_id.
CREATE TABLE loom.topic_directory_state (
  scope text PRIMARY KEY,
  directory_version integer NOT NULL DEFAULT 0 CHECK (directory_version >= 0),
  open_children integer NOT NULL DEFAULT 0 CHECK (open_children >= 0)
);
REVOKE UPDATE,DELETE ON loom.topic_directory_state FROM loom_app;
GRANT UPDATE (directory_version,open_children) ON loom.topic_directory_state TO loom_app;

INSERT INTO loom.topic_directory_state(scope)
SELECT 'root' UNION ALL SELECT id::text FROM loom.areas;
UPDATE loom.topic_directory_state s SET open_children = existing.n
FROM (
  SELECT coalesce(r.owner_resource_id::text, 'root') AS scope, count(*)::integer AS n
  FROM loom.areas a JOIN loom.resources r ON r.id=a.id
  WHERE r.publication_open AND r.state='active' GROUP BY r.owner_resource_id
) existing WHERE s.scope=existing.scope;

CREATE FUNCTION loom.record_topic_directory_metadata() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,loom AS $$
DECLARE
  resource loom.resources%ROWTYPE;
BEGIN
  SELECT * INTO STRICT resource FROM loom.resources WHERE id=NEW.id;
  IF TG_OP='INSERT' THEN
    INSERT INTO loom.topic_directory_state(scope) VALUES (NEW.id::text);
  END IF;
  IF resource.state='active' THEN
    UPDATE loom.topic_directory_state SET directory_version=directory_version+1,
      open_children=open_children+(TG_OP='INSERT' AND resource.publication_open)::integer
      WHERE scope=coalesce(resource.owner_resource_id::text,'root');
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER new_topic_directory AFTER INSERT ON loom.areas
  FOR EACH ROW EXECUTE FUNCTION loom.record_topic_directory_metadata();
CREATE TRIGGER edited_topic_directory AFTER UPDATE OF title,description ON loom.areas
  FOR EACH ROW WHEN ((OLD.title,OLD.description) IS DISTINCT FROM (NEW.title,NEW.description))
  EXECUTE FUNCTION loom.record_topic_directory_metadata();

-- Organization permits twelve topic levels. Compare the old and new parent
-- paths under its structure guard, including moves between open and closed trees.
CREATE FUNCTION loom.topic_directory_path_open(parent_id uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,loom AS $$
  WITH RECURSIVE ancestors(owner_id,accepts,depth) AS (
    SELECT owner_resource_id,state='active' AND publication_open,1
      FROM loom.resources WHERE id=parent_id
    UNION ALL
    SELECT parent.owner_resource_id,parent.accepts,child.depth+1 FROM ancestors child
      CROSS JOIN LATERAL (
        SELECT owner_resource_id,state='active' AND publication_open AS accepts
        FROM loom.resources WHERE id=child.owner_id LIMIT 1
      ) parent
      WHERE child.accepts AND child.depth<12
  )
  SELECT coalesce(bool_and(accepts),true) FROM ancestors
$$;

-- A directory can contain many ordinary discussions and artifacts. Traverse
-- only open area edges when a writer changes an inherited restriction.
CREATE INDEX topic_directory_open_edges ON loom.resources(owner_resource_id,id)
  WHERE kind='area' AND state='active' AND publication_open;

CREATE FUNCTION loom.record_topic_directory_placement() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,loom AS $$
DECLARE
  old_scope text := coalesce(OLD.owner_resource_id::text,'root');
  new_scope text := coalesce(NEW.owner_resource_id::text,'root');
  old_open integer := (OLD.state='active' AND OLD.publication_open)::integer;
  new_open integer := (NEW.state='active' AND NEW.publication_open)::integer;
BEGIN
  IF EXISTS (SELECT 1 FROM loom.areas WHERE id=NEW.id) THEN
    -- A move touches both direct directories.
    UPDATE loom.topic_directory_state SET directory_version=directory_version+1,
      open_children=open_children
        - CASE WHEN scope=old_scope THEN old_open ELSE 0 END
        + CASE WHEN scope=new_scope THEN new_open ELSE 0 END
      WHERE (scope=old_scope AND OLD.state='active') OR (scope=new_scope AND NEW.state='active');

    -- Persist transitions even when a second commit restores the old state
    -- before anyone observes it. Closed branches and empty directories have
    -- no direct children's effective contribution label to change.
    IF EXISTS (SELECT 1 FROM loom.topic_directory_state WHERE scope=NEW.id::text AND open_children>0)
      AND ((old_open=1 AND loom.topic_directory_path_open(OLD.owner_resource_id))
        <> (new_open=1 AND loom.topic_directory_path_open(NEW.owner_resource_id))) THEN
      WITH RECURSIVE affected(id,depth) AS (
        VALUES (NEW.id,1)
        UNION ALL
        SELECT child.id,parent.depth+1 FROM affected parent
        JOIN loom.resources child ON child.owner_resource_id=parent.id
          AND child.kind='area' AND child.state='active' AND child.publication_open
        JOIN loom.topic_directory_state dir ON dir.scope=child.id::text AND dir.open_children>0
        WHERE parent.depth<12
      )
      UPDATE loom.topic_directory_state dir SET directory_version=dir.directory_version+1
      FROM affected WHERE dir.scope=affected.id::text;
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER changed_topic_directory AFTER UPDATE OF owner_resource_id,state,publication_open
  ON loom.resources FOR EACH ROW WHEN (NEW.kind='area' AND
  (OLD.owner_resource_id,OLD.state,OLD.publication_open) IS DISTINCT FROM
  (NEW.owner_resource_id,NEW.state,NEW.publication_open))
  EXECUTE FUNCTION loom.record_topic_directory_placement();
