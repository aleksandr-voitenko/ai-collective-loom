-- Add publication contexts without changing any old upload, version or outcome.
ALTER TABLE loom.file_uploads DROP CONSTRAINT file_uploads_target_kind_check;
ALTER TABLE loom.file_uploads ADD CONSTRAINT file_uploads_target_kind_check
  CHECK(target_kind IN ('area','artifact','opening','reply','contribution'));

CREATE TABLE loom.contribution_attachment_sets (
  revision_id uuid PRIMARY KEY,
  contribution_id uuid NOT NULL,
  discussion_id uuid NOT NULL,
  version text NOT NULL CHECK(version='contribution-attachments-v1'),
  UNIQUE(contribution_id,revision_id),
  FOREIGN KEY(contribution_id,discussion_id) REFERENCES loom.contributions(id,discussion_id),
  FOREIGN KEY(contribution_id,revision_id) REFERENCES loom.revisions(resource_id,id)
);
ALTER TABLE loom.file_contexts ALTER COLUMN artifact_id DROP NOT NULL;
ALTER TABLE loom.file_contexts ADD COLUMN contribution_id uuid;
ALTER TABLE loom.file_contexts ADD CONSTRAINT file_context_owner CHECK
  ((artifact_id IS NOT NULL)::integer+(contribution_id IS NOT NULL)::integer=1);
ALTER TABLE loom.file_contexts ADD CONSTRAINT file_context_contribution_set
  FOREIGN KEY(contribution_id,revision_id) REFERENCES loom.contribution_attachment_sets(contribution_id,revision_id);
ALTER TABLE loom.file_contexts ADD CONSTRAINT file_context_contribution_identity
  UNIQUE(contribution_id,revision_id,id);

CREATE TABLE loom.attachment_promotions (
  artifact_id uuid NOT NULL,
  revision_id uuid PRIMARY KEY,
  source_discussion_id uuid NOT NULL,
  source_contribution_id uuid NOT NULL,
  source_revision_id uuid NOT NULL,
  source_file_id uuid NOT NULL,
  contributor_id uuid NOT NULL REFERENCES loom.participants(id),
  revision_publisher_id uuid NOT NULL REFERENCES loom.participants(id),
  uploader_id uuid NOT NULL REFERENCES loom.participants(id),
  promoter_id uuid NOT NULL REFERENCES loom.participants(id),
  FOREIGN KEY(artifact_id,revision_id) REFERENCES loom.artifact_file_sets(artifact_id,revision_id),
  FOREIGN KEY(source_contribution_id,source_discussion_id) REFERENCES loom.contributions(id,discussion_id),
  FOREIGN KEY(source_contribution_id,source_revision_id,source_file_id)
    REFERENCES loom.file_contexts(contribution_id,revision_id,id)
);
REVOKE UPDATE,DELETE ON loom.contribution_attachment_sets,loom.attachment_promotions FROM loom_app;
-- file_contexts remains immutable. Its existing native-version lifetime trigger
-- already checks ALL contexts, including the added contribution ownership variant.
