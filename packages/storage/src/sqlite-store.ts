import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type {
  ChunkRecordInput,
  ContextPack,
  ContextRetriever,
  FileRecordInput,
  IndexWriter,
  MemoryRecord,
  MemoryType,
  RepoRecord,
  RetrievalCandidate,
  SourceRef,
  TaskInput
} from "@llm-mem/core";
import { MIGRATIONS } from "./migrations.js";

export interface SQLiteStoreOptions {
  databasePath: string;
}

interface RepoRow {
  id: string;
  root_path: string;
  current_head: string | null;
}

interface MemoryRow {
  id: string;
  repo_id: string;
  type: MemoryType;
  title: string;
  content: string;
  summary: string | null;
  confidence: number;
  source_refs_json: string;
  tags_json: string;
  supersedes_id: string | null;
  created_at: string;
  updated_at: string;
  expires_at: string | null;
  rank?: number;
}

interface ChunkRow {
  id: string;
  repo_id: string;
  file_id: string;
  path: string;
  start_line: number;
  end_line: number;
  content_hash: string;
  text: string;
  summary: string | null;
  token_count: number;
  rank?: number;
}

export class SQLiteStore implements IndexWriter, ContextRetriever {
  private readonly db: Database.Database;

  public constructor(private readonly options: SQLiteStoreOptions) {
    mkdirSync(path.dirname(options.databasePath), { recursive: true });
    this.db = new Database(options.databasePath);
  }

  public initialize(): void {
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");

    for (const migration of MIGRATIONS) {
      this.db.exec(migration);
    }
  }

  public close(): void {
    this.db.close();
  }

  public async upsertRepo(rootPath: string, currentHead?: string): Promise<RepoRecord> {
    const now = new Date().toISOString();
    const row = this.db
      .prepare(
        `
        INSERT INTO repos(id, root_path, current_head, created_at, updated_at)
        VALUES (@id, @rootPath, @currentHead, @now, @now)
        ON CONFLICT(root_path) DO UPDATE SET
          current_head = excluded.current_head,
          updated_at = excluded.updated_at
        RETURNING id, root_path, current_head
      `
      )
      .get({
        id: randomUUID(),
        rootPath,
        currentHead: currentHead ?? null,
        now
      }) as RepoRow;

    return rowToRepo(row);
  }

  public getRepoByRoot(rootPath: string): RepoRecord | undefined {
    const row = this.db
      .prepare("SELECT id, root_path, current_head FROM repos WHERE root_path = ?")
      .get(rootPath) as RepoRow | undefined;
    return row === undefined ? undefined : rowToRepo(row);
  }

  public async upsertFile(input: FileRecordInput): Promise<{ id: string }> {
    const now = new Date().toISOString();
    const row = this.db
      .prepare(
        `
        INSERT INTO files(id, repo_id, path, content_hash, language, size_bytes, last_indexed_at)
        VALUES (@id, @repoId, @path, @contentHash, @language, @sizeBytes, @now)
        ON CONFLICT(repo_id, path) DO UPDATE SET
          content_hash = excluded.content_hash,
          language = excluded.language,
          size_bytes = excluded.size_bytes,
          last_indexed_at = excluded.last_indexed_at
        RETURNING id
      `
      )
      .get({
        id: randomUUID(),
        repoId: input.repoId,
        path: input.path,
        contentHash: input.contentHash,
        language: input.language,
        sizeBytes: input.sizeBytes,
        now
      }) as { id: string };

    return row;
  }

