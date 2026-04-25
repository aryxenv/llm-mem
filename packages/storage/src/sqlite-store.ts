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
  SymbolRecordInput,
  TaskInput
} from "@llm-mem/core";
import { estimateTokens, truncateToTokenBudget } from "@llm-mem/core";
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

interface SymbolRow {
  id: string;
  repo_id: string;
  file_id: string;
  name: string;
  kind: string;
  start_line: number;
  end_line: number;
  signature: string | null;
  parent_symbol_id: string | null;
  path: string;
  content_hash: string;
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

  public async replaceFileSymbols(fileId: string, symbols: SymbolRecordInput[]): Promise<void> {
    const transaction = this.db.transaction((items: SymbolRecordInput[]) => {
      const existing = this.db.prepare("SELECT id FROM symbols WHERE file_id = ?").all(fileId) as { id: string }[];
      const deleteFts = this.db.prepare("DELETE FROM symbols_fts WHERE symbol_id = ?");
      for (const row of existing) {
        deleteFts.run(row.id);
      }
      this.db.prepare("DELETE FROM symbols WHERE file_id = ?").run(fileId);

      const insertSymbol = this.db.prepare(
        `
        INSERT INTO symbols(
          id, repo_id, file_id, name, kind, start_line, end_line, signature, parent_symbol_id
        ) VALUES (
          @id, @repoId, @fileId, @name, @kind, @startLine, @endLine, @signature, @parentSymbolId
        )
      `
      );
      const insertFts = this.db.prepare(
        `
        INSERT INTO symbols_fts(symbol_id, repo_id, name, normalized_name, path, kind, signature)
        SELECT @id, @repoId, @name, @normalizedName, files.path, @kind, @signature
        FROM files
        WHERE files.id = @fileId
      `
      );

      for (const symbol of items) {
        const id = randomUUID();
        const row = {
          id,
          repoId: symbol.repoId,
          fileId,
          name: symbol.name,
          normalizedName: normalizeIdentifier(symbol.name).join(" "),
          kind: symbol.kind,
          startLine: symbol.startLine,
          endLine: symbol.endLine,
          signature: symbol.signature ?? "",
          parentSymbolId: symbol.parentSymbolId ?? null
        };
        insertSymbol.run(row);
        insertFts.run(row);
      }
    });

    transaction(symbols);
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
      const symbolRows = this.db
        .prepare(
          `
          SELECT symbols.id FROM symbols
          JOIN files ON files.id = symbols.file_id
          WHERE files.repo_id = ?
            AND NOT EXISTS (
              SELECT 1 FROM temp_seen_paths WHERE temp_seen_paths.path = files.path
            )
        `
        )
        .all(repoId) as { id: string }[];
      const deleteSymbolFts = this.db.prepare("DELETE FROM symbols_fts WHERE symbol_id = ?");
      for (const row of symbolRows) {
        deleteSymbolFts.run(row.id);
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
    if (repoId === undefined) {
      return [];
    }

    const queryPlan = createQueryPlan(input.task);
    const laneLimit = Math.max(maxCandidates, 12);
    const symbols = this.searchSymbols(repoId, queryPlan, laneLimit * 2);
    const chunks = this.searchChunksWithPlan(repoId, queryPlan, laneLimit * 2);
    const memoryLimit = queryPlan.sourceCodeFocused ? Math.max(2, Math.ceil(laneLimit / 4)) : Math.ceil(laneLimit / 2);
    const memories = this.searchMemories(repoId, queryPlan.ftsQuery, memoryLimit);
    return [...symbols, ...chunks, ...memories]
      .map((candidate) => scoreCandidate(candidate, queryPlan))
      .filter((candidate) => candidate.score >= 0.2 || hasStrongMatch(candidate))
      .sort((left, right) => right.score * right.confidence - left.score * left.confidence)
      .slice(0, maxCandidates);
  }

  public searchMemories(repoId: string, query: string, limit: number): RetrievalCandidate[] {
    const ftsQuery = query.includes('"') ? query : toFtsQuery(query);
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

    return rows.map((row, index) => memoryRowToCandidate(row, rankScore(row.rank, rows, index)));
  }

  public searchChunks(repoId: string, query: string, limit: number): RetrievalCandidate[] {
    return this.searchChunksWithPlan(repoId, createQueryPlan(query), limit);
  }

  public searchSymbols(repoId: string, query: string | QueryPlan, limit: number): RetrievalCandidate[] {
    const queryPlan = typeof query === "string" ? createQueryPlan(query) : query;
    if (queryPlan.ftsQuery.length === 0) {
      return [];
    }

    const rows = this.db
      .prepare(
        `
        SELECT s.*, f.path, f.content_hash, bm25(symbols_fts) AS rank
        FROM symbols_fts
        JOIN symbols s ON s.id = symbols_fts.symbol_id
        JOIN files f ON f.id = s.file_id
        WHERE symbols_fts MATCH ? AND s.repo_id = ?
        ORDER BY rank
        LIMIT ?
      `
      )
      .all(queryPlan.ftsQuery, repoId, limit) as SymbolRow[];

    return rows.map((row, index) => symbolRowToCandidate(row, rankScore(row.rank, rows, index), queryPlan));
  }

  public getCandidateByExpansionId(repoId: string, expansionId: string, maxTokens = 1200): RetrievalCandidate | undefined {
    const [kind, id] = expansionId.split(":");
    if (!kind || !id) {
      return undefined;
    }

    if (kind === "chunk") {
      const row = this.db.prepare("SELECT * FROM chunks WHERE id = ? AND repo_id = ?").get(id, repoId) as
        | ChunkRow
        | undefined;
      return row === undefined ? undefined : fitCandidateToBudget(chunkRowToCandidate(row, 1), maxTokens);
    }

    if (kind === "memory") {
      const row = this.db.prepare("SELECT * FROM memories WHERE id = ? AND repo_id = ?").get(id, repoId) as
        | MemoryRow
        | undefined;
      return row === undefined ? undefined : fitCandidateToBudget(memoryRowToCandidate(row, 1), maxTokens);
    }

    if (kind === "symbol") {
      const row = this.db
        .prepare(
          `
          SELECT s.*, f.path, f.content_hash
          FROM symbols s
          JOIN files f ON f.id = s.file_id
          WHERE s.id = ? AND s.repo_id = ?
        `
        )
        .get(id, repoId) as SymbolRow | undefined;
      if (row === undefined) {
        return undefined;
      }

      const overlappingChunks = this.db
        .prepare(
          `
          SELECT c.*
          FROM chunks c
          WHERE c.repo_id = ?
            AND c.file_id = ?
            AND c.end_line >= ?
            AND c.start_line <= ?
          ORDER BY c.start_line
        `
        )
        .all(repoId, row.file_id, row.start_line, row.end_line) as ChunkRow[];
      const candidate = symbolRowToCandidate(row, 1, createQueryPlan(row.name));
      if (overlappingChunks.length === 0) {
        return fitCandidateToBudget(candidate, maxTokens);
      }

      const content = sourceSliceFromChunks(overlappingChunks, row.start_line, row.end_line);
      return fitCandidateToBudget(
        {
          ...candidate,
          content,
          tokenCost: estimateTokens(content),
          matchReasons: [...(candidate.matchReasons ?? []), "symbol-expansion"]
        },
        maxTokens
      );
    }

    return undefined;
  }

  private searchChunksWithPlan(repoId: string, queryPlan: QueryPlan, limit: number): RetrievalCandidate[] {
    if (queryPlan.ftsQuery.length === 0) {
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
      .all(queryPlan.ftsQuery, repoId, limit) as ChunkRow[];

    return rows.map((row, index) => chunkRowToCandidate(row, rankScore(row.rank, rows, index)));
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
    expansionId: `memory:${row.id}`,
    matchReasons: ["memory-fts"]
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
    expansionId: `chunk:${row.id}`,
    tokenCost: row.token_count,
    matchReasons: ["chunk-fts"]
  };
}

function symbolRowToCandidate(row: SymbolRow, score: number, queryPlan: QueryPlan): RetrievalCandidate {
  const signature = row.signature?.trim();
  const content = [
    `${row.kind} ${row.name}`,
    `Defined in ${row.path}:L${row.start_line}-L${row.end_line}`,
    signature ? `Signature: ${signature}` : undefined
  ]
    .filter((value): value is string => value !== undefined)
    .join("\n");
  const normalizedName = normalizeIdentifier(row.name).join("");
  const reasons = ["symbol-fts"];
  if (queryPlan.identifierKeys.has(normalizedName)) {
    reasons.push("exact-symbol");
  }
  if (pathMatches(row.path, queryPlan)) {
    reasons.push("path-match");
  }

  return {
    id: row.id,
    kind: "symbol",
    title: `${row.path}:${row.name}`,
    content,
    score,
    confidence: reasons.includes("exact-symbol") ? 0.98 : 0.92,
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
    freshness: "fresh",
    expansionId: `symbol:${row.id}`,
    tokenCost: Math.max(16, Math.ceil((signature?.length ?? content.length) / 4)),
    matchReasons: reasons
  };
}

function parseJsonArray<T>(json: string): T[] {
  const parsed = JSON.parse(json) as unknown;
  return Array.isArray(parsed) ? (parsed as T[]) : [];
}

function rankScore(rank: number | undefined, rows: Array<{ rank?: number }>, index: number): number {
  const ranks = rows.map((row) => row.rank).filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (rank === undefined || ranks.length <= 1) {
    return orderedScore(index, rows.length);
  }

  const best = Math.min(...ranks);
  const worst = Math.max(...ranks);
  if (best === worst) {
    return orderedScore(index, rows.length);
  }

  return 1 - (rank - best) / (worst - best);
}

function orderedScore(index: number, total: number): number {
  if (total <= 1) {
    return 1;
  }

  return 1 - index / total;
}

function toFtsQuery(input: string): string {
  return createQueryPlan(input).ftsQuery;
}

interface QueryPlan {
  ftsQuery: string;
  terms: string[];
  identifierKeys: Set<string>;
  pathHints: string[];
  wantsTests: boolean;
  wantsDocs: boolean;
  sourceCodeFocused: boolean;
}

function createQueryPlan(input: string): QueryPlan {
  const rawTerms = input.match(/[\p{L}\p{N}_./-]+/gu) ?? [];
  const expanded = new Set<string>();
  const identifierKeys = new Set<string>();
  const pathHints: string[] = [];

  for (const rawTerm of rawTerms) {
    const term = rawTerm.toLowerCase();
    if (term.includes("/") || term.includes(".") || term.includes("-")) {
      pathHints.push(term);
    }

    for (const normalized of normalizeIdentifier(rawTerm)) {
      if (!STOPWORDS.has(normalized) && normalized.length > 1) {
        expanded.add(normalized);
      }
    }

    const identifierKey = normalizeIdentifier(rawTerm).join("");
    if (identifierKey.length > 1) {
      identifierKeys.add(identifierKey);
      expanded.add(identifierKey);
      expanded.add(normalizeIdentifier(rawTerm).join("-"));
    }
  }

  const lowerInput = input.toLowerCase();
  const wantsTests = /\b(test|tests|spec|validation|validate)\b/.test(lowerInput);
  const wantsDocs = /\b(readme|docs?|documentation|guide|quickstart)\b/.test(lowerInput);
  const hasCodeIdentifier = rawTerms.some((term) => /[a-z0-9][A-Z]|[_./-]/.test(term));
  const sourceCodeFocused =
    hasCodeIdentifier || /\b(class|function|method|implementation|source|code|compiler|builds?|tests?)\b/.test(lowerInput);
  const terms = [...expanded].filter((term) => term.length > 1 && !STOPWORDS.has(term)).slice(0, 24);
  return {
    ftsQuery: terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR "),
    terms,
    identifierKeys,
    pathHints,
    wantsTests,
    wantsDocs,
    sourceCodeFocused
  };
}

function normalizeIdentifier(input: string): string[] {
  const withoutExtension = input.replace(/\.[a-z0-9]+$/i, "");
  const spaced = withoutExtension
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_./-]+/g, " ")
    .toLowerCase();
  const parts = spaced.match(/[\p{L}\p{N}]+/gu) ?? [];
  const values = new Set(parts);
  if (parts.length > 1) {
    values.add(parts.join(""));
    values.add(parts.join("-"));
  }
  return [...values];
}

