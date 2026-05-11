import type Database from "better-sqlite3";

export function migrate(db: Database.Database): void {
  db.exec(`
CREATE TABLE IF NOT EXISTS connector_configs (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL UNIQUE,
  enabled INTEGER NOT NULL DEFAULT 1,
  mode TEXT NOT NULL,
  public_base_url TEXT,
  local_endpoint TEXT NOT NULL,
  config_status TEXT NOT NULL DEFAULT 'incomplete',
  configured_fields_json TEXT NOT NULL DEFAULT '{}',
  capabilities_json TEXT NOT NULL DEFAULT '[]',
  last_connected_at TEXT,
  last_message_at TEXT,
  last_test_at TEXT,
  last_test_result TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS incoming_messages (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  chat_id TEXT,
  message_id TEXT NOT NULL,
  text TEXT NOT NULL,
  raw_payload_json TEXT,
  normalized_payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'received',
  job_id TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(source, message_id)
);

CREATE TABLE IF NOT EXISTS ingest_jobs (
  id TEXT PRIMARY KEY,
  message_id TEXT,
  source TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  chat_id TEXT,
  status TEXT NOT NULL,
  intent_type TEXT NOT NULL,
  current_node TEXT,
  preview_id TEXT,
  error_summary TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  started_at TEXT,
  finished_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_runs (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  status TEXT NOT NULL,
  input_state_json TEXT NOT NULL,
  final_state_json TEXT,
  model TEXT,
  token_usage_json TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  error TEXT
);

CREATE TABLE IF NOT EXISTS agent_step_logs (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  node_name TEXT NOT NULL,
  status TEXT NOT NULL,
  input_summary TEXT,
  output_summary TEXT,
  tool_name TEXT,
  duration_ms INTEGER,
  error TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tool_calls (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  node_name TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  input_json TEXT,
  output_json TEXT,
  status TEXT NOT NULL,
  duration_ms INTEGER,
  error TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS previews (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  source TEXT NOT NULL,
  status TEXT NOT NULL,
  summary TEXT NOT NULL,
  detected_projects_json TEXT NOT NULL DEFAULT '[]',
  notes_to_write_json TEXT NOT NULL DEFAULT '[]',
  knowledge_json TEXT NOT NULL DEFAULT '[]',
  ideas_json TEXT NOT NULL DEFAULT '[]',
  warnings_json TEXT NOT NULL DEFAULT '[]',
  markdown_preview TEXT,
  stored_preview_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS vault_files (
  id TEXT PRIMARY KEY,
  note_id TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  path TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  github_repo TEXT,
  source_urls_json TEXT NOT NULL DEFAULT '[]',
  source_ids_json TEXT NOT NULL DEFAULT '[]',
  entities_json TEXT NOT NULL DEFAULT '[]',
  domains_json TEXT NOT NULL DEFAULT '[]',
  content_hash TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS connector_logs (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  event_type TEXT NOT NULL,
  status TEXT NOT NULL,
  message TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ingest_jobs_created_at ON ingest_jobs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_runs_job_id ON agent_runs(job_id);
CREATE INDEX IF NOT EXISTS idx_agent_step_logs_run_id ON agent_step_logs(run_id);
CREATE INDEX IF NOT EXISTS idx_previews_status_created_at ON previews(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_connector_logs_source_created_at ON connector_logs(source, created_at DESC);
`);
  ensureColumn(db, "previews", "stored_preview_json", "TEXT");
}

function ensureColumn(db: Database.Database, table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (columns.some((item) => item.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