  public async replaceFileChunks(fileId: string, chunks: ChunkRecordInput[]): Promise<void> {
    const transaction = this.db.transaction((items: ChunkRecordInput[]) => {
      const existing = this.db.prepare("SELECT id FROM chunks WHERE file_id = ?").all(fileId) as { id: string }[];
      const deleteFts = this.db.prepare("DELETE FROM chunks_fts WHERE chunk_id = ?");
      for (const row of existing) {
        deleteFts.run(row.id);
      }
      this.db.prepare("DELETE FROM chunks WHERE file_id = ?").run(fileId);

      const insertChunk = this.db.prepare(
        `
        INSERT INTO chunks(
          id, file_id, repo_id, path, start_line, end_line, content_hash, text, summary, token_count
        ) VALUES (
          @id, @fileId, @repoId, @path, @startLine, @endLine, @contentHash, @text, @summary, @tokenCount
        )
      `
      );
      const insertFts = this.db.prepare(
        "INSERT INTO chunks_fts(chunk_id, repo_id, path, text, summary) VALUES (?, ?, ?, ?, ?)"
      );

      for (const chunk of items) {
        const id = randomUUID();
        insertChunk.run({
          id,
          fileId,
          repoId: chunk.repoId,
          path: chunk.path,
          startLine: chunk.startLine,
          endLine: chunk.endLine,
          contentHash: chunk.contentHash,
          text: chunk.text,
          summary: chunk.summary ?? null,
          tokenCount: chunk.tokenCount
        });
        insertFts.run(id, chunk.repoId, chunk.path, chunk.text, chunk.summary ?? "");
      }
    });

    transaction(chunks);
  }

  public async pruneMissingFiles(repoId: string, seenPaths: string[]): Promise<number> {
    const transaction = this.db.transaction((paths: string[]) => {
      this.db.prepare("CREATE TEMP TABLE IF NOT EXISTS temp_seen_paths(path TEXT PRIMARY KEY)").run();
      this.db.prepare("DELETE FROM temp_seen_paths").run();

      const insertSeenPath = this.db.prepare("INSERT OR IGNORE INTO temp_seen_paths(path) VALUES (?)");
      for (const seenPath of paths) {
        insertSeenPath.run(seenPath);
      }

      const rows = this.db
        .prepare(
          `
          SELECT id FROM chunks
          WHERE repo_id = ?
            AND NOT EXISTS (
              SELECT 1 FROM temp_seen_paths WHERE temp_seen_paths.path = chunks.path
            )
        `
        )
        .all(repoId) as { id: string }[];
      const deleteFts = this.db.prepare("DELETE FROM chunks_fts WHERE chunk_id = ?");
      for (const row of rows) {
        deleteFts.run(row.id);
      }

      const result = this.db
        .prepare(
          `
          DELETE FROM files
          WHERE repo_id = ?
            AND NOT EXISTS (
              SELECT 1 FROM temp_seen_paths WHERE temp_seen_paths.path = files.path
            )
        `
        )
        .run(repoId);
      this.db.prepare("DELETE FROM temp_seen_paths").run();
      return result.changes;
    });

    return transaction(seenPaths) as number;
  }

  public rememberMemory(input: {
    repoId: string;
    type: MemoryType;
    title: string;
    content: string;
    confidence: number;
    sourceRefs: SourceRef[];
    summary?: string | undefined;
    tags?: string[] | undefined;
  }): MemoryRecord {
    const now = new Date().toISOString();
    const id = randomUUID();

    this.db
      .prepare(
        `
        INSERT INTO memories(
          id, repo_id, type, title, content, summary, confidence, source_refs_json, tags_json,
          created_at, updated_at
        ) VALUES (
          @id, @repoId, @type, @title, @content, @summary, @confidence, @sourceRefsJson,
          @tagsJson, @now, @now
        )
      `
      )
      .run({
        id,
        repoId: input.repoId,
        type: input.type,
        title: input.title,
        content: input.content,
        summary: input.summary ?? null,
        confidence: input.confidence,
        sourceRefsJson: JSON.stringify(input.sourceRefs),
        tagsJson: JSON.stringify(input.tags ?? []),
        now
      });

    this.db
      .prepare("INSERT INTO memory_fts(memory_id, repo_id, title, content, summary) VALUES (?, ?, ?, ?, ?)")
      .run(id, input.repoId, input.title, input.content, input.summary ?? "");

    return {
      id,
      repoId: input.repoId,
      type: input.type,
      title: input.title,
      content: input.content,
      confidence: input.confidence,
      sourceRefs: input.sourceRefs,
      ...(input.summary === undefined ? {} : { summary: input.summary }),
      ...(input.tags === undefined ? {} : { tags: input.tags }),
      createdAt: now,
      updatedAt: now
    };
  }

