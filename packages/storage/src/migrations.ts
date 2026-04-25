export const SCHEMA_VERSION = 1;

export const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS repos (
    id TEXT PRIMARY KEY,
    root_path TEXT NOT NULL UNIQUE,
    current_head TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS files (
    id TEXT PRIMARY KEY,
    repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    language TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    last_indexed_at TEXT NOT NULL,
    UNIQUE(repo_id, path)
  );

  CREATE TABLE IF NOT EXISTS chunks (
    id TEXT PRIMARY KEY,
    file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    start_line INTEGER NOT NULL,
    end_line INTEGER NOT NULL,
    content_hash TEXT NOT NULL,
    text TEXT NOT NULL,
    summary TEXT,
    token_count INTEGER NOT NULL
  );

  CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
    chunk_id UNINDEXED,
    repo_id UNINDEXED,
    path,
    text,
    summary
  );

  CREATE TABLE IF NOT EXISTS symbols (
    id TEXT PRIMARY KEY,
    repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
    file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    start_line INTEGER NOT NULL,
    end_line INTEGER NOT NULL,
    signature TEXT,
    parent_symbol_id TEXT
  );

  CREATE VIRTUAL TABLE IF NOT EXISTS symbols_fts USING fts5(
    symbol_id UNINDEXED,
    repo_id UNINDEXED,
    name,
    normalized_name,
    path,
    kind,
    signature
  );

  CREATE TABLE IF NOT EXISTS edges (
    id TEXT PRIMARY KEY,
    repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
    from_type TEXT NOT NULL,
    from_id TEXT NOT NULL,
    to_type TEXT NOT NULL,
    to_id TEXT NOT NULL,
    edge_type TEXT NOT NULL,
    confidence REAL NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY,
    repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    summary TEXT,
    confidence REAL NOT NULL,
    source_refs_json TEXT NOT NULL,
    tags_json TEXT NOT NULL,
    supersedes_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    expires_at TEXT
  );

  CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
    memory_id UNINDEXED,
    repo_id UNINDEXED,
    title,
    content,
    summary
  );

  CREATE TABLE IF NOT EXISTS context_packs (
    id TEXT PRIMARY KEY,
    repo_id TEXT,
    task TEXT NOT NULL,
    pack_json TEXT NOT NULL,
    token_budget INTEGER NOT NULL,
    used_tokens INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL,
    priority INTEGER NOT NULL DEFAULT 0,
    owner TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS agent_runs (
    id TEXT PRIMARY KEY,
    repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
    task_id TEXT,
    agent_name TEXT NOT NULL,
    status TEXT NOT NULL,
    model TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    trace_id TEXT
  );

  CREATE TABLE IF NOT EXISTS tool_calls (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
    tool_name TEXT NOT NULL,
    input_json TEXT NOT NULL,
    output_json TEXT,
    status TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT
  );

  CREATE TABLE IF NOT EXISTS worktree_leases (
    id TEXT PRIMARY KEY,
    repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
    task_id TEXT NOT NULL,
    branch_name TEXT NOT NULL,
    path TEXT NOT NULL,
    base_ref TEXT NOT NULL,
    status TEXT NOT NULL,
    owner_agent TEXT,
    created_at TEXT NOT NULL,
    expires_at TEXT,
    last_heartbeat_at TEXT,
    metadata_json TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    repo_id TEXT,
    type TEXT NOT NULL,
    actor TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS embeddings (
    id TEXT PRIMARY KEY,
    repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
    object_type TEXT NOT NULL,
    object_id TEXT NOT NULL,
    model TEXT NOT NULL,
    vector_ref TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS eval_runs (
    id TEXT PRIMARY KEY,
    suite TEXT NOT NULL,
    baseline TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    metadata_json TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS eval_scores (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES eval_runs(id) ON DELETE CASCADE,
    metric TEXT NOT NULL,
    value REAL NOT NULL,
    metadata_json TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS benchmark_runs (
    id TEXT PRIMARY KEY,
    suite_name TEXT NOT NULL,
    variants_json TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    metadata_json TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS benchmark_results (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES benchmark_runs(id) ON DELETE CASCADE,
    task_id TEXT NOT NULL,
    variant TEXT NOT NULL,
    resolved INTEGER NOT NULL,
    prompt_tokens_estimate INTEGER NOT NULL,
    context_tokens_estimate INTEGER NOT NULL,
    output_tokens_estimate INTEGER NOT NULL,
    duration_ms INTEGER NOT NULL,
    test_exit_code INTEGER,
    context_recall REAL NOT NULL,
    artifacts_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  INSERT OR IGNORE INTO schema_migrations(version, applied_at)
  VALUES (1, datetime('now'));
  `
];
