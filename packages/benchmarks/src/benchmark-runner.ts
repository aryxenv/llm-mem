import { exec, execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { ContextCompiler, estimateTokens, type ContextPack } from "@llm-mem/core";
import { RepositoryIndexer } from "@llm-mem/indexer";
import { SQLiteStore } from "@llm-mem/storage";
import { CopilotCliAdapter, type CopilotRunResult } from "./copilot-adapter.js";
import { buildCopilotPrompt } from "./prompt-builder.js";

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

export const BenchmarkTaskSchema = z.object({
  id: z.string().min(1),
  prompt: z.string().min(1),
  repoRoot: z.string().optional(),
  baseRef: z.string().optional(),
  testCommand: z.string().optional(),
  goldFiles: z.array(z.string()).default([]),
  timeoutMs: z.number().int().positive().optional()
});

export const BenchmarkSuiteSchema = z.object({
  name: z.string().min(1),
  source: z.string().optional(),
  tasks: z.array(BenchmarkTaskSchema)
});

export type BenchmarkTask = z.infer<typeof BenchmarkTaskSchema>;
export type BenchmarkSuite = z.infer<typeof BenchmarkSuiteSchema>;
export type BenchmarkVariant = "baseline-copilot" | "llm-mem-context";

export interface BenchmarkRunOptions {
  variants: BenchmarkVariant[];
  budget: number;
  model?: string;
  dryRun?: boolean;
  isolateWorktrees?: boolean;
  outputRoot?: string;
}

export interface BenchmarkTaskResult {
  id: string;
  taskId: string;
  suiteName: string;
  variant: BenchmarkVariant;
  promptTokensEstimate: number;
  contextTokensEstimate: number;
  outputTokensEstimate: number;
  durationMs: number;
  exitCode: number | null;
  testExitCode: number | null;
  resolved: boolean;
  worktreePath?: string;
  contextRecall: number;
  citedGoldFiles: string[];
  missingGoldFiles: string[];
  outputDirectory: string;
}

export interface BenchmarkRunReport {
  id: string;
  suiteName: string;
  source?: string;
  startedAt: string;
  finishedAt: string;
  variants: BenchmarkVariant[];
  results: BenchmarkTaskResult[];
  aggregate: {
    taskCount: number;
    resultCount: number;
    resolvedByVariant: Record<string, number>;
    meanPromptTokensByVariant: Record<string, number>;
    meanContextRecallByVariant: Record<string, number>;
  };
}

export async function loadBenchmarkSuite(filePath: string): Promise<BenchmarkSuite> {
  const raw = await readFile(filePath, "utf8");
  return BenchmarkSuiteSchema.parse(JSON.parse(raw));
}

export class BenchmarkRunner {
  public constructor(
    private readonly store: SQLiteStore,
    private readonly copilot: CopilotCliAdapter
  ) {}

  public async runSuite(suite: BenchmarkSuite, options: BenchmarkRunOptions): Promise<BenchmarkRunReport> {
    const startedAt = new Date();
    const runId = randomUUID();
    const outputRoot = path.resolve(options.outputRoot ?? path.join(process.cwd(), ".llm-mem", "benchmarks", runId));
    const benchmarkRun = this.store.createBenchmarkRun({
      suiteName: suite.name,
      variants: options.variants,
      metadata: { source: suite.source ?? null, dryRun: options.dryRun === true }
    });
    const results: BenchmarkTaskResult[] = [];

    for (const task of suite.tasks) {
      for (const variant of options.variants) {
        results.push(await this.runTaskVariant(suite, task, variant, options, outputRoot, benchmarkRun.id));
      }
    }

    this.store.finishBenchmarkRun(benchmarkRun.id);
    const finishedAt = new Date();
    const report = {
      id: benchmarkRun.id,
      suiteName: suite.name,
      ...(suite.source === undefined ? {} : { source: suite.source }),
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      variants: options.variants,
      results,
      aggregate: aggregateResults(suite.tasks.length, results)
    };
    await mkdir(outputRoot, { recursive: true });
    await writeFile(path.join(outputRoot, "report.json"), JSON.stringify(report, null, 2), "utf8");
    await writeFile(path.join(outputRoot, "report.md"), renderMarkdownReport(report), "utf8");
    return report;
  }

  private async runTaskVariant(
    suite: BenchmarkSuite,
    task: BenchmarkTask,
    variant: BenchmarkVariant,
    options: BenchmarkRunOptions,
    outputRoot: string,
    runId: string
  ): Promise<BenchmarkTaskResult> {
    const repoRoot = path.resolve(task.repoRoot ?? process.cwd());
    const outputDirectory = path.join(outputRoot, sanitizePathSegment(task.id), variant);
    const worktreePath =
      options.isolateWorktrees === true
        ? await createBenchmarkWorktree(repoRoot, outputRoot, task, variant, task.baseRef)
        : undefined;
    const runCwd = worktreePath ?? repoRoot;
    let contextPack: ContextPack | undefined;

    if (variant === "llm-mem-context") {
      const indexer = new RepositoryIndexer(this.store);
      const contextHead = (await tryGitOutput(runCwd, ["rev-parse", "HEAD"]))?.trim() ?? task.baseRef;
      const repo = this.store.getRepoByRoot(runCwd) ?? (await this.store.upsertRepo(runCwd, contextHead));
      await indexer.index(runCwd, contextHead);
      const compiler = new ContextCompiler(this.store);
      contextPack = await compiler.compile(
        { task: task.prompt, repoId: repo.id, workingDirectory: runCwd },
        { maxTokens: options.budget, modelPolicy: "preferred:gpt-5.5" }
      );
      this.store.recordContextPack(contextPack);
    }

    const builtPrompt = buildCopilotPrompt({ task: task.prompt, ...(contextPack === undefined ? {} : { contextPack }) });
    const copilotResult = await this.copilot.run({
      cwd: runCwd,
      prompt: builtPrompt.prompt,
      outputDirectory,
      model: options.model ?? "gpt-5.5",
      dryRun: options.dryRun === true
    });
    const testResult = await runTestCommand(runCwd, task.testCommand, task.timeoutMs);
    const worktreeStatus = worktreePath === undefined ? "" : await gitOutput(runCwd, ["status", "--porcelain"]);
    const recall = scoreContextRecall(task.goldFiles, contextPack);
    const outputTokensEstimate = estimateTokens(copilotResult.stdout);
    const resolved = copilotResult.exitCode === 0 && (testResult.exitCode === null || testResult.exitCode === 0);
    const result: BenchmarkTaskResult = {
      id: randomUUID(),
      taskId: task.id,
      suiteName: suite.name,
      variant,
      promptTokensEstimate: copilotResult.promptTokensEstimate,
      contextTokensEstimate: contextPack?.budget.usedEstimate ?? 0,
      outputTokensEstimate,
      durationMs: copilotResult.durationMs + testResult.durationMs,
      exitCode: copilotResult.exitCode,
      testExitCode: testResult.exitCode,
      resolved,
      ...(worktreePath === undefined ? {} : { worktreePath }),
      contextRecall: recall.contextRecall,
      citedGoldFiles: recall.citedGoldFiles,
      missingGoldFiles: recall.missingGoldFiles,
      outputDirectory
    };

    await writeFile(path.join(outputDirectory, "task-result.json"), JSON.stringify(result, null, 2), "utf8");
    this.store.recordBenchmarkResult({
      runId,
      taskId: task.id,
      variant,
      resolved,
      promptTokensEstimate: result.promptTokensEstimate,
      contextTokensEstimate: result.contextTokensEstimate,
      outputTokensEstimate,
      durationMs: result.durationMs,
      testExitCode: result.testExitCode,
      contextRecall: result.contextRecall,
      artifacts: { outputDirectory, copilot: copilotResult, test: testResult, worktreeStatus }
    });
    return result;
  }
}

async function createBenchmarkWorktree(
  repoRoot: string,
  outputRoot: string,
  task: BenchmarkTask,
  variant: BenchmarkVariant,
  baseRef: string | undefined
): Promise<string> {
  const status = await gitOutput(repoRoot, ["status", "--porcelain"]);
  if (status.trim().length > 0) {
    throw new Error("Refusing to create benchmark worktree from a dirty repository. Commit or stash changes first.");
  }

  const worktreesRoot = path.resolve(path.dirname(repoRoot), `${path.basename(repoRoot)}.benchmark-worktrees`);
  const worktreePath = path.join(worktreesRoot, sanitizePathSegment(path.basename(outputRoot)), `${sanitizePathSegment(task.id)}-${variant}`);
  const branch = `llm-mem/bench/${sanitizePathSegment(path.basename(outputRoot))}/${sanitizePathSegment(task.id)}-${variant}`;
  await mkdir(path.dirname(worktreePath), { recursive: true });
  await execFileAsync("git", ["worktree", "add", "-b", branch, worktreePath, baseRef ?? "HEAD"], {
    cwd: repoRoot,
    windowsHide: true,
    maxBuffer: 10 * 1024 * 1024
  });
  return worktreePath;
}

async function gitOutput(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd,
    windowsHide: true,
    maxBuffer: 10 * 1024 * 1024
  });
  return result.stdout;
}

