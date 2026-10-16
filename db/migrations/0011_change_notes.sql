-- New declarations are explicit. Existing source bytes, outcomes and claims stay intact.
ALTER TABLE loom.revisions DROP CONSTRAINT revisions_content_format_check;
ALTER TABLE loom.revisions ADD CONSTRAINT revisions_content_format_check
  CHECK (content_format IN ('text/plain','loom-markdown-v1','loom-markdown-v2','loom-markdown-v3'));

CREATE TABLE loom.revision_change_notes (
  source_id uuid NOT NULL,
  revision_id uuid PRIMARY KEY,
  content_format text NOT NULL CHECK (content_format='loom-markdown-v2'),
  content_text text NOT NULL CHECK (octet_length(content_text) BETWEEN 1 AND 4096),
  FOREIGN KEY (source_id,revision_id) REFERENCES loom.revisions(resource_id,id)
);
CREATE FUNCTION loom.check_change_note() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,loom AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM loom.revisions v JOIN loom.resources r ON r.id=v.resource_id
    WHERE v.id=NEW.revision_id AND v.resource_id=NEW.source_id AND v.content_format='loom-markdown-v3'
      AND (EXISTS(SELECT 1 FROM loom.artifacts WHERE id=r.id) AND r.kind='artifact'
        OR EXISTS(SELECT 1 FROM loom.summaries WHERE id=r.id) AND r.kind='summary'))
  THEN RAISE EXCEPTION 'Invalid revision note owner' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER change_note_owner BEFORE INSERT ON loom.revision_change_notes FOR EACH ROW EXECUTE FUNCTION loom.check_change_note();
REVOKE UPDATE,DELETE ON loom.revision_change_notes FROM loom_app;

ALTER TABLE loom.revision_mentions ADD COLUMN source_field text NOT NULL DEFAULT 'main' CHECK(source_field IN ('main','change_note'));
ALTER TABLE loom.revision_mentions DROP CONSTRAINT revision_mentions_pkey;
ALTER TABLE loom.revision_mentions ADD PRIMARY KEY(revision_id,source_field,token);
CREATE FUNCTION loom.check_note_entity() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,loom AS $$
BEGIN
  IF NEW.source_field='change_note' AND NOT EXISTS(SELECT 1 FROM loom.revision_change_notes WHERE revision_id=NEW.revision_id)
  THEN RAISE EXCEPTION 'Missing owning note' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER mention_field BEFORE INSERT ON loom.revision_mentions FOR EACH ROW EXECUTE FUNCTION loom.check_note_entity();

ALTER TABLE loom.revision_references ADD COLUMN source_field text NOT NULL DEFAULT 'main' CHECK(source_field IN ('main','change_note'));
ALTER TABLE loom.reference_withdrawals ADD COLUMN source_field text NOT NULL DEFAULT 'main' CHECK(source_field='main');
-- Replace only the identity constraints that need a field namespace. Catalog names
-- avoid depending on PostgreSQL's truncation of generated composite-FK names.
DO $$
DECLARE constraint_row record;
BEGIN
  FOR constraint_row IN SELECT conrelid::regclass AS relation,conname FROM pg_constraint
    WHERE confrelid='loom.revision_references'::regclass AND contype='f'
      AND conrelid IN ('loom.revision_references'::regclass,'loom.reference_withdrawals'::regclass)
  LOOP EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I',constraint_row.relation,constraint_row.conname); END LOOP;
  FOR constraint_row IN SELECT conname FROM pg_constraint
    WHERE conrelid='loom.revision_references'::regclass AND contype IN ('p','u')
  LOOP EXECUTE format('ALTER TABLE loom.revision_references DROP CONSTRAINT %I',constraint_row.conname); END LOOP;
END
$$;
ALTER TABLE loom.revision_references
  ADD PRIMARY KEY(source_id,revision_id,source_field,reference_id),
  ADD UNIQUE NULLS NOT DISTINCT(revision_id,source_field,target_id,target_revision_id),
  ADD FOREIGN KEY(source_id,origin_revision_id,source_field,reference_id)
    REFERENCES loom.revision_references(source_id,revision_id,source_field,reference_id) DEFERRABLE INITIALLY DEFERRED,
  ADD FOREIGN KEY(source_id,assertion_revision_id,source_field,reference_id)
    REFERENCES loom.revision_references(source_id,revision_id,source_field,reference_id) DEFERRABLE INITIALLY DEFERRED,
  ADD CHECK(source_field='main' OR origin_revision_id=revision_id AND assertion_revision_id=revision_id);
ALTER TABLE loom.reference_withdrawals ADD FOREIGN KEY(source_id,prior_revision_id,source_field,reference_id)
  REFERENCES loom.revision_references(source_id,revision_id,source_field,reference_id);
