-- Prospective admission only. Existing upload custody is the reservation ledger.
CREATE TABLE loom.file_admission_policy (
  id integer PRIMARY KEY CHECK (id = 1),
  version integer NOT NULL CHECK (version BETWEEN 1 AND 10001),
  max_file_bytes integer NOT NULL CHECK (max_file_bytes BETWEEN 1 AND 4194304),
  max_unfinished_uploads integer NOT NULL CHECK (max_unfinished_uploads BETWEEN 1 AND 4),
  participant_reserved_bytes integer NOT NULL CHECK (participant_reserved_bytes BETWEEN 1 AND 67108864),
  community_reserved_bytes integer NOT NULL CHECK (community_reserved_bytes BETWEEN 1 AND 268435456)
);
INSERT INTO loom.file_admission_policy VALUES (1, 1, 4194304, 4, 67108864, 268435456);

CREATE TABLE loom.file_policy_decisions (
  id uuid PRIMARY KEY,
  actor_id uuid NOT NULL REFERENCES loom.participants(id),
  actor_credential_id uuid NOT NULL REFERENCES loom.participant_credentials(id),
  idempotency_key uuid NOT NULL,
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  expected_version integer NOT NULL CHECK (expected_version BETWEEN 1 AND 10000),
  version integer NOT NULL UNIQUE CHECK (version = expected_version + 1),
  max_file_bytes integer NOT NULL CHECK (max_file_bytes BETWEEN 1 AND 4194304),
  max_unfinished_uploads integer NOT NULL CHECK (max_unfinished_uploads BETWEEN 1 AND 4),
  participant_reserved_bytes integer NOT NULL CHECK (participant_reserved_bytes BETWEEN 1 AND 67108864),
  community_reserved_bytes integer NOT NULL CHECK (community_reserved_bytes BETWEEN 1 AND 268435456),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (actor_id, idempotency_key)
);
REVOKE ALL ON loom.file_admission_policy, loom.file_policy_decisions FROM loom_app;
GRANT SELECT ON loom.file_admission_policy, loom.file_policy_decisions TO loom_app;
GRANT UPDATE (version, max_file_bytes, max_unfinished_uploads, participant_reserved_bytes, community_reserved_bytes) ON loom.file_admission_policy TO loom_app;
GRANT INSERT ON loom.file_policy_decisions TO loom_app;
