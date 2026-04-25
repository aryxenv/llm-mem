#!/usr/bin/env node
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { Command } from "commander";
import { ContextCompiler } from "@llm-mem/core";
import { startDaemon } from "@llm-mem/daemon";
import { EvalRunner, loadEvalDataset } from "@llm-mem/evals";
import { RepositoryIndexer } from "@llm-mem/indexer";
import { SQLiteStore } from "@llm-mem/storage";
import { WorktreeManager } from "@llm-mem/worktrees";

const execFileAsync = promisify(execFile);

const program = new Command();
program.name("llm-mem").description("Context compiler for token-efficient coding agents.").version("0.1.0");

program
  .command("init")
  .description("Initialize llm-mem metadata for the current repository.")
  .option("--db <path>", "SQLite database path")
  .action(async (options: { db?: string }) => {
    const rootPath = process.cwd();
    const store = openStore(rootPath, options.db);
    const repo = await store.upsertRepo(rootPath, await currentHead(rootPath));
    store.close();
    printJson({ repo, databasePath: options.db ?? defaultDatabasePath(rootPath) });
  });

program
  .command("index")
  .description("Index the current repository into local memory.")
  .option("--db <path>", "SQLite database path")
  .action(async (options: { db?: string }) => {
    const rootPath = process.cwd();
    const store = openStore(rootPath, options.db);
    const indexer = new RepositoryIndexer(store);
    const result = await indexer.index(rootPath, await currentHead(rootPath));
    store.close();
    printJson(result);
  });

program
  .command("remember")
  .argument("<content>", "Memory content to store.")
  .description("Store a source-grounded memory.")
  .option("--db <path>", "SQLite database path")
  .option("--title <title>", "Memory title")
  .option("--type <type>", "Memory type", "project")
  .option("--source <uri>", "Source URI")
  .action(async (content: string, options: { db?: string; title?: string; type: string; source?: string }) => {
    const rootPath = process.cwd();
    const store = openStore(rootPath, options.db);
    const repo = store.getRepoByRoot(rootPath) ?? (await store.upsertRepo(rootPath, await currentHead(rootPath)));
    const memory = store.rememberMemory({
      repoId: repo.id,
      type: parseMemoryType(options.type),
      title: options.title ?? content.slice(0, 80),
      content,
      confidence: 0.8,
      sourceRefs:
        options.source === undefined
          ? []
          : [
              {
                kind: "url",
                uri: options.source,
                trust: "external"
              }
            ]
    });
    store.close();
    printJson(memory);
  });

program
  .command("context")
  .argument("<task>", "Task to compile context for.")
  .description("Build a proof-carrying context pack.")
  .option("--db <path>", "SQLite database path")
  .option("--budget <tokens>", "Maximum token budget", "12000")
  .action(async (task: string, options: { db?: string; budget: string }) => {
    const rootPath = process.cwd();
    const store = openStore(rootPath, options.db);
    const repo = store.getRepoByRoot(rootPath) ?? (await store.upsertRepo(rootPath, await currentHead(rootPath)));
    const compiler = new ContextCompiler(store);
    const pack = await compiler.compile(
      { task, repoId: repo.id, workingDirectory: rootPath },
      { maxTokens: parseTokenBudget(options.budget), modelPolicy: "preferred:gpt-5.5" }
    );
    store.recordContextPack(pack);
    store.close();
    printJson(pack);
  });

const taskCommand = program.command("task").description("Manage llm-mem tasks.");
taskCommand
  .command("create")
  .argument("<title>", "Task title.")
  .option("--db <path>", "SQLite database path")
  .option("--description <description>", "Task description")
  .action(async (title: string, options: { db?: string; description?: string }) => {
    const rootPath = process.cwd();
    const store = openStore(rootPath, options.db);
    const repo = store.getRepoByRoot(rootPath) ?? (await store.upsertRepo(rootPath, await currentHead(rootPath)));
    const task = store.createTask({
      repoId: repo.id,
      title,
      ...(options.description === undefined ? {} : { description: options.description })
    });
    store.close();
    printJson(task);
  });

