-- File-aware references are explicit v4 declarations. No legacy rows are inferred or rehashed.
ALTER TABLE loom.revisions DROP CONSTRAINT revisions_content_format_check;
ALTER TABLE loom.revisions ADD CONSTRAINT revisions_content_format_check
  CHECK(content_format IN ('text/plain','loom-markdown-v1','loom-markdown-v2','loom-markdown-v3','loom-markdown-v4'));
ALTER TABLE loom.revisions DROP CONSTRAINT revisions_content_text_check;
ALTER TABLE loom.revisions ADD CONSTRAINT revisions_content_text_check
  CHECK(length(content_text)>0 OR content_format IN ('loom-markdown-v3','loom-markdown-v4'));
ALTER TABLE loom.revision_change_notes DROP CONSTRAINT revision_change_notes_content_format_check;
ALTER TABLE loom.revision_change_notes ADD CONSTRAINT revision_change_notes_content_format_check
  CHECK(content_format IN ('loom-markdown-v2','loom-markdown-v4'));
ALTER TABLE loom.revision_references
  ADD COLUMN target_file_id uuid REFERENCES loom.file_contexts(id),
  ADD COLUMN target_path text,
  ADD CHECK ((target_file_id IS NULL AND target_path IS NULL) OR
    (target_file_id IS NOT NULL AND target_path IS NOT NULL AND target_revision_id IS NOT NULL
      AND target_kind IN ('artifact','contribution') AND octet_length(target_path) BETWEEN 1 AND 512));
-- Replace the field-local target constraint, preserving logical assertion/FK identities.
DO $$
DECLARE item record;
BEGIN
  FOR item IN SELECT conname FROM pg_constraint WHERE conrelid='loom.revision_references'::regclass AND contype='u'
  LOOP EXECUTE format('ALTER TABLE loom.revision_references DROP CONSTRAINT %I',item.conname); END LOOP;
END
$$;
ALTER TABLE loom.revision_references ADD UNIQUE NULLS NOT DISTINCT
  (revision_id,source_field,target_id,target_revision_id,target_file_id);
DROP INDEX loom.reference_incoming;
CREATE INDEX reference_incoming ON loom.revision_references
  (target_id,target_revision_id,target_file_id,revision_id,source_field,reference_id);

