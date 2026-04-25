#!/usr/bin/env node
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { Command } from "commander";
import {
  BenchmarkRunner,
  CopilotCliAdapter,
  buildCopilotPrompt,
  loadBenchmarkSuite,
  renderMarkdownReport,
  type BenchmarkVariant
} from "@llm-mem/benchmarks";
import { ContextCompiler } from "@llm-mem/core";
import { startDaemon } from "@llm-mem/daemon";
import { EvalRunner, loadEvalDataset } from "@llm-mem/evals";
import { RepositoryIndexer } from "@llm-mem/indexer";
import {
  defaultMcpCommand,
  getCopilotIntegrationStatus,
  installCopilotIntegration,
  uninstallCopilotIntegration
} from "@llm-mem/integrations";
import { startMcpServer } from "@llm-mem/mcp-server";
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

const copilotCommand = program.command("copilot").description("Use llm-mem context packs with Copilot CLI.");
copilotCommand
  .command("run")
  .argument("<task>", "Task prompt for Copilot CLI.")
  .option("--db <path>", "SQLite database path")
  .option("--budget <tokens>", "Maximum context-pack token budget", "8000")
  .option("--model <model>", "Copilot CLI model", "gpt-5.5")
  .option("--executable <path>", "Copilot CLI executable", "copilot")
  .option("--dry-run", "Write prompt artifacts but do not invoke Copilot CLI")
  .action(
    async (
      task: string,
      options: { db?: string; budget: string; model: string; executable: string; dryRun?: boolean }
    ) => {
      const rootPath = process.cwd();
      const store = openStore(rootPath, options.db);
      const indexer = new RepositoryIndexer(store);
      const indexResult = await indexer.index(rootPath, await currentHead(rootPath));
      const compiler = new ContextCompiler(store);
      const pack = await compiler.compile(
        { task, repoId: indexResult.repo.id, workingDirectory: rootPath },
        { maxTokens: parseTokenBudget(options.budget), modelPolicy: `preferred:${options.model}` }
      );
      store.recordContextPack(pack);
      const builtPrompt = buildCopilotPrompt({ task, contextPack: pack });
      const outputDirectory = path.join(rootPath, ".llm-mem", "runs", pack.id);
      const adapter = new CopilotCliAdapter({ executable: options.executable, defaultModel: options.model });
      const result = await adapter.run({
        cwd: rootPath,
        prompt: builtPrompt.prompt,
        outputDirectory,
        model: options.model,
        dryRun: options.dryRun === true
      });
      store.close();
      printJson({ contextPack: pack, copilot: result, outputDirectory });
    }
  );

const benchmarkCommand = program.command("benchmark").description("Run A/B benchmarks for token-efficiency.");
benchmarkCommand
  .command("list")
  .option("--dir <path>", "Benchmark suite directory", "evals\\benchmarks")
  .description("List benchmark suite JSON files.")
  .action(async (options: { dir: string }) => {
    const { readdir } = await import("node:fs/promises");
    const directory = path.resolve(options.dir);
    const entries = await readdir(directory, { withFileTypes: true });
    printJson({
      directory,
      suites: entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map((entry) => path.join(directory, entry.name))
    });
  });

benchmarkCommand
  .command("run")
  .argument("<suite>", "Benchmark suite JSON file.")
  .option("--db <path>", "SQLite database path")
  .option("--variant <variant...>", "Variant(s): baseline-copilot, llm-mem-context")
  .option("--budget <tokens>", "Maximum context-pack token budget", "8000")
  .option("--model <model>", "Copilot CLI model", "gpt-5.5")
  .option("--executable <path>", "Copilot CLI executable", "copilot")
  .option("--dry-run", "Write benchmark prompts/reports but do not invoke Copilot CLI")
  .option("--no-worktree", "Run live benchmark in the current worktree instead of isolated git worktrees")
  .action(
    async (
      suitePath: string,
      options: {
        db?: string;
        variant?: string[];
        budget: string;
        model: string;
        executable: string;
        dryRun?: boolean;
        worktree?: boolean;
      }
    ) => {
      const rootPath = process.cwd();
      const store = openStore(rootPath, options.db);
      const suite = await loadBenchmarkSuite(path.resolve(suitePath));
      const variants = parseVariants(options.variant);
      const runner = new BenchmarkRunner(
        store,
        new CopilotCliAdapter({ executable: options.executable, defaultModel: options.model })
      );
      const report = await runner.runSuite(suite, {
        variants,
        budget: parseTokenBudget(options.budget),
        model: options.model,
        dryRun: options.dryRun === true,
        isolateWorktrees: options.dryRun === true ? false : options.worktree !== false
      });
      store.close();
      printJson(report);
    }
  );

benchmarkCommand
  .command("compare")
  .argument("<report>", "Benchmark report JSON file.")
  .description("Render a benchmark JSON report as Markdown.")
  .action(async (reportPath: string) => {
    const { readFile } = await import("node:fs/promises");
    const report = JSON.parse(await readFile(path.resolve(reportPath), "utf8"));
    console.log(renderMarkdownReport(report));
  });

