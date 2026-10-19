-- Spending caps (M12): per workspace per UTC calendar month, per ticket (an epic's covers its whole tree). NULL = no cap.
ALTER TABLE workspace_settings ADD COLUMN monthly_cap_usd REAL;
ALTER TABLE workspace_settings ADD COLUMN monthly_cap_tokens INTEGER;
ALTER TABLE tickets ADD COLUMN cap_usd REAL;
ALTER TABLE tickets ADD COLUMN cap_tokens INTEGER;
