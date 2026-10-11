-- Bootstrap the application's empty schema and future runtime table grants.
-- No account, role-policy, content, event, or idempotency schema is implied here.
COMMENT ON SCHEMA loom IS 'AI Collective Loom application-owned records';
ALTER DEFAULT PRIVILEGES FOR ROLE loom_migrator IN SCHEMA loom
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO loom_app;
ALTER DEFAULT PRIVILEGES FOR ROLE loom_migrator IN SCHEMA loom
  GRANT USAGE, SELECT ON SEQUENCES TO loom_app;
