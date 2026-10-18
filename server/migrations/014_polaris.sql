-- The project is now Polaris: workspaces and frozen eval cases on the old default sandbox image move to the renamed one.
UPDATE workspace_settings SET image = 'polaris-sandbox:1' WHERE image = 'agent-harness-sandbox:1';
UPDATE eval_cases SET image = 'polaris-sandbox:1' WHERE image = 'agent-harness-sandbox:1';
