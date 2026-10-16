-- Advisory locks do not refresh an existing REPEATABLE READ snapshot. Every
-- successful custody creation/cleanup writes this row so stale creators retry.
CREATE TABLE loom.updates_custody_serialization (
  id smallint PRIMARY KEY CHECK(id=1),
  generation bigint NOT NULL DEFAULT 0 CHECK(generation>=0)
);
INSERT INTO loom.updates_custody_serialization(id) VALUES(1);
REVOKE INSERT,DELETE ON loom.updates_custody_serialization FROM loom_app;
