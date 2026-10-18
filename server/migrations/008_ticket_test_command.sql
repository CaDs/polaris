-- M8: a ticket may override the workspace test_command for its own test gate. NULL = fall back to the workspace command.
ALTER TABLE tickets ADD COLUMN test_command TEXT;
