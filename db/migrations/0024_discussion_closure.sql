-- Extend the existing immutable organization protocol without rewriting old
-- decisions, digests, local flags, versions or historical event scopes.
ALTER TABLE loom.organization_operations
  DROP CONSTRAINT organization_operations_operation_kind_check;
ALTER TABLE loom.organization_operations
  ADD CONSTRAINT organization_operations_operation_kind_check CHECK (
    operation_kind IN ('area.create','area.edit','area.move','discussion.move',
      'artifact.move','area.open','area.close','discussion.open','discussion.close'));
