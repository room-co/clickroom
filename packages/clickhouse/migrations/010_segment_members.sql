CREATE TABLE IF NOT EXISTS segment_members (
  project_id  String,
  segment_id  String,
  snapshot_id String,
  person_id   String,
  computed_at DateTime DEFAULT now()
) ENGINE = MergeTree
ORDER BY (project_id, segment_id, snapshot_id, person_id);
