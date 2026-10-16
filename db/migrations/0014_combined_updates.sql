-- Retrieval-only custody; source/publication/personal identities are untouched.
CREATE TABLE loom.updates_state (
  id smallint PRIMARY KEY CHECK(id=1),
  cursor_key bytea NOT NULL CHECK(octet_length(cursor_key)=32),
  recovery_epoch uuid NOT NULL
);
INSERT INTO loom.updates_state VALUES(1,
  decode(replace(gen_random_uuid()::text,'-','')||replace(gen_random_uuid()::text,'-',''),'hex'),gen_random_uuid());
REVOKE INSERT,UPDATE,DELETE ON loom.updates_state FROM loom_app;

CREATE TABLE loom.updates_views (
  id uuid PRIMARY KEY,
  participant_id uuid NOT NULL REFERENCES loom.participants(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  retain_until timestamptz NOT NULL DEFAULT clock_timestamp()+interval '7 days',
  shared_after bigint NOT NULL,
  personal_after bigint NOT NULL,
  steps integer NOT NULL DEFAULT 0 CHECK(steps BETWEEN 0 AND 1000),
  ready boolean NOT NULL DEFAULT false,
  unknown_shared boolean NOT NULL DEFAULT false
);
CREATE INDEX updates_views_owner ON loom.updates_views(participant_id,id);
CREATE INDEX updates_views_expiry ON loom.updates_views(retain_until,id);
CREATE TABLE loom.updates_members (
  view_id uuid NOT NULL REFERENCES loom.updates_views(id) ON DELETE CASCADE,
  event_id uuid NOT NULL,
  resource_id uuid NOT NULL,
  revision_id uuid,
  group_kind text NOT NULL CHECK(group_kind IN ('discussion','artifact','structural')),
  group_key uuid NOT NULL,
  shared boolean NOT NULL,
  delivery_id uuid,
  display_at timestamptz NOT NULL,
  PRIMARY KEY(view_id,event_id)
);
CREATE INDEX updates_members_group ON loom.updates_members(view_id,group_kind,group_key);
CREATE TABLE loom.updates_groups (
  view_id uuid NOT NULL REFERENCES loom.updates_views(id) ON DELETE CASCADE,
  id uuid NOT NULL,
  kind text NOT NULL CHECK(kind IN ('discussion','artifact','structural')),
  group_key uuid NOT NULL,
  ordinal integer NOT NULL CHECK(ordinal BETWEEN 1 AND 256),
  direct boolean NOT NULL,
  highlighted boolean NOT NULL,
  PRIMARY KEY(view_id,id),
  UNIQUE(view_id,kind,group_key),
  UNIQUE(view_id,ordinal)
);
