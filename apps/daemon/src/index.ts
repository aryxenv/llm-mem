import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ContextCompiler } from "@llm-mem/core";
import { EvalRunner, loadEvalDataset } from "@llm-mem/evals";
import { RepositoryIndexer } from "@llm-mem/indexer";
import { JsonLogger, type Logger } from "@llm-mem/observability";
import {
  ContextPackRequestSchema,
  MemoryWriteSchema,
  TaskCreateSchema,
  WorktreeCreateSchema
} from "@llm-mem/protocol";
import { SQLiteStore } from "@llm-mem/storage";
import { WorktreeManager } from "@llm-mem/worktrees";

export interface DaemonOptions {
  rootPath?: string;
  databasePath?: string;
  host?: string;
  port?: number;
  authToken?: string;
  logger?: Logger;
}

export interface DaemonHandle {
  url: string;
  authToken: string;
  close(): Promise<void>;
}

export async function startDaemon(options: DaemonOptions = {}): Promise<DaemonHandle> {
  const rootPath = path.resolve(options.rootPath ?? process.cwd());
  const databasePath = options.databasePath ?? defaultDatabasePath(rootPath);
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 32177;
  const logger = options.logger ?? new JsonLogger("info");
  const authToken = options.authToken ?? getOrCreateAuthToken(rootPath);
  const store = new SQLiteStore({ databasePath });
  store.initialize();
  const compiler = new ContextCompiler(store);
  const indexer = new RepositoryIndexer(store);
  const worktrees = new WorktreeManager();

  const server = http.createServer(async (request, response) => {
    try {
      if (request.url === "/health" && request.method === "GET") {
        writeJson(response, 200, { ok: true });
        return;
      }

      if (!isAuthorized(request, authToken)) {
        writeJson(response, 401, { error: "unauthorized" });
        return;
      }

      const url = new URL(request.url ?? "/", `http://${host}:${port}`);

      if (url.pathname === "/index" && request.method === "POST") {
        const repo = await store.upsertRepo(rootPath);
        const result = await indexer.index(rootPath, repo.currentHead);
        writeJson(response, 200, result);
        return;
      }

      if (url.pathname === "/context-pack" && request.method === "POST") {
        const body = ContextPackRequestSchema.parse(await readJson(request));
        const pack = await compiler.compile(
          {
            task: body.task,
            ...(body.repoId === undefined ? {} : { repoId: body.repoId }),
            ...(body.workingDirectory === undefined ? {} : { workingDirectory: body.workingDirectory }),
            ...(body.constraints === undefined ? {} : { constraints: body.constraints })
          },
          { maxTokens: body.maxTokens, modelPolicy: "preferred:gpt-5.5" }
        );
        store.recordContextPack(pack);
        writeJson(response, 200, pack);
        return;
      }

      if (url.pathname === "/memory" && request.method === "POST") {
        const body = MemoryWriteSchema.parse(await readJson(request));
        const memory = store.rememberMemory(body);
        writeJson(response, 201, memory);
        return;
      }

      if (url.pathname === "/memory/search" && request.method === "GET") {
        const repoId = url.searchParams.get("repoId");
        const query = url.searchParams.get("query");
        if (!repoId || !query) {
          writeJson(response, 400, { error: "repoId and query are required" });
          return;
        }

        writeJson(response, 200, {
          results: store.searchMemories(repoId, query, 20)
        });
        return;
      }

      if (url.pathname === "/tasks" && request.method === "POST") {
        const body = TaskCreateSchema.parse(await readJson(request));
        writeJson(response, 201, store.createTask(body));
        return;
      }

      if (url.pathname === "/worktrees" && request.method === "POST") {
        const body = WorktreeCreateSchema.parse(await readJson(request));
        const lease = await worktrees.createLease(body);
        const repo = await store.upsertRepo(path.resolve(body.repoRoot));
        const leaseRecord = store.recordWorktreeLease({
          repoId: repo.id,
          taskId: body.taskId,
          branchName: lease.branchName,
          path: lease.path,
          baseRef: lease.baseRef
        });
        writeJson(response, 201, { ...lease, leaseId: leaseRecord.id });
        return;
      }

      if (url.pathname === "/eval/run" && request.method === "POST") {
        const body = (await readJson(request)) as { datasetPath?: string; repoId?: string; maxTokens?: number };
        if (!body.datasetPath) {
          writeJson(response, 400, { error: "datasetPath is required" });
          return;
        }

        const repoId = body.repoId ?? (await store.upsertRepo(rootPath)).id;
        const scenarios = await loadEvalDataset(path.resolve(body.datasetPath));
        const runner = new EvalRunner(store);
        const result = await runner.run(scenarios, {
          repoId,
          maxTokens: parseTokenBudget(body.maxTokens ?? 12000)
        });
        writeJson(response, 200, result);
        return;
      }

      writeJson(response, 404, { error: "not_found" });
    } catch (error) {
      logger.error("daemon.request.error", { error: error instanceof Error ? error.message : String(error) });
      writeJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });

  await new Promise<void>((resolve) => {
    server.listen(port, host, resolve);
  });

  logger.info("daemon.started", { url: `http://${host}:${port}` });

  return {
    url: `http://${host}:${port}`,
    authToken,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      });
      store.close();
    }
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const handle = await startDaemon();
  console.log(JSON.stringify({ url: handle.url, authToken: handle.authToken }));
}

function defaultDatabasePath(rootPath: string): string {
  return path.join(rootPath, ".llm-mem", "llm-mem.db");
}

function getOrCreateAuthToken(rootPath: string): string {
  const stateDirectory = path.join(rootPath, ".llm-mem");
  const tokenPath = path.join(stateDirectory, "auth-token");
  mkdirSync(stateDirectory, { recursive: true });

  if (existsSync(tokenPath)) {
    return readFileSync(tokenPath, "utf8").trim();
  }

  const token = randomBytes(32).toString("hex");
  writeFileSync(tokenPath, `${token}\n`, { encoding: "utf8", mode: 0o600 });
  return token;
}

function isAuthorized(request: http.IncomingMessage, authToken: string): boolean {
  const header = request.headers.authorization;
  return header === `Bearer ${authToken}`;
}

async function readJson(request: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const text = Buffer.concat(chunks).toString("utf8");
  if (text.trim().length === 0) {
    return {};
  }

  return JSON.parse(text) as unknown;
}

function writeJson(response: http.ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function parseTokenBudget(value: number): number {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 64) {
    throw new Error("Token budget must be a finite integer >= 64.");
  }

  return value;
}
