-- Keep applied search history and output associations; distinguish intent work
-- from revision backfill so an unsupported intent cannot disappear in a collision.
ALTER TABLE loom.outbox_intents ADD CONSTRAINT outbox_event_intent UNIQUE (source_event_id,id);
ALTER TABLE loom.search_jobs ADD COLUMN source_intent_id uuid;
ALTER TABLE loom.search_jobs ADD CONSTRAINT search_intent_event
  FOREIGN KEY (source_event_id,source_intent_id) REFERENCES loom.outbox_intents(source_event_id,id);
ALTER TABLE loom.search_jobs ADD CONSTRAINT search_intent_has_event
  CHECK (source_intent_id IS NULL OR source_event_id IS NOT NULL);

-- Existing non-backfill jobs retain their ID, attempts and outcome. Under the
-- prior schema each recognized or unsupported pair identifies one intent.
UPDATE loom.search_jobs j SET source_intent_id=i.id
FROM loom.outbox_intents i JOIN loom.shared_activity e ON e.id=i.source_event_id
WHERE j.source_event_id=e.id AND (
  (j.kind='revision' AND e.kind='revision.published' AND i.kind='publication.project' AND e.revision_id IS NOT NULL) OR
  (j.kind='organization' AND e.kind='organization.changed' AND i.kind='organization.project' AND e.revision_id IS NULL) OR
  (j.kind='unsupported' AND NOT (
    (e.kind='revision.published' AND i.kind='publication.project' AND e.revision_id IS NOT NULL) OR
    (e.kind='organization.changed' AND i.kind='organization.project' AND e.revision_id IS NULL))));

DROP INDEX loom.search_revision_work;
DROP INDEX loom.search_event_work;
CREATE UNIQUE INDEX search_revision_work ON loom.search_jobs(generation,revision_id)
  WHERE kind='revision' AND revision_id IS NOT NULL;
CREATE UNIQUE INDEX search_intent_work ON loom.search_jobs(generation,source_intent_id)
  WHERE source_intent_id IS NOT NULL;
ALTER TABLE loom.search_state ADD COLUMN event_after_intent uuid REFERENCES loom.outbox_intents(id);
-- Replay bounded discovery to recover intents skipped by the old event-only
-- cursor. Existing revision/intent jobs deduplicate without resetting attempts.
UPDATE loom.search_state SET event_after=0,event_after_intent=NULL;