function scoreCandidate(candidate: RetrievalCandidate, queryPlan: QueryPlan): RetrievalCandidate {
  const text = `${candidate.title}\n${candidate.content}`.toLowerCase();
  const sourcePath = candidate.sourceRefs[0]?.uri.toLowerCase() ?? "";
  const reasons = new Set(candidate.matchReasons ?? []);
  let score = candidate.score;

  if (candidate.kind === "symbol") {
    score += 1.2;
  }

  if (pathMatches(sourcePath, queryPlan)) {
    score += 1.0;
    reasons.add("path-match");
  }

  for (const key of queryPlan.identifierKeys) {
    if (text.replace(/[^a-z0-9]+/g, "").includes(key)) {
      score += 0.8;
      reasons.add(candidate.kind === "symbol" ? "exact-symbol" : "identifier-match");
      break;
    }
  }

  const matchedTerms = queryPlan.terms.filter((term) => text.includes(term)).length;
  score += Math.min(0.5, matchedTerms * 0.08);

  if (queryPlan.wantsTests && isTestPath(sourcePath)) {
    score += 0.45;
    reasons.add("test-path");
  } else if (!queryPlan.wantsTests && isTestPath(sourcePath)) {
    score -= 0.25;
  }

  if (queryPlan.wantsDocs && isDocPath(sourcePath)) {
    score += 0.35;
    reasons.add("doc-path");
  } else if (!queryPlan.wantsDocs && isDocPath(sourcePath)) {
    score -= 0.3;
  }

  const tokenCost = candidate.tokenCost ?? estimateCandidateTokenCost(candidate);
  score += Math.max(-0.25, Math.min(0.15, (240 - tokenCost) / 1200));

  return {
    ...candidate,
    score: Math.max(0, score),
    tokenCost,
    matchReasons: [...reasons]
  };
}

