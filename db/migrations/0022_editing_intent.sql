-- Advisory coordination has no content/event/private-reading side effects.
CREATE TABLE loom.editing_intent_state (
  id integer PRIMARY KEY CHECK(id=1),
  notices integer NOT NULL DEFAULT 0 CHECK(notices BETWEEN 0 AND 4096),
  decisions integer NOT NULL DEFAULT 0 CHECK(decisions BETWEEN 0 AND 10000)
);
INSERT INTO loom.editing_intent_state(id) VALUES(1);
REVOKE ALL ON loom.editing_intent_state FROM loom_app;
GRANT SELECT, UPDATE(notices,decisions) ON loom.editing_intent_state TO loom_app;

CREATE TABLE loom.editing_notices (
  id uuid PRIMARY KEY,
  participant_id uuid NOT NULL REFERENCES loom.participants(id),
  resource_id uuid NOT NULL REFERENCES loom.resources(id),
  base_revision_id uuid NOT NULL,
  purpose text NOT NULL CHECK(octet_length(purpose) BETWEEN 1 AND 512),
  scope_kind text NOT NULL CHECK(scope_kind IN ('whole','described')),
  scope_description text CHECK(octet_length(scope_description) BETWEEN 1 AND 256),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  released_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK(version>0),
  CHECK((scope_kind='whole' AND scope_description IS NULL) OR (scope_kind='described' AND scope_description IS NOT NULL)),
  FOREIGN KEY(resource_id,base_revision_id) REFERENCES loom.revisions(resource_id,id)
);
CREATE INDEX editing_notice_resource ON loom.editing_notices(resource_id,id);
CREATE INDEX editing_notice_owner ON loom.editing_notices(participant_id,resource_id);
REVOKE ALL ON loom.editing_notices FROM loom_app;
GRANT SELECT, INSERT, UPDATE(expires_at,released_at,version) ON loom.editing_notices TO loom_app;

CREATE TABLE loom.editing_intent_operations (
  id uuid PRIMARY KEY,
  participant_id uuid NOT NULL REFERENCES loom.participants(id),
  action text NOT NULL CHECK(action IN ('announce','renew','release')),
  idempotency_key uuid NOT NULL,
  semantic_version text NOT NULL CHECK(semantic_version='editing-intent-1'),
  request_digest text NOT NULL CHECK(length(request_digest)=64),
  notice_id uuid NOT NULL REFERENCES loom.editing_notices(id),
  result_version integer NOT NULL CHECK(result_version>0),
  accepted_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  released_at timestamptz,
  UNIQUE(participant_id,action,idempotency_key)
);
-- One reserved terminal transition per admitted notice, independent of the
-- general decision cap. Expiry consumes no record or worker capacity.
CREATE UNIQUE INDEX editing_intent_one_release ON loom.editing_intent_operations(notice_id) WHERE action='release';
REVOKE ALL ON loom.editing_intent_operations FROM loom_app;
GRANT SELECT, INSERT ON loom.editing_intent_operations TO loom_app;
