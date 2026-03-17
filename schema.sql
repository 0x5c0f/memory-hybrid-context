PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS memory_records (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  l0_text TEXT,
  l1_text TEXT,
  l2_text TEXT,
  content_ref TEXT NOT NULL,
  raw_text TEXT,
  keywords_json TEXT NOT NULL DEFAULT '[]',
  embedding_json TEXT NOT NULL DEFAULT '[]',
  content_hash TEXT,
  embedding_version TEXT,
  vector_backend TEXT,
  index_status TEXT,
  indexed_at INTEGER,
  importance REAL NOT NULL DEFAULT 0.5,
  confidence REAL NOT NULL DEFAULT 0.5,
  session_id TEXT,
  source_path TEXT,
  start_line INTEGER,
  end_line INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_used_at INTEGER,
  expires_at INTEGER,
  expired_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_memory_scope ON memory_records(scope);
CREATE INDEX IF NOT EXISTS idx_memory_type ON memory_records(type);
CREATE INDEX IF NOT EXISTS idx_memory_status ON memory_records(status);
CREATE INDEX IF NOT EXISTS idx_memory_updated_at ON memory_records(updated_at DESC);

CREATE TABLE IF NOT EXISTS memory_relations (
  from_id TEXT NOT NULL,
  relation TEXT NOT NULL,
  to_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (from_id, relation, to_id),
  FOREIGN KEY (from_id) REFERENCES memory_records(id) ON DELETE CASCADE,
  FOREIGN KEY (to_id) REFERENCES memory_records(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS staging_candidates (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,
  raw_text TEXT NOT NULL,
  normalized_text TEXT NOT NULL,
  candidate_type TEXT,
  importance REAL NOT NULL DEFAULT 0.5,
  confidence REAL NOT NULL DEFAULT 0.5,
  source_message_ids_json TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_staging_session ON staging_candidates(session_id);
CREATE INDEX IF NOT EXISTS idx_staging_created_at ON staging_candidates(created_at DESC);

CREATE TABLE IF NOT EXISTS commit_log (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  archive_path TEXT,
  candidate_count INTEGER NOT NULL DEFAULT 0,
  inserted_count INTEGER NOT NULL DEFAULT 0,
  superseded_count INTEGER NOT NULL DEFAULT 0,
  committed_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS index_jobs (
  id TEXT PRIMARY KEY,
  record_id TEXT NOT NULL,
  job_type TEXT NOT NULL,
  backend TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at INTEGER,
  started_at INTEGER,
  completed_at INTEGER,
  last_error TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (record_id) REFERENCES memory_records(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_index_jobs_status ON index_jobs(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_index_jobs_record ON index_jobs(record_id);

CREATE TABLE IF NOT EXISTS index_failures (
  id TEXT PRIMARY KEY,
  job_id TEXT,
  record_id TEXT,
  backend TEXT,
  error_message TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  failed_at INTEGER NOT NULL,
  FOREIGN KEY (job_id) REFERENCES index_jobs(id) ON DELETE SET NULL,
  FOREIGN KEY (record_id) REFERENCES memory_records(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_index_failures_failed_at ON index_failures(failed_at DESC);

CREATE TABLE IF NOT EXISTS memory_vector_blobs (
  record_id TEXT PRIMARY KEY,
  embedding BLOB NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (record_id) REFERENCES memory_records(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_memory_vector_updated_at ON memory_vector_blobs(updated_at DESC);

CREATE TABLE IF NOT EXISTS memory_ann_buckets (
  record_id TEXT NOT NULL,
  bucket_key TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (record_id, bucket_key),
  FOREIGN KEY (record_id) REFERENCES memory_records(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_memory_ann_bucket_key ON memory_ann_buckets(bucket_key, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_memory_ann_record_id ON memory_ann_buckets(record_id);

CREATE TABLE IF NOT EXISTS project_registry (
  project_id TEXT PRIMARY KEY,
  project_key TEXT NOT NULL UNIQUE,
  project_name TEXT,
  source TEXT NOT NULL,
  workspace_path TEXT,
  git_root TEXT,
  git_remote TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_project_last_seen ON project_registry(last_seen_at DESC);

CREATE TABLE IF NOT EXISTS plugin_state (
  state_key TEXT PRIMARY KEY,
  state_value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS recall_events (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  query_text TEXT NOT NULL,
  query_scope TEXT,
  injected_level TEXT NOT NULL,
  injected_chars INTEGER NOT NULL DEFAULT 0,
  selected_ids_json TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
  id UNINDEXED,
  title,
  summary,
  raw_text,
  keywords,
  content = ''
);

CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts_docs USING fts5(
  id UNINDEXED,
  title,
  summary,
  raw_text,
  keywords
);