async function tryGitOutput(cwd: string, args: string[]): Promise<string | undefined> {
  try {
    return await gitOutput(cwd, args);
  } catch {
    return undefined;
  }
}

function scoreContextRecall(goldFiles: string[], contextPack: ContextPack | undefined): {
  contextRecall: number;
  citedGoldFiles: string[];
  missingGoldFiles: string[];
} {
  if (goldFiles.length === 0) {
    return { contextRecall: 1, citedGoldFiles: [], missingGoldFiles: [] };
  }

  const citedUris = new Set((contextPack?.citations ?? []).map((sourceRef) => normalizePath(sourceRef.uri)));
  const normalizedGoldFiles = goldFiles.map(normalizePath);
  const citedGoldFiles = normalizedGoldFiles.filter((goldFile) =>
    [...citedUris].some((uri) => uri === goldFile || uri.endsWith(`/${goldFile}`))
  );
  const missingGoldFiles = normalizedGoldFiles.filter((goldFile) => !citedGoldFiles.includes(goldFile));
  return {
    contextRecall: citedGoldFiles.length / normalizedGoldFiles.length,
    citedGoldFiles,
    missingGoldFiles
  };
}

async function runTestCommand(
  cwd: string,
  testCommand: string | undefined,
  timeoutMs: number | undefined
): Promise<{ exitCode: number | null; stdout: string; stderr: string; durationMs: number }> {
  if (!testCommand) {
    return { exitCode: null, stdout: "", stderr: "", durationMs: 0 };
  }

  const startedAt = Date.now();
  try {
    const result = await execAsync(testCommand, { cwd, timeout: timeoutMs ?? 120_000, windowsHide: true });
    return { exitCode: 0, stdout: result.stdout, stderr: result.stderr, durationMs: Date.now() - startedAt };
  } catch (error) {
    const execError = error as { code?: number; stdout?: string; stderr?: string };
    return {
      exitCode: typeof execError.code === "number" ? execError.code : 1,
      stdout: execError.stdout ?? "",
      stderr: execError.stderr ?? String(error),
      durationMs: Date.now() - startedAt
    };
  }
}