  public createTask(input: { repoId: string; title: string; description?: string | undefined }): { id: string } {
    const now = new Date().toISOString();
    const id = randomUUID();
    this.db
      .prepare(
        `
        INSERT INTO tasks(id, repo_id, title, description, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'pending', ?, ?)
      `
      )
      .run(id, input.repoId, input.title, input.description ?? null, now, now);
    return { id };
  }

  public recordWorktreeLease(input: {
    repoId: string;
    taskId: string;
    branchName: string;
    path: string;
    baseRef: string;
    ownerAgent?: string | undefined;
    metadata?: Record<string, unknown> | undefined;
  }): { id: string } {
    const now = new Date().toISOString();
    const id = randomUUID();
    this.db
      .prepare(
        `
        INSERT INTO worktree_leases(
          id, repo_id, task_id, branch_name, path, base_ref, status, owner_agent,
          created_at, last_heartbeat_at, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)
      `
      )
      .run(
        id,
        input.repoId,
        input.taskId,
        input.branchName,
        input.path,
        input.baseRef,
        input.ownerAgent ?? null,
        now,
        now,
        JSON.stringify(input.metadata ?? {})
      );
    return { id };
  }

  public recordContextPack(pack: ContextPack): void {
    this.db
      .prepare(
        `
        INSERT INTO context_packs(id, repo_id, task, pack_json, token_budget, used_tokens, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `
      )
      .run(
        pack.id,
        pack.repoId ?? null,
        pack.task,
        JSON.stringify(pack),
        pack.budget.maxTokens,
        pack.budget.usedEstimate,
        pack.createdAt
      );
  }

