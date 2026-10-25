-- Private invalidation versions, independent of publication and personal clocks.
CREATE TABLE loom.administration_collections (
  collection text PRIMARY KEY CHECK(collection IN ('accounts','credentials','audit')),
  version bigint NOT NULL DEFAULT 0 CHECK(version >= 0)
);
INSERT INTO loom.administration_collections(collection) VALUES ('accounts'),('credentials'),('audit');
REVOKE ALL ON loom.administration_collections FROM loom_app;
GRANT SELECT ON loom.administration_collections TO loom_app;
CREATE FUNCTION loom.invalidate_administration_collection() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  UPDATE loom.administration_collections SET version = version + 1 WHERE collection = TG_ARGV[0];
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION loom.invalidate_administration_collection() FROM PUBLIC;
CREATE TRIGGER administration_accounts AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON loom.participants
  FOR EACH STATEMENT EXECUTE FUNCTION loom.invalidate_administration_collection('accounts');
CREATE TRIGGER administration_credentials AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON loom.participant_credentials
  FOR EACH STATEMENT EXECUTE FUNCTION loom.invalidate_administration_collection('credentials');
CREATE TRIGGER administration_audit AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON loom.administrative_audit
  FOR EACH STATEMENT EXECUTE FUNCTION loom.invalidate_administration_collection('audit');
CREATE INDEX administration_accounts_order ON loom.participants(id) WHERE kind <> 'internal';
CREATE INDEX administration_nickname_lookup ON loom.participants(lower(nickname)) WHERE kind <> 'internal';
CREATE INDEX administration_credentials_order ON loom.participant_credentials(participant_id,id);
CREATE INDEX administration_audit_order ON loom.administrative_audit(recorded_at,id);
