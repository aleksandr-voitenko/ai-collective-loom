-- Synthetic policy candidates only. Windows and accounting identities are fixed.
CREATE TABLE loom.participation_rate_policy (
  id integer PRIMARY KEY CHECK (id = 1),
  version integer NOT NULL CHECK (version BETWEEN 1 AND 10001),
  ordinary_requests integer NOT NULL CHECK (ordinary_requests BETWEEN 1 AND 6000),
  new_publications integer NOT NULL CHECK (new_publications BETWEEN 1 AND 600),
  recovery_control integer NOT NULL CHECK (recovery_control BETWEEN 10 AND 1200)
);
INSERT INTO loom.participation_rate_policy VALUES (1, 1, 120, 20, 60);

-- At most three reusable rows per retained participant, never one row per request.
CREATE TABLE loom.participation_rate_windows (
  participant_id uuid NOT NULL REFERENCES loom.participants(id),
  category text NOT NULL CHECK (category IN ('ordinary_requests','new_publications','recovery_control')),
  window_started_at timestamptz NOT NULL,
  used integer NOT NULL CHECK (used BETWEEN 0 AND 6000),
  PRIMARY KEY (participant_id, category)
);

CREATE TABLE loom.participation_rate_decisions (
  id uuid PRIMARY KEY,
  actor_id uuid NOT NULL REFERENCES loom.participants(id),
  actor_credential_id uuid NOT NULL REFERENCES loom.participant_credentials(id),
  idempotency_key uuid NOT NULL,
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  expected_version integer NOT NULL CHECK (expected_version BETWEEN 1 AND 10000),
  version integer NOT NULL UNIQUE CHECK (version = expected_version + 1),
  ordinary_requests integer NOT NULL CHECK (ordinary_requests BETWEEN 1 AND 6000),
  new_publications integer NOT NULL CHECK (new_publications BETWEEN 1 AND 600),
  recovery_control integer NOT NULL CHECK (recovery_control BETWEEN 10 AND 1200),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (actor_id, idempotency_key)
);

REVOKE ALL ON loom.participation_rate_policy, loom.participation_rate_windows,
  loom.participation_rate_decisions FROM loom_app;
GRANT SELECT ON loom.participation_rate_policy, loom.participation_rate_windows,
  loom.participation_rate_decisions TO loom_app;
GRANT UPDATE (version, ordinary_requests, new_publications, recovery_control)
  ON loom.participation_rate_policy TO loom_app;
GRANT INSERT ON loom.participation_rate_windows, loom.participation_rate_decisions TO loom_app;
GRANT UPDATE (window_started_at, used) ON loom.participation_rate_windows TO loom_app;