function aggregateResults(taskCount: number, results: BenchmarkTaskResult[]): BenchmarkRunReport["aggregate"] {
  const variants = [...new Set(results.map((result) => result.variant))];
  const resolvedByVariant: Record<string, number> = {};
  const meanPromptTokensByVariant: Record<string, number> = {};
  const meanContextRecallByVariant: Record<string, number> = {};

  for (const variant of variants) {
    const variantResults = results.filter((result) => result.variant === variant);
    resolvedByVariant[variant] = variantResults.filter((result) => result.resolved).length;
    meanPromptTokensByVariant[variant] = mean(variantResults.map((result) => result.promptTokensEstimate));
    meanContextRecallByVariant[variant] = mean(variantResults.map((result) => result.contextRecall));
  }

  return {
    taskCount,
    resultCount: results.length,
    resolvedByVariant,
    meanPromptTokensByVariant,
    meanContextRecallByVariant
  };
}

export function renderMarkdownReport(report: BenchmarkRunReport): string {
  const rows = report.results
    .map(
      (result) =>
        `| ${result.taskId} | ${result.variant} | ${result.resolved ? "yes" : "no"} | ${result.promptTokensEstimate} | ${result.contextTokensEstimate} | ${result.contextRecall.toFixed(2)} | ${result.worktreePath ?? ""} |`
    )
    .join("\n");

  return [
    `# Benchmark report: ${report.suiteName}`,
    "",
    `Run: \`${report.id}\``,
    report.source ? `Source: ${report.source}` : undefined,
    "",
    "| Task | Variant | Resolved | Prompt tokens | Context tokens | Context recall | Worktree |",
    "|---|---|---:|---:|---:|---:|---|",
    rows,
    "",
    "## Aggregate",
    "",
    "```json",
    JSON.stringify(report.aggregate, null, 2),
    "```"
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

function mean(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function normalizePath(input: string): string {
  return input.replaceAll("\\", "/");
}

function sanitizePathSegment(input: string): string {
  return input.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}
