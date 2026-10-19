-- A ticket's own test gate; NULL = use the workspace test_command.
ALTER TABLE tickets ADD COLUMN test_command TEXT;
