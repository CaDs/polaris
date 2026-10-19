-- M12: a run's latest run_metrics event (ticket view, GET /api/runs/:id/metrics, GET /api/metrics) via MAX(seq) by type.
CREATE INDEX IF NOT EXISTS events_run_type ON events(run_id, type);