CREATE OR REPLACE FUNCTION loom.check_reference_membership() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,loom AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM loom.revisions v JOIN loom.resources r ON r.id=v.resource_id
    WHERE v.id=NEW.revision_id AND v.resource_id=NEW.source_id AND v.content_format IN ('loom-markdown-v2','loom-markdown-v3')
      AND ((r.kind='contribution' AND EXISTS(SELECT 1 FROM loom.contributions WHERE id=r.id))
        OR (r.kind='artifact' AND EXISTS(SELECT 1 FROM loom.artifacts WHERE id=r.id))
        OR (r.kind='summary' AND EXISTS(SELECT 1 FROM loom.summaries WHERE id=r.id))))
    OR NOT EXISTS (SELECT 1 FROM loom.resources r WHERE r.id=NEW.target_id AND r.kind=NEW.target_kind
      AND CASE r.kind WHEN 'discussion' THEN EXISTS(SELECT 1 FROM loom.discussions WHERE id=r.id)
        WHEN 'contribution' THEN EXISTS(SELECT 1 FROM loom.contributions WHERE id=r.id)
        WHEN 'artifact' THEN EXISTS(SELECT 1 FROM loom.artifacts WHERE id=r.id)
        WHEN 'summary' THEN EXISTS(SELECT 1 FROM loom.summaries WHERE id=r.id) ELSE false END)
    OR NEW.source_field='change_note' AND NOT EXISTS(SELECT 1 FROM loom.revision_change_notes WHERE revision_id=NEW.revision_id)
  THEN RAISE EXCEPTION 'Invalid reference membership' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END
$$;
CREATE OR REPLACE FUNCTION loom.check_reference_withdrawal() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,loom AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM loom.revisions v JOIN loom.revisions prior ON prior.id=NEW.prior_revision_id
    WHERE v.id=NEW.revision_id AND v.resource_id=NEW.source_id AND v.content_format IN ('loom-markdown-v2','loom-markdown-v3')
      AND v.revision_number=NEW.revision_number AND prior.resource_id=v.resource_id AND prior.revision_number=v.revision_number-1)
    OR EXISTS(SELECT 1 FROM loom.revision_references rr WHERE rr.source_id=NEW.source_id AND rr.revision_id=NEW.revision_id
      AND rr.source_field='main' AND rr.reference_id=NEW.reference_id)
  THEN RAISE EXCEPTION 'Invalid reference withdrawal' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END
$$;

CREATE TABLE loom.change_account_sets (
  source_id uuid NOT NULL REFERENCES loom.contributions(id),
  revision_id uuid PRIMARY KEY,
  carried_from_revision_id uuid,
  UNIQUE(source_id,revision_id),
  FOREIGN KEY(source_id,revision_id) REFERENCES loom.revisions(resource_id,id),
  FOREIGN KEY(source_id,carried_from_revision_id) REFERENCES loom.change_account_sets(source_id,revision_id)
);
CREATE TABLE loom.change_account_members (
  revision_id uuid NOT NULL REFERENCES loom.change_account_sets(revision_id),
  target_kind text NOT NULL CHECK(target_kind IN ('contribution','artifact','summary')),
  target_id uuid NOT NULL,
  target_revision_id uuid NOT NULL,
  PRIMARY KEY(revision_id,target_id,target_revision_id),
  FOREIGN KEY(target_id,target_revision_id) REFERENCES loom.revisions(resource_id,id)
);
CREATE INDEX change_account_incoming ON loom.change_account_members(target_id,revision_id,target_revision_id);
CREATE INDEX note_discovery ON loom.revision_change_notes(source_id,revision_id);
CREATE FUNCTION loom.check_change_member() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,loom AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM loom.revisions WHERE id=NEW.revision_id AND content_format='loom-markdown-v3')
    OR NOT EXISTS(SELECT 1 FROM loom.resources r JOIN loom.revisions v ON v.resource_id=r.id
      WHERE r.id=NEW.target_id AND r.kind=NEW.target_kind AND v.id=NEW.target_revision_id
        AND v.content_format IN ('loom-markdown-v1','loom-markdown-v2','loom-markdown-v3')
        AND CASE r.kind WHEN 'contribution' THEN EXISTS(SELECT 1 FROM loom.contributions WHERE id=r.id)
          WHEN 'artifact' THEN EXISTS(SELECT 1 FROM loom.artifacts WHERE id=r.id)
          WHEN 'summary' THEN EXISTS(SELECT 1 FROM loom.summaries WHERE id=r.id) ELSE false END)
  THEN RAISE EXCEPTION 'Invalid change coverage' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER change_member BEFORE INSERT ON loom.change_account_members FOR EACH ROW EXECUTE FUNCTION loom.check_change_member();
-- Defer cardinality until the members have been inserted in the same publication.
CREATE FUNCTION loom.check_change_set() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,loom AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM loom.revisions WHERE id=NEW.revision_id AND content_format='loom-markdown-v3')
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
CREATE CONSTRAINT TRIGGER change_set AFTER INSERT ON loom.change_account_sets DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION loom.check_change_set();
REVOKE UPDATE,DELETE ON loom.change_account_sets,loom.change_account_members FROM loom_app;

-- Search remains one document per resource, with an identifiable note field.
ALTER TABLE loom.search_documents ADD COLUMN note_text text NOT NULL DEFAULT '' CHECK(octet_length(note_text)<=4096);
ALTER TABLE loom.search_documents ADD COLUMN note_document tsvector NOT NULL DEFAULT ''::tsvector;
