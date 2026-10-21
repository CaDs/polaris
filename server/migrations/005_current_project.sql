-- The project each member is working in, per workspace (the sidebar's switcher): the default for the home page, new
-- tickets and new chats. Opening a project's page or creating a project makes it current.
CREATE TABLE current_projects (
  user_id      TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, workspace_id)
);
