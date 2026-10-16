-- Independent derived consumer. No source, intent, search progress or retry bytes
-- are rewritten. Cursor custody survives ordinary API process restarts.
CREATE TABLE loom.notification_state (
  id smallint PRIMARY KEY CHECK(id=1),
  cursor_key bytea NOT NULL DEFAULT sha256(uuid_send(gen_random_uuid()) || uuid_send(gen_random_uuid())) CHECK(octet_length(cursor_key)=32),
  recovery_epoch uuid NOT NULL DEFAULT gen_random_uuid(),
  visibility_version bigint NOT NULL DEFAULT 0,
  source_after uuid,
  revision_after bigint NOT NULL DEFAULT 0,
  scan_complete boolean NOT NULL DEFAULT false,
  event_after bigint NOT NULL DEFAULT 0,
  event_after_intent uuid,
  heartbeat_at timestamptz,
  capacity_limited boolean NOT NULL DEFAULT false,
  discovery_generation integer NOT NULL DEFAULT 1 CHECK(discovery_generation>0)
);
INSERT INTO loom.notification_state(id) VALUES(1);
REVOKE INSERT,DELETE ON loom.notification_state FROM loom_app;

CREATE TABLE loom.notification_reply_facts (
  reply_id uuid PRIMARY KEY REFERENCES loom.contributions(id),
  recipient_id uuid NOT NULL REFERENCES loom.participants(id),
  eligible boolean NOT NULL
);
REVOKE UPDATE,DELETE ON loom.notification_reply_facts FROM loom_app;

CREATE TABLE loom.notification_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  resource_id uuid REFERENCES loom.resources(id),
  revision_id uuid,
  revision_number bigint,
  source_event_id uuid REFERENCES loom.shared_activity(id),
  source_intent_id uuid,
  kind text NOT NULL CHECK(kind IN ('revision','organization','unsupported','internal')),
  state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','running','succeeded','failed')),
  outcome text CHECK(outcome IN ('projected','projected_with_gap','already_projected','not_applicable')),
  claim_generation integer NOT NULL DEFAULT 0 CHECK(claim_generation>=0),
  owner uuid,
  lease_until timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 3),
  due_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  failure text CHECK(failure IN ('unsupported_event','unsupported_source','malformed_source','source_limit','missing_predecessor','predecessor_pending','processing_failed','lease_expired','delivery_limit')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  FOREIGN KEY(resource_id,revision_id) REFERENCES loom.revisions(resource_id,id),
  FOREIGN KEY(source_event_id,source_intent_id) REFERENCES loom.outbox_intents(source_event_id,id),
  CHECK(revision_id IS NOT NULL OR source_event_id IS NOT NULL),
  CHECK(kind<>'revision' OR revision_number>0),
  CHECK((state='running')=(owner IS NOT NULL AND lease_until IS NOT NULL))
);
CREATE UNIQUE INDEX notification_revision_work ON loom.notification_jobs(revision_id) WHERE kind='revision';
CREATE UNIQUE INDEX notification_intent_work ON loom.notification_jobs(source_intent_id) WHERE source_intent_id IS NOT NULL;
CREATE INDEX notification_due_work ON loom.notification_jobs(state,due_at,lease_until,revision_number,id);
REVOKE DELETE ON loom.notification_jobs FROM loom_app;

CREATE TABLE loom.notification_projection_heads (
  resource_id uuid PRIMARY KEY REFERENCES loom.resources(id),
  revision_number bigint NOT NULL DEFAULT 0,
  revision_id uuid,
  incomplete boolean NOT NULL DEFAULT false,
  FOREIGN KEY(resource_id,revision_id) REFERENCES loom.revisions(resource_id,id)
);
CREATE TABLE loom.notification_gaps (
  revision_id uuid PRIMARY KEY REFERENCES loom.revisions(id),
  job_id uuid NOT NULL REFERENCES loom.notification_jobs(id),
  reason text NOT NULL CHECK(reason='historical_reply_eligibility_unknown')
);
REVOKE UPDATE,DELETE ON loom.notification_gaps FROM loom_app;

CREATE TABLE loom.notification_signals (
  id uuid PRIMARY KEY,
  recipient_id uuid NOT NULL REFERENCES loom.participants(id),
  resource_id uuid NOT NULL,
  revision_id uuid NOT NULL,
  source_event_id uuid NOT NULL REFERENCES loom.shared_activity(id),
  job_id uuid NOT NULL REFERENCES loom.notification_jobs(id),
  UNIQUE(recipient_id,revision_id),
  UNIQUE(recipient_id,id),
  FOREIGN KEY(resource_id,revision_id) REFERENCES loom.revisions(resource_id,id)
);
CREATE TABLE loom.notification_claims (
  recipient_id uuid NOT NULL REFERENCES loom.participants(id),
  resource_id uuid NOT NULL REFERENCES loom.resources(id),
  kind text NOT NULL CHECK(kind IN ('main_mention','direct_reply','note_mention')),
  note_revision_id uuid REFERENCES loom.revisions(id),
  signal_id uuid,
  source_field text NOT NULL CHECK(source_field IN ('main','reply','change_note')),
  UNIQUE NULLS NOT DISTINCT(recipient_id,resource_id,kind,note_revision_id),
  FOREIGN KEY(recipient_id,signal_id) REFERENCES loom.notification_signals(recipient_id,id),
  CHECK((kind='note_mention')=(note_revision_id IS NOT NULL)),
  CHECK((kind='main_mention' AND source_field='main') OR (kind='direct_reply' AND source_field='reply') OR (kind='note_mention' AND source_field='change_note'))
);
CREATE INDEX notification_signal_reasons ON loom.notification_claims(signal_id);
CREATE TABLE loom.participant_delivery_clocks (
  participant_id uuid PRIMARY KEY REFERENCES loom.participants(id),
  position bigint NOT NULL DEFAULT 0 CHECK(position BETWEEN 0 AND 50000),
  retained_after bigint NOT NULL DEFAULT 0 CHECK(retained_after>=0 AND retained_after<=position)
);
CREATE TABLE loom.personal_deliveries (
  id uuid PRIMARY KEY,
  recipient_id uuid NOT NULL,
  position bigint NOT NULL CHECK(position>0),
  signal_id uuid NOT NULL UNIQUE,
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(recipient_id,position),
  FOREIGN KEY(recipient_id,signal_id) REFERENCES loom.notification_signals(recipient_id,id)
);
REVOKE UPDATE,DELETE ON loom.notification_claims,loom.notification_signals,loom.personal_deliveries FROM loom_app;
REVOKE DELETE ON loom.notification_projection_heads,loom.participant_delivery_clocks FROM loom_app;

-- This is a shared-content control, never a source publication or a personal
-- receipt. Both guard orders preserve independent child/owner restrictions.
CREATE FUNCTION loom.invalidate_notification_visibility() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,loom AS $$
BEGIN
  UPDATE loom.notification_state SET visibility_version=visibility_version+1 WHERE id=1;
  RETURN NEW;
END
$$;
CREATE TRIGGER resource_notification_visibility AFTER UPDATE OF state ON loom.resources
  FOR EACH ROW WHEN(OLD.state IS DISTINCT FROM NEW.state)
  EXECUTE FUNCTION loom.invalidate_notification_visibility();
CREATE TRIGGER revision_notification_visibility AFTER UPDATE OF availability ON loom.revisions
  FOR EACH ROW WHEN(OLD.availability IS DISTINCT FROM NEW.availability)
  EXECUTE FUNCTION loom.invalidate_notification_visibility();
