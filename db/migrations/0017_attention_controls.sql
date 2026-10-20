-- Independent owner-private choices; no inference from existing personal state.
CREATE TABLE loom.attention_state (
  id smallint PRIMARY KEY CHECK(id=1),
  selection_key bytea NOT NULL CHECK(octet_length(selection_key)=32)
);
INSERT INTO loom.attention_state VALUES(1,
  decode(replace(gen_random_uuid()::text,'-','')||replace(gen_random_uuid()::text,'-',''),'hex'));
REVOKE INSERT,UPDATE,DELETE ON loom.attention_state FROM loom_app;
CREATE TABLE loom.attention_owners (
  participant_id uuid PRIMARY KEY REFERENCES loom.participants(id),
  version integer NOT NULL DEFAULT 0 CHECK(version BETWEEN 0 AND 2147483646),
  mutes integer NOT NULL DEFAULT 0 CHECK(mutes BETWEEN 0 AND 500),
  active_mutes integer NOT NULL DEFAULT 0 CHECK(active_mutes BETWEEN 0 AND 64),
  inputs integer NOT NULL DEFAULT 0 CHECK(inputs BETWEEN 0 AND 10000),
  operations integer NOT NULL DEFAULT 0 CHECK(operations BETWEEN 0 AND 50000),
  members integer NOT NULL DEFAULT 0 CHECK(members BETWEEN 0 AND 100000)
);
CREATE TABLE loom.attention_mutes (
  participant_id uuid NOT NULL REFERENCES loom.participants(id),
  target_kind text NOT NULL CHECK(target_kind IN ('area','discussion','artifact')),
  resource_id uuid NOT NULL REFERENCES loom.resources(id),
  include_descendants boolean NOT NULL CHECK(target_kind='area' OR NOT include_descendants),
  muted boolean NOT NULL,
  version integer NOT NULL CHECK(version BETWEEN 1 AND 2147483646),
  PRIMARY KEY(participant_id,target_kind,resource_id)
);
CREATE TABLE loom.attention_dismissals (
  participant_id uuid NOT NULL REFERENCES loom.participants(id),
  input_kind text NOT NULL CHECK(input_kind IN ('shared_event','personal_delivery')),
  input_id uuid NOT NULL,
  dismissed boolean NOT NULL,
  version integer NOT NULL CHECK(version BETWEEN 1 AND 2147483646),
  PRIMARY KEY(participant_id,input_kind,input_id)
);
-- Source IDs intentionally have no FK: known private restoration survives source
-- history loss. New decisions validate current source and recipient authority.
CREATE TABLE loom.attention_operations (
  id uuid PRIMARY KEY,
  participant_id uuid NOT NULL REFERENCES loom.participants(id),
  idempotency_key uuid NOT NULL,
  semantic_version text NOT NULL CHECK(semantic_version='attention-controls-1'),
  kind text NOT NULL CHECK(kind IN ('mute','dismissal')),
  request_digest text NOT NULL CHECK(request_digest ~ '^[0-9a-f]{64}$'),
  decision text NOT NULL CHECK(decision IN ('applied','version_conflict')),
  outcome jsonb NOT NULL CHECK(jsonb_typeof(outcome)='object' AND octet_length(outcome::text)<=32768),
  UNIQUE(participant_id,idempotency_key)
);
REVOKE UPDATE,DELETE ON loom.attention_owners,loom.attention_mutes,loom.attention_dismissals,loom.attention_operations FROM loom_app;
GRANT UPDATE(version,mutes,active_mutes,inputs,operations,members) ON loom.attention_owners TO loom_app;
GRANT UPDATE(include_descendants,muted,version) ON loom.attention_mutes TO loom_app;
GRANT UPDATE(dismissed,version) ON loom.attention_dismissals TO loom_app;

-- Short-lived projection only. Confirmed choices/outcomes above never cascade.
CREATE TABLE loom.attention_views (
  view_id uuid PRIMARY KEY REFERENCES loom.updates_views(id) ON DELETE CASCADE,
  policy_version integer NOT NULL,
  scanned integer NOT NULL DEFAULT 0 CHECK(scanned BETWEEN 0 AND 2000),
  ready boolean NOT NULL DEFAULT false
);
CREATE TABLE loom.attention_members (
  view_id uuid NOT NULL,
  event_id uuid NOT NULL,
  shared boolean NOT NULL,
  personal boolean NOT NULL,
  PRIMARY KEY(view_id,event_id),
  FOREIGN KEY(view_id,event_id) REFERENCES loom.updates_members(view_id,event_id) ON DELETE CASCADE
);
CREATE TABLE loom.attention_groups (
  view_id uuid NOT NULL,
  group_id uuid NOT NULL,
  visible boolean NOT NULL,
  direct boolean NOT NULL,
  highlighted boolean NOT NULL,
  PRIMARY KEY(view_id,group_id),
  FOREIGN KEY(view_id,group_id) REFERENCES loom.updates_groups(view_id,id) ON DELETE CASCADE
);
