-- Explicit v2 only: never infer assertions from old authored bytes or personal state.
ALTER TABLE loom.revisions DROP CONSTRAINT revisions_content_format_check;
ALTER TABLE loom.revisions ADD CONSTRAINT revisions_content_format_check
  CHECK (content_format IN ('text/plain','loom-markdown-v1','loom-markdown-v2'));

CREATE TABLE loom.revision_references (
  source_id uuid NOT NULL,
  revision_id uuid NOT NULL,
  reference_id uuid NOT NULL,
  target_kind text NOT NULL CHECK (target_kind IN ('discussion','contribution','artifact')),
  target_id uuid NOT NULL REFERENCES loom.resources(id),
  target_revision_id uuid,
  relationship text CHECK (relationship IN ('related_to','builds_on','contradicts')),
  rationale text CHECK (octet_length(rationale)<=512),
  origin_revision_id uuid NOT NULL,
  assertion_revision_id uuid NOT NULL,
  PRIMARY KEY (source_id,revision_id,reference_id),
  UNIQUE NULLS NOT DISTINCT (revision_id,target_id,target_revision_id),
  FOREIGN KEY (source_id,revision_id) REFERENCES loom.revisions(resource_id,id),
  FOREIGN KEY (target_id,target_revision_id) REFERENCES loom.revisions(resource_id,id),
  FOREIGN KEY (source_id,origin_revision_id,reference_id)
    REFERENCES loom.revision_references(source_id,revision_id,reference_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (source_id,assertion_revision_id,reference_id)
    REFERENCES loom.revision_references(source_id,revision_id,reference_id) DEFERRABLE INITIALLY DEFERRED,
  CHECK (target_kind<>'discussion' OR target_revision_id IS NULL),
  CHECK (relationship IS NULL OR relationship='related_to' OR length(btrim(rationale))>0 AND rationale IS NOT NULL)
);
CREATE INDEX reference_incoming ON loom.revision_references(target_id,target_revision_id,revision_id,reference_id);
CREATE INDEX reference_identity ON loom.revision_references(source_id,reference_id,revision_id);
CREATE FUNCTION loom.check_reference_membership() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,loom AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM loom.revisions v JOIN loom.resources r ON r.id=v.resource_id
    WHERE v.id=NEW.revision_id AND v.resource_id=NEW.source_id AND v.content_format='loom-markdown-v2'
    AND ((r.kind='contribution' AND EXISTS(SELECT 1 FROM loom.contributions WHERE id=r.id))
      OR (r.kind='artifact' AND EXISTS(SELECT 1 FROM loom.artifacts WHERE id=r.id))))
    OR NOT EXISTS (SELECT 1 FROM loom.resources r WHERE r.id=NEW.target_id AND r.kind=NEW.target_kind
      AND CASE r.kind WHEN 'discussion' THEN EXISTS(SELECT 1 FROM loom.discussions WHERE id=r.id)
        WHEN 'contribution' THEN EXISTS(SELECT 1 FROM loom.contributions WHERE id=r.id)
        WHEN 'artifact' THEN EXISTS(SELECT 1 FROM loom.artifacts WHERE id=r.id) ELSE false END)
  THEN RAISE EXCEPTION 'Invalid reference membership' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER reference_membership BEFORE INSERT ON loom.revision_references
  FOR EACH ROW EXECUTE FUNCTION loom.check_reference_membership();
REVOKE UPDATE,DELETE ON loom.revision_references FROM loom_app;

-- Withdrawal is a source revision change, with independent publisher attribution.
CREATE TABLE loom.reference_withdrawals (
  source_id uuid NOT NULL,
  revision_id uuid NOT NULL,
  revision_number bigint NOT NULL,
  reference_id uuid NOT NULL,
  prior_revision_id uuid NOT NULL,
  PRIMARY KEY (source_id,revision_id,reference_id),
  FOREIGN KEY (source_id,revision_id) REFERENCES loom.revisions(resource_id,id),
  FOREIGN KEY (source_id,prior_revision_id,reference_id)
    REFERENCES loom.revision_references(source_id,revision_id,reference_id)
);
CREATE INDEX reference_withdrawal_history ON loom.reference_withdrawals(source_id,reference_id,revision_number DESC);
CREATE FUNCTION loom.check_reference_withdrawal() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,loom AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM loom.revisions v JOIN loom.revisions prior ON prior.id=NEW.prior_revision_id
    WHERE v.id=NEW.revision_id AND v.resource_id=NEW.source_id AND v.content_format='loom-markdown-v2'
      AND v.revision_number=NEW.revision_number AND prior.resource_id=v.resource_id
      AND prior.revision_number=v.revision_number-1)
    OR EXISTS (SELECT 1 FROM loom.revision_references rr WHERE rr.source_id=NEW.source_id
      AND rr.revision_id=NEW.revision_id AND rr.reference_id=NEW.reference_id)
  THEN RAISE EXCEPTION 'Invalid reference withdrawal' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER reference_withdrawal BEFORE INSERT ON loom.reference_withdrawals
  FOR EACH ROW EXECUTE FUNCTION loom.check_reference_withdrawal();
REVOKE UPDATE,DELETE ON loom.reference_withdrawals FROM loom_app;
