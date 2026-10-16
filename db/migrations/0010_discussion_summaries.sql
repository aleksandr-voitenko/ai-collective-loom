-- Canonical summaries and declared revision sets. No invented coverage/backfill.
CREATE TABLE loom.summaries (
  id uuid PRIMARY KEY REFERENCES loom.resources(id),
  discussion_id uuid NOT NULL UNIQUE REFERENCES loom.discussions(id),
  UNIQUE (id,discussion_id)
);
CREATE FUNCTION loom.check_summary_owner() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,loom AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM loom.resources WHERE id=NEW.id AND kind='summary' AND owner_resource_id=NEW.discussion_id)
  THEN RAISE EXCEPTION 'Invalid summary owner' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER summary_owner BEFORE INSERT ON loom.summaries FOR EACH ROW EXECUTE FUNCTION loom.check_summary_owner();

-- Headers are retained retry tombstones after member expiry. No body archive.
CREATE TABLE loom.summary_preparations (
  id uuid PRIMARY KEY,
  participant_id uuid NOT NULL REFERENCES loom.participants(id),
  idempotency_key uuid NOT NULL,
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  discussion_id uuid NOT NULL REFERENCES loom.discussions(id),
  scope text NOT NULL CHECK (scope IN ('full','selected')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '24 hours',
  expired boolean NOT NULL DEFAULT false,
  UNIQUE (participant_id,idempotency_key),
  UNIQUE (id,discussion_id)
);
CREATE INDEX summary_preparation_owner_expiry ON loom.summary_preparations(participant_id,expires_at);
CREATE FUNCTION loom.keep_summary_expiry() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,loom AS $$
BEGIN
  IF OLD.expired AND NOT NEW.expired THEN RAISE EXCEPTION 'Preparation expiry is irreversible' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER summary_expiry BEFORE UPDATE OF expired ON loom.summary_preparations FOR EACH ROW EXECUTE FUNCTION loom.keep_summary_expiry();
CREATE TABLE loom.summary_preparation_members (
  preparation_id uuid NOT NULL,
  discussion_id uuid NOT NULL,
  contribution_id uuid NOT NULL,
  source_revision_id uuid NOT NULL,
  PRIMARY KEY (preparation_id,contribution_id),
  FOREIGN KEY (preparation_id,discussion_id) REFERENCES loom.summary_preparations(id,discussion_id),
  FOREIGN KEY (discussion_id,contribution_id) REFERENCES loom.contributions(discussion_id,id),
  FOREIGN KEY (contribution_id,source_revision_id) REFERENCES loom.revisions(resource_id,id)
);
CREATE TABLE loom.summary_coverage_sets (
  revision_id uuid PRIMARY KEY,
  summary_id uuid NOT NULL,
  discussion_id uuid NOT NULL,
  scope text NOT NULL CHECK (scope IN ('full','selected')),
  preparation_id uuid REFERENCES loom.summary_preparations(id),
  carried_from_revision_id uuid,
  UNIQUE (revision_id,discussion_id),
  UNIQUE (summary_id,revision_id),
  FOREIGN KEY (summary_id,discussion_id) REFERENCES loom.summaries(id,discussion_id),
  FOREIGN KEY (summary_id,revision_id) REFERENCES loom.revisions(resource_id,id),
  FOREIGN KEY (summary_id,carried_from_revision_id) REFERENCES loom.summary_coverage_sets(summary_id,revision_id),
  CHECK ((preparation_id IS NULL) <> (carried_from_revision_id IS NULL))
);
CREATE TABLE loom.summary_coverage_members (
  revision_id uuid NOT NULL,
  discussion_id uuid NOT NULL,
  contribution_id uuid NOT NULL,
  source_revision_id uuid NOT NULL,
  PRIMARY KEY (revision_id,contribution_id),
  FOREIGN KEY (revision_id,discussion_id) REFERENCES loom.summary_coverage_sets(revision_id,discussion_id),
  FOREIGN KEY (discussion_id,contribution_id) REFERENCES loom.contributions(discussion_id,id),
  FOREIGN KEY (contribution_id,source_revision_id) REFERENCES loom.revisions(resource_id,id)
);
CREATE FUNCTION loom.check_summary_publication() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,loom AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM loom.summaries WHERE id=NEW.resource_id)
    AND NOT EXISTS(SELECT 1 FROM loom.summary_coverage_sets WHERE revision_id=NEW.id AND summary_id=NEW.resource_id)
  THEN RAISE EXCEPTION 'Summary revision requires coverage' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END