const worktreeCommand = program.command("worktree").description("Manage git worktree leases.");
worktreeCommand
  .command("create")
  .requiredOption("--task <id>", "Task identifier")
  .requiredOption("--slug <slug>", "Short worktree slug")
  .option("--base <ref>", "Base ref", "HEAD")
  .option("--root <path>", "Repository root", process.cwd())
  .action(async (options: { task: string; slug: string; base: string; root: string }) => {
    const manager = new WorktreeManager();
    const lease = await manager.createLease({
      repoRoot: options.root,
      taskId: options.task,
      slug: options.slug,
      baseRef: options.base
    });
    const rootPath = path.resolve(options.root);
    const store = openStore(rootPath);
    const repo = store.getRepoByRoot(rootPath) ?? (await store.upsertRepo(rootPath, await currentHead(rootPath)));
    const leaseRecord = store.recordWorktreeLease({
      repoId: repo.id,
      taskId: options.task,
      branchName: lease.branchName,
      path: lease.path,
      baseRef: lease.baseRef
    });
    store.close();
    printJson({ ...lease, leaseId: leaseRecord.id });
  });

worktreeCommand
  .command("release")
  .requiredOption("--path <path>", "Worktree path")
  .option("--root <path>", "Repository root", process.cwd())
  .option("--allow-dirty", "Allow dirty worktree release check")
  .option("--keep", "Do not remove the worktree")
  .action(async (options: { path: string; root: string; allowDirty?: boolean; keep?: boolean }) => {
    const manager = new WorktreeManager();
    const result = await manager.release({
      repoRoot: options.root,
      worktreePath: options.path,
      allowDirty: options.allowDirty === true,
      remove: options.keep === true ? false : true
    });
    printJson(result);
  });

program
  .command("eval")
  .description("Run local context-pack evaluations.")
  .argument("<dataset>", "Path to an eval dataset JSON file.")
  .option("--db <path>", "SQLite database path")
  .option("--budget <tokens>", "Maximum token budget", "12000")
  .action(async (dataset: string, options: { db?: string; budget: string }) => {
    const rootPath = process.cwd();
    const store = openStore(rootPath, options.db);
    const repo = store.getRepoByRoot(rootPath) ?? (await store.upsertRepo(rootPath, await currentHead(rootPath)));
    const scenarios = await loadEvalDataset(path.resolve(dataset));
    const runner = new EvalRunner(store);
    const result = await runner.run(scenarios, {
      repoId: repo.id,
      maxTokens: parseTokenBudget(options.budget)
    });
    store.close();
    printJson(result);
  });

program
  .command("daemon")
  .description("Start the local daemon.")
  .option("--port <port>", "Port", "32177")
  .action(async (options: { port: string }) => {
    const handle = await startDaemon({ port: Number.parseInt(options.port, 10) });
    printJson({ url: handle.url, authToken: handle.authToken });
  });

await program.parseAsync(process.argv);

function parseTokenBudget(input: string): number {
  const value = Number.parseInt(input, 10);
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 64) {
    throw new Error("Token budget must be a finite integer >= 64.");
  }

  return value;
}

function openStore(rootPath: string, databasePath?: string): SQLiteStore {
  const store = new SQLiteStore({ databasePath: databasePath ?? defaultDatabasePath(rootPath) });
  store.initialize();
  return store;
}

function defaultDatabasePath(rootPath: string): string {
  return path.join(rootPath, ".llm-mem", "llm-mem.db");
}

async function currentHead(rootPath: string): Promise<string | undefined> {
  try {
    const result = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: rootPath, windowsHide: true });
    return result.stdout.trim();
  } catch {
    return undefined;
  }
}

function parseMemoryType(input: string): "project" | "decision" | "task" | "session" | "code" | "research" | "user" | "agent" {
  const allowed = new Set(["project", "decision", "task", "session", "code", "research", "user", "agent"]);
  if (!allowed.has(input)) {
    throw new Error(`Invalid memory type: ${input}`);
  }

  return input as "project" | "decision" | "task" | "session" | "code" | "research" | "user" | "agent";
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}
