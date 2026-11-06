-- Inferred navigation evidence is independent of authored semantic references.
-- Prospective only: old content, canonical digests and outcomes remain untouched.
CREATE TABLE loom.revision_discussion_links (
  source_id uuid NOT NULL REFERENCES loom.contributions(id),
  revision_id uuid NOT NULL,
  discussion_id uuid NOT NULL REFERENCES loom.discussions(id),
  target_kind text NOT NULL CHECK (target_kind IN ('discussion','contribution','summary')),
  target_id uuid NOT NULL REFERENCES loom.resources(id),
  target_revision_id uuid,
  target_file_id uuid REFERENCES loom.file_contexts(id),
  target_path text,
  destination text NOT NULL CHECK (octet_length(destination)<=1024 AND destination LIKE '/%'),
  PRIMARY KEY (revision_id,destination),
  FOREIGN KEY (source_id,revision_id) REFERENCES loom.revisions(resource_id,id),
  FOREIGN KEY (target_id,target_revision_id) REFERENCES loom.revisions(resource_id,id),
  CHECK (target_kind<>'discussion' OR (target_revision_id IS NULL AND target_id=discussion_id)),
  CHECK ((target_file_id IS NULL AND target_path IS NULL) OR
    (target_file_id IS NOT NULL AND target_path IS NOT NULL AND target_revision_id IS NOT NULL AND target_kind='contribution'))
);
CREATE INDEX discussion_links_incoming ON loom.revision_discussion_links(discussion_id,revision_id,source_id);
CREATE FUNCTION loom.check_discussion_link() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,loom AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM loom.revisions WHERE id=NEW.revision_id AND resource_id=NEW.source_id
    AND content_format IN ('loom-markdown-v1','loom-markdown-v2','loom-markdown-v3','loom-markdown-v4'))
    OR NOT EXISTS (SELECT 1 FROM loom.resources r WHERE r.id=NEW.target_id AND r.kind=NEW.target_kind
      AND CASE r.kind WHEN 'discussion' THEN r.id=NEW.discussion_id
        WHEN 'contribution' THEN EXISTS(SELECT 1 FROM loom.contributions c WHERE c.id=r.id AND c.discussion_id=NEW.discussion_id)
        WHEN 'summary' THEN EXISTS(SELECT 1 FROM loom.summaries s WHERE s.id=r.id AND s.discussion_id=NEW.discussion_id)
        ELSE false END)
    OR (NEW.target_file_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM loom.file_contexts f
      WHERE f.id=NEW.target_file_id AND f.contribution_id=NEW.target_id AND f.revision_id=NEW.target_revision_id AND f.path=NEW.target_path))
    OR (SELECT count(*) FROM loom.revision_discussion_links WHERE revision_id=NEW.revision_id)>=100
  THEN RAISE EXCEPTION 'Invalid inferred discussion link membership' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER discussion_link_membership BEFORE INSERT ON loom.revision_discussion_links
  FOR EACH ROW EXECUTE FUNCTION loom.check_discussion_link();
REVOKE UPDATE,DELETE ON loom.revision_discussion_links FROM loom_app;