$$;
CREATE CONSTRAINT TRIGGER summary_publication AFTER INSERT ON loom.revisions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION loom.check_summary_publication();
CREATE FUNCTION loom.check_summary_creation() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,loom AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM loom.resources r JOIN loom.summary_coverage_sets s ON s.revision_id=r.current_revision_id
    JOIN loom.resource_editors e ON e.resource_id=r.id AND e.participant_id=r.original_author_id
    WHERE r.id=NEW.id AND s.summary_id=r.id)
  THEN RAISE EXCEPTION 'Incomplete initial summary' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END
$$;
CREATE CONSTRAINT TRIGGER summary_creation AFTER INSERT ON loom.summaries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION loom.check_summary_creation();
REVOKE UPDATE,DELETE ON loom.summaries,loom.summary_preparations,loom.summary_coverage_sets,loom.summary_coverage_members FROM loom_app;
GRANT UPDATE(expired) ON loom.summary_preparations TO loom_app;
REVOKE UPDATE ON loom.summary_preparation_members FROM loom_app;

-- Independent editor/account invalidation; source/visibility/placement versions
-- already have their own transactional owners. This is not public source activity.
CREATE TABLE loom.summary_state (id smallint PRIMARY KEY CHECK (id=1), version bigint NOT NULL DEFAULT 0);
INSERT INTO loom.summary_state(id) VALUES (1);
REVOKE INSERT,DELETE ON loom.summary_state FROM loom_app;
CREATE FUNCTION loom.invalidate_summary_editors() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,loom AS $$
BEGIN
  UPDATE loom.summary_state SET version=version+1 WHERE id=1;
  RETURN NULL;
END
$$;
CREATE TRIGGER summary_editor_change AFTER INSERT OR DELETE ON loom.resource_editors
  FOR EACH STATEMENT EXECUTE FUNCTION loom.invalidate_summary_editors();
CREATE TRIGGER summary_account_change AFTER UPDATE OF state,role ON loom.participants
  FOR EACH STATEMENT EXECUTE FUNCTION loom.invalidate_summary_editors();

ALTER TABLE loom.revision_references DROP CONSTRAINT revision_references_target_kind_check;
ALTER TABLE loom.revision_references ADD CONSTRAINT revision_references_target_kind_check
  CHECK(target_kind IN ('discussion','contribution','artifact','summary'));
CREATE OR REPLACE FUNCTION loom.check_reference_membership() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,loom AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM loom.revisions v JOIN loom.resources r ON r.id=v.resource_id
    WHERE v.id=NEW.revision_id AND v.resource_id=NEW.source_id AND v.content_format='loom-markdown-v2'
    AND ((r.kind='contribution' AND EXISTS(SELECT 1 FROM loom.contributions WHERE id=r.id))
      OR (r.kind='artifact' AND EXISTS(SELECT 1 FROM loom.artifacts WHERE id=r.id))
      OR (r.kind='summary' AND EXISTS(SELECT 1 FROM loom.summaries WHERE id=r.id))))
    OR NOT EXISTS (SELECT 1 FROM loom.resources r WHERE r.id=NEW.target_id AND r.kind=NEW.target_kind
      AND CASE r.kind WHEN 'discussion' THEN EXISTS(SELECT 1 FROM loom.discussions WHERE id=r.id)
        WHEN 'contribution' THEN EXISTS(SELECT 1 FROM loom.contributions WHERE id=r.id)
        WHEN 'artifact' THEN EXISTS(SELECT 1 FROM loom.artifacts WHERE id=r.id)
        WHEN 'summary' THEN EXISTS(SELECT 1 FROM loom.summaries WHERE id=r.id) ELSE false END)
  THEN RAISE EXCEPTION 'Invalid reference membership' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END
$$;
