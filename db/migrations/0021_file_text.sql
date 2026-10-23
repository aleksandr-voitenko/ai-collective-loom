-- Controlled derivatives only. Publication rows, intents and native versions are unchanged.
CREATE TABLE loom.file_text_state (
  id integer PRIMARY KEY CHECK(id=1), generation integer NOT NULL DEFAULT 1,
  index_version bigint NOT NULL DEFAULT 0, heartbeat_at timestamptz,
  capacity_limited boolean NOT NULL DEFAULT false,
  retained_bytes bigint NOT NULL DEFAULT 0 CHECK(retained_bytes BETWEEN 0 AND 33554432),
  reserved_bytes bigint NOT NULL DEFAULT 0 CHECK(reserved_bytes>=0),
  CHECK(retained_bytes+reserved_bytes<=33554432)
);
INSERT INTO loom.file_text_state(id) VALUES(1);
CREATE TABLE loom.file_text_jobs (
  file_id uuid PRIMARY KEY REFERENCES loom.file_contexts(id), generation integer NOT NULL,
  state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','running','complete','partial','unsupported','failed')),
  claim_generation integer NOT NULL DEFAULT 0, owner uuid, lease_until timestamptz,
  attempts integer NOT NULL DEFAULT 0, due_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  reserved_bytes integer NOT NULL DEFAULT 0 CHECK(reserved_bytes BETWEEN 0 AND 65536), reason text,
  CHECK((state='running')=(owner IS NOT NULL AND lease_until IS NOT NULL))
);
CREATE INDEX file_text_due ON loom.file_text_jobs(generation,state,due_at,file_id);
CREATE TABLE loom.file_text_documents (
  file_id uuid PRIMARY KEY REFERENCES loom.file_contexts(id), generation integer NOT NULL,
  contract text NOT NULL CHECK(contract='literal-utf8-v1'),
  upload_id uuid NOT NULL REFERENCES loom.file_uploads(id), native_version text NOT NULL,
  sha256 text NOT NULL, original_bytes integer NOT NULL,
  state text NOT NULL CHECK(state IN ('complete','partial','unsupported')), reason text,
  body text NOT NULL CHECK(octet_length(body)<=65536), document tsvector NOT NULL
);
CREATE INDEX file_text_lexical ON loom.file_text_documents USING gin(document);
