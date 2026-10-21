-- Immutable bytes, owner custody and revision contexts have distinct lifetimes.
CREATE TABLE loom.file_uploads (
  id uuid PRIMARY KEY,
  participant_id uuid NOT NULL REFERENCES loom.participants(id),
  idempotency_key uuid NOT NULL,
  request_digest text NOT NULL CHECK (length(request_digest)=64),
  target_kind text NOT NULL CHECK(target_kind IN ('area','artifact')),
  target_id uuid NOT NULL REFERENCES loom.resources(id),
  path text NOT NULL,
  size integer NOT NULL CHECK(size BETWEEN 0 AND 4194304),
  sha256 text NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'),
  media_type text NOT NULL,
  state text NOT NULL DEFAULT 'waiting' CHECK(state IN ('waiting','uploading','staged','finalizing','prepared','cleaning','expired','quarantined')),
  stage_version text,
  final_version text,
  lease_until timestamptz,
  upload_expires_at timestamptz NOT NULL DEFAULT(clock_timestamp()+interval '1 hour'),
  prepared_expires_at timestamptz NOT NULL DEFAULT(clock_timestamp()+interval '24 hours'),
  reserved boolean NOT NULL DEFAULT true,
  UNIQUE(participant_id,idempotency_key)
);
CREATE INDEX file_upload_owner ON loom.file_uploads(participant_id,state);
CREATE INDEX file_upload_expiry ON loom.file_uploads(prepared_expires_at,id) WHERE reserved;
CREATE TABLE loom.artifact_file_sets (
  revision_id uuid PRIMARY KEY,
  artifact_id uuid NOT NULL REFERENCES loom.artifacts(id),
  version text NOT NULL CHECK(version='artifact-files-v1'),
  UNIQUE(artifact_id,revision_id),
  FOREIGN KEY(artifact_id,revision_id) REFERENCES loom.revisions(resource_id,id)
);
CREATE TABLE loom.file_contexts (
  id uuid PRIMARY KEY,
  artifact_id uuid NOT NULL,
  revision_id uuid NOT NULL,
  path text NOT NULL,
  upload_id uuid NOT NULL REFERENCES loom.file_uploads(id),
  reused_from uuid REFERENCES loom.file_contexts(id),
  UNIQUE(revision_id,path),
  UNIQUE(artifact_id,revision_id,id),
  FOREIGN KEY(artifact_id,revision_id) REFERENCES loom.artifact_file_sets(artifact_id,revision_id)
);
CREATE INDEX file_context_upload ON loom.file_contexts(upload_id);
CREATE TABLE loom.file_publication_refusals (
  participant_id uuid NOT NULL REFERENCES loom.participants(id),
  operation_kind text NOT NULL,
  idempotency_key uuid NOT NULL,
  request_digest text NOT NULL,
  PRIMARY KEY(participant_id,operation_kind,idempotency_key)
);
REVOKE UPDATE,DELETE ON loom.file_publication_refusals FROM loom_app;
REVOKE UPDATE,DELETE ON loom.file_uploads,loom.artifact_file_sets,loom.file_contexts FROM loom_app;
GRANT UPDATE(state,stage_version,final_version,lease_until,reserved) ON loom.file_uploads TO loom_app;

-- Replace the original prose-only invariant with the product's text-or-files
-- invariant. Deferred validation sees the complete atomic manifest at COMMIT.
ALTER TABLE loom.revisions DROP CONSTRAINT revisions_content_text_check;
ALTER TABLE loom.revisions ADD CONSTRAINT revisions_content_text_check
  CHECK(length(content_text)>0 OR content_format='loom-markdown-v3');
CREATE FUNCTION loom.check_file_only_revision() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,loom AS $$
BEGIN
  IF length(NEW.content_text)=0 AND NOT EXISTS(
    SELECT 1 FROM loom.file_contexts f WHERE f.artifact_id=NEW.resource_id AND f.revision_id=NEW.id
  ) THEN RAISE EXCEPTION 'Empty revision requires an artifact file' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END
$$;
CREATE CONSTRAINT TRIGGER file_only_revision AFTER INSERT ON loom.revisions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION loom.check_file_only_revision();
CREATE FUNCTION loom.pin_file_versions() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,loom AS $$
BEGIN
  IF (OLD.stage_version IS NOT NULL AND NEW.stage_version IS DISTINCT FROM OLD.stage_version)
    OR (OLD.final_version IS NOT NULL AND NEW.final_version IS DISTINCT FROM OLD.final_version)
  THEN RAISE EXCEPTION 'Native file versions are immutable' USING ERRCODE='23514'; END IF;
  IF NEW.state IN ('cleaning','expired','quarantined') AND EXISTS(SELECT 1 FROM loom.file_contexts WHERE upload_id=NEW.id)
  THEN RAISE EXCEPTION 'Published file lifetime is retained' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER pin_file_versions BEFORE UPDATE ON loom.file_uploads
  FOR EACH ROW EXECUTE FUNCTION loom.pin_file_versions();