function hasStrongMatch(candidate: RetrievalCandidate): boolean {
  return (candidate.matchReasons ?? []).some((reason) => reason === "exact-symbol" || reason === "path-match");
}

function pathMatches(pathValue: string, queryPlan: QueryPlan): boolean {
  const normalizedPath = pathValue.toLowerCase().replaceAll("\\", "/");
  if (queryPlan.pathHints.some((hint) => normalizedPath.includes(hint.replaceAll("\\", "/")))) {
    return true;
  }

  return queryPlan.terms.some((term) => term.includes("-") && normalizedPath.includes(term));
}

function isTestPath(pathValue: string): boolean {
  return /(^|[/\\])(tests?|__tests__|spec)([/\\]|$)|\.(test|spec)\.[cm]?[jt]sx?$/.test(pathValue);
}

function isDocPath(pathValue: string): boolean {
  return /(^|[/\\])(docs?|readme)([/\\]|$)|readme\.md$|\.mdx?$/.test(pathValue);
}

function estimateCandidateTokenCost(candidate: RetrievalCandidate): number {
  return Math.max(1, Math.ceil(`${candidate.title}\n${candidate.content}`.length / 4));
}

function sourceSliceFromChunks(chunks: ChunkRow[], startLine: number, endLine: number): string {
  const fromLine = Math.max(1, startLine - 2);
  const toLine = endLine + 2;
  const linesByNumber = new Map<number, string>();

  for (const chunk of chunks) {
    const lines = chunk.text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const lineNumber = chunk.start_line + index;
      if (lineNumber >= fromLine && lineNumber <= toLine && !linesByNumber.has(lineNumber)) {
        linesByNumber.set(lineNumber, lines[index] ?? "");
      }
    }
  }

  return [...linesByNumber.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, line]) => line)
    .join("\n");
}

function fitCandidateToBudget(candidate: RetrievalCandidate, maxTokens: number): RetrievalCandidate {
  const fitted = truncateToTokenBudget(candidate.content, maxTokens);
  return {
    ...candidate,
    content: fitted.text,
    tokenCost: estimateTokens(fitted.text),
    matchReasons: fitted.truncated ? [...(candidate.matchReasons ?? []), "truncated"] : candidate.matchReasons
  };
}

const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "be",
  "build",
  "builds",
  "by",
  "do",
  "does",
  "explain",
  "file",
  "files",
  "for",
  "from",
  "how",
  "identify",
  "in",
  "is",
  "it",
  "its",
  "list",
  "main",
  "of",
  "on",
  "or",
  "the",
  "this",
  "to",
  "what",
  "with"
]);