const integrateCommand = program.command("integrate").description("Install or inspect coding-tool integrations.");
const integrateCopilotCommand = integrateCommand.command("copilot").description("Manage non-invasive Copilot CLI integration.");
integrateCopilotCommand
  .command("install")
  .description("Install project-local Copilot MCP configuration and instructions.")
  .option("--root <path>", "Repository root", process.cwd())
  .option("--db <path>", "SQLite database path")
  .option("--dry-run", "Show planned changes without writing files or indexing")
  .option("--skip-index", "Do not index the repository during install")
  .action(async (options: { root: string; db?: string; dryRun?: boolean; skipIndex?: boolean }) => {
    const rootPath = path.resolve(options.root);
    const dryRun = options.dryRun === true;
    const skipIndex = options.skipIndex === true;
    const mcpCommand = integrationMcpCommand(rootPath, options.db);
    let indexResult: unknown = null;

    if (!dryRun && !skipIndex) {
      const store = openStore(rootPath, options.db);
      const indexer = new RepositoryIndexer(store);
      indexResult = await indexer.index(rootPath, await currentHead(rootPath));
      store.close();
    }

    const result = await installCopilotIntegration({ rootPath, dryRun, mcpCommand });
    printJson({
      ...result,
      indexed: indexResult,
      nextCommand: "copilot",
      message: dryRun
        ? "Dry run complete. Re-run without --dry-run to install the Copilot integration."
        : "Copilot integration installed. Keep using `copilot`; llm-mem is available through MCP and repo instructions."
    });
  });

integrateCopilotCommand
  .command("status")
  .description("Show whether the project-local Copilot integration is installed.")
  .option("--root <path>", "Repository root", process.cwd())
  .option("--db <path>", "SQLite database path")
  .action(async (options: { root: string; db?: string }) => {
    const rootPath = path.resolve(options.root);
    printJson(await getCopilotIntegrationStatus({ rootPath, mcpCommand: integrationMcpCommand(rootPath, options.db) }));
  });

integrateCopilotCommand
  .command("uninstall")
  .description("Remove only the llm-mem Copilot integration files/blocks.")
  .option("--root <path>", "Repository root", process.cwd())
  .option("--db <path>", "SQLite database path")
  .option("--dry-run", "Show planned changes without writing files")
  .action(async (options: { root: string; db?: string; dryRun?: boolean }) => {
    const rootPath = path.resolve(options.root);
    const dryRun = options.dryRun === true;
    const result = await uninstallCopilotIntegration({
      rootPath,
      dryRun,
      mcpCommand: integrationMcpCommand(rootPath, options.db)
    });
    printJson({
      ...result,
      message: dryRun
        ? "Dry run complete. Re-run without --dry-run to uninstall the Copilot integration."
        : "Copilot integration removed. Unrelated MCP servers and instructions were preserved."
    });
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

const mcpCommand = program.command("mcp").description("Run llm-mem MCP server transports.");
mcpCommand
  .command("stdio")
  .description("Start the llm-mem MCP server over stdio.")
  .option("--root <path>", "Repository root", process.cwd())
  .option("--db <path>", "SQLite database path")
  .action((options: { root: string; db?: string }) => {
    startMcpServer({
      rootPath: path.resolve(options.root),
      ...(options.db === undefined ? {} : { databasePath: path.resolve(options.db) })
    });
  });

await program.parseAsync(process.argv);

function parseTokenBudget(input: string): number {
  const value = Number.parseInt(input, 10);
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 64) {
    throw new Error("Token budget must be a finite integer >= 64.");
  }

  return value;
}

function parseVariants(input: string[] | undefined): BenchmarkVariant[] {
  const variants = input ?? ["baseline-copilot", "llm-mem-context"];
  const allowed = new Set(["baseline-copilot", "llm-mem-context"]);

  for (const variant of variants) {
    if (!allowed.has(variant)) {
      throw new Error(`Invalid benchmark variant: ${variant}`);
    }
  }

  return variants as BenchmarkVariant[];
}

function openStore(rootPath: string, databasePath?: string): SQLiteStore {
  const store = new SQLiteStore({ databasePath: databasePath ?? defaultDatabasePath(rootPath) });
  store.initialize();
  return store;
}

function defaultDatabasePath(rootPath: string): string {
  return path.join(rootPath, ".llm-mem", "llm-mem.db");
}

function integrationMcpCommand(rootPath: string, databasePath?: string): { command: string; args: string[] } {
  const command = currentCliMcpCommand() ?? defaultMcpCommand(rootPath);
  if (databasePath === undefined) {
    return command;
  }

  return {
    command: command.command,
    args: [...command.args, "--db", path.resolve(databasePath)]
  };
}

function currentCliMcpCommand(): { command: string; args: string[] } | undefined {
  if (process.argv[1] === undefined || path.extname(process.argv[1]) !== ".js") {
    return undefined;
  }

  return {
    command: process.execPath,
    args: [path.resolve(process.argv[1]), "mcp", "stdio", "--root", "."]
  };
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
