-- Lessons written by reflection or failure mining wait for a human (POL-10): 'pending' until accepted, 'discarded' when a
-- person declines or supersedes them. The active version is the latest 'accepted' one; existing versions stay active.
ALTER TABLE lessons ADD COLUMN state TEXT NOT NULL DEFAULT 'accepted' CHECK (state IN ('accepted', 'pending', 'discarded'));
