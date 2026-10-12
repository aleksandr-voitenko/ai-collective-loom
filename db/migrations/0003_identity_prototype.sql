-- Additive identity envelopes. No accounts, secrets or bootstrap capability are seeded.
ALTER TABLE loom.participants
  ADD COLUMN kind text NOT NULL DEFAULT 'internal' CHECK (kind IN ('internal', 'human', 'agent')),
  ADD COLUMN nickname text;
ALTER TABLE loom.participant_credentials
  ADD COLUMN kind text NOT NULL DEFAULT 'internal' CHECK (kind IN ('internal', 'agent', 'passkey', 'session', 'enrollment')),
  ADD COLUMN label text,
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  ADD COLUMN verifier text CHECK (verifier ~ '^[0-9a-f]{64}$'),
  ADD COLUMN expires_at timestamptz,
  ADD COLUMN parent_credential_id uuid,
  ADD CONSTRAINT credential_participant_identity UNIQUE (participant_id, id),
  ADD CONSTRAINT credential_parent FOREIGN KEY (participant_id, parent_credential_id)
    REFERENCES loom.participant_credentials(participant_id, id),
  ADD CONSTRAINT credential_material CHECK (
    (kind = 'internal' AND verifier IS NULL AND expires_at IS NULL AND parent_credential_id IS NULL)
    OR (kind = 'passkey' AND verifier IS NULL AND expires_at IS NULL AND parent_credential_id IS NULL AND label IS NOT NULL)
    OR (kind IN ('agent', 'session', 'enrollment') AND verifier IS NOT NULL AND expires_at IS NOT NULL AND label IS NOT NULL
      AND ((kind = 'session') = (parent_credential_id IS NOT NULL)))
  );
CREATE INDEX credential_owner_kind ON loom.participant_credentials(participant_id, kind);
CREATE TABLE loom.nickname_reservations (
  normalized text PRIMARY KEY CHECK (normalized ~ '^[a-z][a-z0-9_-]{2,31}$'),
  participant_id uuid NOT NULL REFERENCES loom.participants(id),
  reserved_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE loom.identity_initialization (
  id smallint PRIMARY KEY CHECK (id = 1),
  administrator_id uuid NOT NULL REFERENCES loom.participants(id),
  bootstrap_verifier text NOT NULL CHECK (bootstrap_verifier ~ '^[0-9a-f]{64}$'),
  recovery_verifier text NOT NULL CHECK (recovery_verifier ~ '^[0-9a-f]{64}$')
);
CREATE TABLE loom.identity_outcomes (
  id uuid PRIMARY KEY,
  attempt_scope uuid NOT NULL,
  actor_id uuid REFERENCES loom.participants(id),
  operation_kind text NOT NULL,
  idempotency_key uuid NOT NULL,
  semantic_version text NOT NULL CHECK (semantic_version = 'identity-prototype-v1'),
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  participant_id uuid NOT NULL REFERENCES loom.participants(id),
  credential_id uuid,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (attempt_scope, operation_kind, idempotency_key),
  FOREIGN KEY (participant_id, credential_id) REFERENCES loom.participant_credentials(participant_id, id),
  CHECK (actor_id IS NULL OR actor_id = attempt_scope)
);
CREATE TABLE loom.administrative_audit (
  id uuid PRIMARY KEY,
  actor_id uuid REFERENCES loom.participants(id),
  actor_credential_id uuid,
  authority text NOT NULL CHECK (authority IN ('administrator', 'deployment_bootstrap', 'deployment_recovery')),
  target_id uuid NOT NULL REFERENCES loom.participants(id),
  action text NOT NULL,
  operation_id uuid NOT NULL REFERENCES loom.identity_outcomes(id),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (actor_id, actor_credential_id) REFERENCES loom.participant_credentials(participant_id, id),
  CHECK ((authority = 'administrator' AND actor_id IS NOT NULL AND actor_credential_id IS NOT NULL)
    OR (authority <> 'administrator' AND actor_id IS NULL AND actor_credential_id IS NULL))
);
CREATE TABLE loom.enrollment_tickets (
  credential_id uuid PRIMARY KEY REFERENCES loom.participant_credentials(id),
  purpose text NOT NULL CHECK (purpose IN ('enroll', 'recover'))
);
CREATE TABLE loom.passkeys (
  credential_id uuid PRIMARY KEY REFERENCES loom.participant_credentials(id),
  webauthn_id text NOT NULL UNIQUE,
  public_key bytea NOT NULL,
  counter bigint NOT NULL CHECK (counter >= 0),
  transports text[] NOT NULL,
  backup_eligible boolean NOT NULL,
  backed_up boolean NOT NULL,
  enrollment_credential_id uuid NOT NULL REFERENCES loom.enrollment_tickets(credential_id)
);
CREATE TABLE loom.webauthn_challenges (
  id uuid PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('register', 'authenticate')),
  challenge text NOT NULL,
  binding_verifier text NOT NULL CHECK (binding_verifier ~ '^[0-9a-f]{64}$'),
  ticket_id uuid REFERENCES loom.participant_credentials(id),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  CHECK ((kind = 'register') = (ticket_id IS NOT NULL))
);
REVOKE UPDATE, DELETE ON loom.nickname_reservations, loom.identity_initialization,
  loom.identity_outcomes, loom.administrative_audit FROM loom_app;