CREATE OR REPLACE FUNCTION loom.check_change_note() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,loom AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM loom.revisions v JOIN loom.resources r ON r.id=v.resource_id
    WHERE v.id=NEW.revision_id AND v.resource_id=NEW.source_id AND v.content_format IN ('loom-markdown-v3','loom-markdown-v4')
      AND (EXISTS(SELECT 1 FROM loom.artifacts WHERE id=r.id) AND r.kind='artifact'
        OR EXISTS(SELECT 1 FROM loom.summaries WHERE id=r.id) AND r.kind='summary'))
    OR NEW.content_format='loom-markdown-v4' AND NOT EXISTS(SELECT 1 FROM loom.revisions WHERE id=NEW.revision_id AND content_format='loom-markdown-v4')
  THEN RAISE EXCEPTION 'Invalid revision note owner' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION loom.check_reference_membership() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,loom AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM loom.revisions v JOIN loom.resources r ON r.id=v.resource_id
    WHERE v.id=NEW.revision_id AND v.resource_id=NEW.source_id AND v.content_format IN ('loom-markdown-v2','loom-markdown-v3','loom-markdown-v4')
      AND ((r.kind='contribution' AND EXISTS(SELECT 1 FROM loom.contributions WHERE id=r.id))
        OR (r.kind='artifact' AND EXISTS(SELECT 1 FROM loom.artifacts WHERE id=r.id))
        OR (r.kind='summary' AND EXISTS(SELECT 1 FROM loom.summaries WHERE id=r.id))))
    OR NOT EXISTS (SELECT 1 FROM loom.resources r WHERE r.id=NEW.target_id AND r.kind=NEW.target_kind
      AND CASE r.kind WHEN 'discussion' THEN EXISTS(SELECT 1 FROM loom.discussions WHERE id=r.id)
        WHEN 'contribution' THEN EXISTS(SELECT 1 FROM loom.contributions WHERE id=r.id)
        WHEN 'artifact' THEN EXISTS(SELECT 1 FROM loom.artifacts WHERE id=r.id)
        WHEN 'summary' THEN EXISTS(SELECT 1 FROM loom.summaries WHERE id=r.id) ELSE false END)
    OR NEW.source_field='change_note' AND NOT EXISTS(SELECT 1 FROM loom.revision_change_notes WHERE revision_id=NEW.revision_id)
    OR NEW.target_file_id IS NOT NULL AND (
      NOT EXISTS(SELECT 1 FROM loom.revisions WHERE id=NEW.revision_id AND content_format='loom-markdown-v4')
      OR NEW.source_field='change_note' AND NOT EXISTS(SELECT 1 FROM loom.revision_change_notes WHERE revision_id=NEW.revision_id AND content_format='loom-markdown-v4')
      OR NOT EXISTS(SELECT 1 FROM loom.file_contexts f WHERE f.id=NEW.target_file_id
        AND f.revision_id=NEW.target_revision_id AND f.path=NEW.target_path
        AND CASE NEW.target_kind WHEN 'artifact' THEN f.artifact_id=NEW.target_id
          WHEN 'contribution' THEN f.contribution_id=NEW.target_id ELSE false END))
  THEN RAISE EXCEPTION 'Invalid reference membership' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION loom.check_reference_withdrawal() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,loom AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM loom.revisions v JOIN loom.revisions prior ON prior.id=NEW.prior_revision_id
    WHERE v.id=NEW.revision_id AND v.resource_id=NEW.source_id AND v.content_format IN ('loom-markdown-v2','loom-markdown-v3','loom-markdown-v4')
      AND v.revision_number=NEW.revision_number AND prior.resource_id=v.resource_id AND prior.revision_number=v.revision_number-1)
    OR EXISTS(SELECT 1 FROM loom.revision_references rr WHERE rr.source_id=NEW.source_id AND rr.revision_id=NEW.revision_id
      AND rr.source_field='main' AND rr.reference_id=NEW.reference_id)
  THEN RAISE EXCEPTION 'Invalid reference withdrawal' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION loom.check_change_member() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,loom AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM loom.revisions WHERE id=NEW.revision_id AND content_format IN ('loom-markdown-v3','loom-markdown-v4'))
    OR NOT EXISTS(SELECT 1 FROM loom.resources r JOIN loom.revisions v ON v.resource_id=r.id
      WHERE r.id=NEW.target_id AND r.kind=NEW.target_kind AND v.id=NEW.target_revision_id
        AND v.content_format IN ('loom-markdown-v1','loom-markdown-v2','loom-markdown-v3','loom-markdown-v4')
        AND CASE r.kind WHEN 'contribution' THEN EXISTS(SELECT 1 FROM loom.contributions WHERE id=r.id)
          WHEN 'artifact' THEN EXISTS(SELECT 1 FROM loom.artifacts WHERE id=r.id)
          WHEN 'summary' THEN EXISTS(SELECT 1 FROM loom.summaries WHERE id=r.id) ELSE false END)
  THEN RAISE EXCEPTION 'Invalid change coverage' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION loom.check_change_set() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,loom AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM loom.revisions WHERE id=NEW.revision_id AND content_format IN ('loom-markdown-v3','loom-markdown-v4'))
    OR (SELECT count(*) FROM loom.change_account_members WHERE revision_id=NEW.revision_id) NOT BETWEEN 1 AND 16
    OR NEW.carried_from_revision_id IS NOT NULL AND (
      NOT EXISTS(SELECT 1 FROM loom.revisions v JOIN loom.revisions p ON p.resource_id=v.resource_id
        AND p.revision_number=v.revision_number-1 WHERE v.id=NEW.revision_id AND p.id=NEW.carried_from_revision_id)
      OR EXISTS((SELECT target_kind,target_id,target_revision_id FROM loom.change_account_members WHERE revision_id=NEW.revision_id
        EXCEPT SELECT target_kind,target_id,target_revision_id FROM loom.change_account_members WHERE revision_id=NEW.carried_from_revision_id)
        UNION ALL (SELECT target_kind,target_id,target_revision_id FROM loom.change_account_members WHERE revision_id=NEW.carried_from_revision_id
        EXCEPT SELECT target_kind,target_id,target_revision_id FROM loom.change_account_members WHERE revision_id=NEW.revision_id)))
  THEN RAISE EXCEPTION 'Invalid change declaration' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION loom.check_reading_target() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM loom.revisions v JOIN loom.resources r ON r.id=v.resource_id
    WHERE v.id=NEW.revision_id AND r.id=NEW.resource_id
    AND v.content_format IN ('loom-markdown-v1','loom-markdown-v2','loom-markdown-v3','loom-markdown-v4')
    AND ((r.kind='contribution' AND EXISTS (SELECT 1 FROM loom.contributions c WHERE c.id=r.id))
      OR (r.kind='artifact' AND EXISTS (SELECT 1 FROM loom.artifacts a WHERE a.id=r.id))
      OR (r.kind='summary' AND EXISTS (SELECT 1 FROM loom.summaries s WHERE s.id=r.id)))) THEN
    RAISE EXCEPTION 'invalid reading target' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END
$$;