  public createBenchmarkRun(input: {
    suiteName: string;
    variants: string[];
    metadata?: Record<string, unknown> | undefined;
  }): { id: string } {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `
        INSERT INTO benchmark_runs(id, suite_name, variants_json, started_at, metadata_json)
        VALUES (?, ?, ?, ?, ?)
      `
      )
      .run(id, input.suiteName, JSON.stringify(input.variants), now, JSON.stringify(input.metadata ?? {}));
    return { id };
  }

  public finishBenchmarkRun(id: string): void {
    this.db.prepare("UPDATE benchmark_runs SET finished_at = ? WHERE id = ?").run(new Date().toISOString(), id);
  }

  public recordBenchmarkResult(input: {
    runId: string;
    taskId: string;
    variant: string;
    resolved: boolean;
    promptTokensEstimate: number;
    contextTokensEstimate: number;
    outputTokensEstimate: number;
    durationMs: number;
    testExitCode: number | null;
    contextRecall: number;
    artifacts: Record<string, unknown>;
  }): { id: string } {
    const id = randomUUID();
    this.db
      .prepare(
        `
        INSERT INTO benchmark_results(
          id, run_id, task_id, variant, resolved, prompt_tokens_estimate, context_tokens_estimate,
          output_tokens_estimate, duration_ms, test_exit_code, context_recall, artifacts_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
      )
      .run(
        id,
        input.runId,
        input.taskId,
        input.variant,
        input.resolved ? 1 : 0,
        input.promptTokensEstimate,
        input.contextTokensEstimate,
        input.outputTokensEstimate,
        Math.round(input.durationMs),
        input.testExitCode,
        input.contextRecall,
        JSON.stringify(input.artifacts),
        new Date().toISOString()
      );
    return { id };
  }

  public async retrieve(input: TaskInput, maxCandidates: number): Promise<RetrievalCandidate[]> {
    const repoId = input.repoId;
    const memories = repoId === undefined ? [] : this.searchMemories(repoId, input.task, Math.ceil(maxCandidates / 2));
    const chunks = repoId === undefined ? [] : this.searchChunks(repoId, input.task, Math.ceil(maxCandidates / 2));
    return [...memories, ...chunks]
      .sort((left, right) => right.score * right.confidence - left.score * left.confidence)
      .slice(0, maxCandidates);
  }

  public searchMemories(repoId: string, query: string, limit: number): RetrievalCandidate[] {
    const ftsQuery = toFtsQuery(query);
    if (ftsQuery.length === 0) {
      return [];
    }

    const rows = this.db
      .prepare(
        `
        SELECT m.*, bm25(memory_fts) AS rank
        FROM memory_fts
        JOIN memories m ON m.id = memory_fts.memory_id
        WHERE memory_fts MATCH ? AND m.repo_id = ?
        ORDER BY rank
        LIMIT ?
      `
      )
      .all(ftsQuery, repoId, limit) as MemoryRow[];

    return rows.map((row, index) => memoryRowToCandidate(row, orderedScore(index, rows.length)));
  }

  public searchChunks(repoId: string, query: string, limit: number): RetrievalCandidate[] {
    const ftsQuery = toFtsQuery(query);
    if (ftsQuery.length === 0) {
      return [];
    }

    const rows = this.db
      .prepare(
        `
        SELECT c.*, bm25(chunks_fts) AS rank
        FROM chunks_fts
        JOIN chunks c ON c.id = chunks_fts.chunk_id
        WHERE chunks_fts MATCH ? AND c.repo_id = ?
        ORDER BY rank
        LIMIT ?
      `
      )
      .all(ftsQuery, repoId, limit) as ChunkRow[];

    return rows.map((row, index) => chunkRowToCandidate(row, orderedScore(index, rows.length)));
  }
}

function rowToRepo(row: RepoRow): RepoRecord {
  return {
    id: row.id,
    rootPath: row.root_path,
    ...(row.current_head === null ? {} : { currentHead: row.current_head })
  };
}

function memoryRowToCandidate(row: MemoryRow, score: number): RetrievalCandidate {
  const summary = row.summary ?? undefined;
  return {
    id: row.id,
    kind: row.type === "decision" ? "decision" : "memory",
    title: row.title,
    content: row.content,
    score,
    confidence: row.confidence,
    sourceRefs: parseJsonArray<SourceRef>(row.source_refs_json),
    ...(summary === undefined ? {} : { summary }),
    tags: parseJsonArray<string>(row.tags_json),
    freshness: row.expires_at === null ? "fresh" : "unknown",
    expansionId: `memory:${row.id}`
  };
}

function chunkRowToCandidate(row: ChunkRow, score: number): RetrievalCandidate {
  const summary = row.summary ?? undefined;
  return {
    id: row.id,
    kind: "chunk",
    title: `${row.path}:L${row.start_line}-L${row.end_line}`,
    content: row.text,
    score,
    confidence: 0.9,
    sourceRefs: [
      {
        kind: "file",
        uri: row.path,
        trust: "observed",
        startLine: row.start_line,
        endLine: row.end_line,
        contentHash: row.content_hash
      }
    ],
    ...(summary === undefined ? {} : { summary }),
    freshness: "fresh",
    expansionId: `chunk:${row.id}`
  };
}

function parseJsonArray<T>(json: string): T[] {
  const parsed = JSON.parse(json) as unknown;
  return Array.isArray(parsed) ? (parsed as T[]) : [];
}

function orderedScore(index: number, total: number): number {
  if (total <= 1) {
    return 1;
  }

  return 1 - index / total;
}

function toFtsQuery(input: string): string {
  const terms = input.match(/[\p{L}\p{N}_./-]+/gu) ?? [];
  return [...new Set(terms)]
    .slice(0, 12)
    .map((term) => `"${term.replaceAll('"', '""')}"`)
    .join(" OR ");
}
