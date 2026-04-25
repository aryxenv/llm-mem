import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  BenchmarkRunner,
  CopilotCliAdapter,
  buildCopilotPrompt,
  parseCopilotOtelTokenUsage
} from "../packages/benchmarks/src/index.js";
import type { ContextPack } from "../packages/core/src/index.js";
import { SQLiteStore } from "../packages/storage/src/index.js";

const tempDirs: string[] = [];
const execFileAsync = promisify(execFile);

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("benchmark support", () => {
  it("builds Copilot prompts with context-pack citations", () => {
    const pack: ContextPack = {
      id: "pack-1",
      task: "Explain compiler",
      createdAt: new Date(0).toISOString(),
      budget: { maxTokens: 1000, usedEstimate: 100, reservedTokens: 100 },
      sections: [
        {
          type: "retrieved_context",
          title: "compiler",
          content: "ContextCompiler creates context packs.",
          tokens: 20,
          sourceRefs: [{ kind: "file", uri: "packages/core/src/context-compiler.ts", trust: "observed" }]
        }
      ],
      citations: [{ kind: "file", uri: "packages/core/src/context-compiler.ts", trust: "observed" }],
      metadata: {
        compilerVersion: "0.1.0",
        retrievalCandidateCount: 1,
        truncatedCandidateCount: 0,
        modelPolicy: "preferred:gpt-5.5"
      }
    };

    const built = buildCopilotPrompt({ task: "Explain compiler", contextPack: pack });

    expect(built.prompt).toContain("source-grounded llm-mem context pack");
    expect(built.prompt).toContain("packages/core/src/context-compiler.ts");
    expect(built.estimatedTokens).toBeGreaterThan(0);
  });

  it("supports Copilot adapter dry runs", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "llm-mem-benchmark-"));
    tempDirs.push(tempDir);
    const adapter = new CopilotCliAdapter({ executable: "copilot" });

    const result = await adapter.run({
      cwd: tempDir,
      prompt: "Do not run.",
      outputDirectory: path.join(tempDir, "out"),
      dryRun: true
    });

    expect(result.dryRun).toBe(true);
    expect(result.args).toContain("--model");
    expect(result.promptTransport).toBe("argv");
    expect(result.promptTokensEstimate).toBeGreaterThan(0);
  });

  it("uses prompt files for large Copilot prompts", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "llm-mem-benchmark-"));
    tempDirs.push(tempDir);
    const adapter = new CopilotCliAdapter({ executable: "copilot" });

    const result = await adapter.run({
      cwd: tempDir,
      prompt: "x".repeat(7000),
      outputDirectory: path.join(tempDir, "out"),
      dryRun: true
    });

    expect(result.promptTransport).toBe("file");
    expect(result.args).toContain("--add-dir");
    expect(result.args.at(-1)).toContain("Read the full task prompt");
  });

  it("runs a benchmark with a fake Copilot executable", async () => {
    const repoDir = await mkdtemp(path.join(os.tmpdir(), "llm-mem-benchmark-repo-"));
    tempDirs.push(repoDir);
    await writeFile(
      path.join(repoDir, "target.ts"),
      "export function TargetSymbol() { return 'ok'; }\n",
      "utf8"
    );
    const fakeCopilot = path.join(repoDir, "fake-copilot.mjs");
    await writeFile(
      fakeCopilot,
      "console.log(JSON.stringify({ ok: true, args: process.argv.slice(2) }));\n",
      "utf8"
    );

    const store = new SQLiteStore({ databasePath: path.join(repoDir, ".llm-mem", "test.db") });
    store.initialize();
    const runner = new BenchmarkRunner(
      store,
      new CopilotCliAdapter({ executable: process.execPath, executableArgs: [fakeCopilot] })
    );
    const report = await runner.runSuite(
      {
        name: "fake-suite",
        source: "unit-test",
        tasks: [
          {
            id: "target-task",
            prompt: "TargetSymbol",
            repoRoot: repoDir,
            goldFiles: ["target.ts"]
          }
        ]
      },
      {
        variants: ["baseline-copilot", "llm-mem-context"],
        budget: 1000,
        repeat: 2,
        outputRoot: path.join(repoDir, ".llm-mem", "benchmarks", "test-run")
      }
    );

    expect(report.results).toHaveLength(4);
    expect(report.aggregate.resolvedByVariant["baseline-copilot"]).toBe(2);
    expect(report.aggregate.meanContextRecallByVariant["llm-mem-context"]).toBe(1);
    store.close();
  });

  it("uses unique isolated worktrees for repeated benchmark runs", async () => {
    const repoDir = await mkdtemp(path.join(os.tmpdir(), "llm-mem-benchmark-repo-"));
    const worktreesRoot = path.resolve(path.dirname(repoDir), `${path.basename(repoDir)}.benchmark-worktrees`);
    tempDirs.push(repoDir, worktreesRoot);
    await writeFile(path.join(repoDir, ".gitignore"), ".llm-mem/\n", "utf8");
    await writeFile(path.join(repoDir, "target.ts"), "export const repeated = true;\n", "utf8");
    const fakeCopilot = path.join(repoDir, "fake-copilot.mjs");
    await writeFile(fakeCopilot, "console.log('ContextCompiler context-compiler');\n", "utf8");
    await execFileAsync("git", ["init"], { cwd: repoDir });
    await execFileAsync("git", ["add", "."], { cwd: repoDir });
    await execFileAsync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "init"], {
      cwd: repoDir
    });

    const store = new SQLiteStore({ databasePath: path.join(repoDir, ".llm-mem", "test.db") });
    store.initialize();
    const runner = new BenchmarkRunner(
      store,
      new CopilotCliAdapter({ executable: process.execPath, executableArgs: [fakeCopilot] })
    );
    try {
      const report = await runner.runSuite(
        {
          name: "repeat-worktree-suite",
          tasks: [
            {
              id: "target-task",
              prompt: "Explain target.",
              repoRoot: repoDir
            }
          ]
        },
        {
          variants: ["baseline-copilot"],
          budget: 1000,
          repeat: 2,
          isolateWorktrees: true,
          outputRoot: path.join(repoDir, ".llm-mem", "benchmarks", "repeat-worktrees")
        }
      );

      expect(report.results).toHaveLength(2);
      expect(report.results[0]?.worktreePath).toContain("repeat-1");
      expect(report.results[1]?.worktreePath).toContain("repeat-2");
      expect(report.results[0]?.worktreePath).not.toBe(report.results[1]?.worktreePath);
    } finally {
      store.close();
    }
  });

  it("fails OTel-sourced benchmark runs when Copilot emits no token spans", async () => {
    const repoDir = await mkdtemp(path.join(os.tmpdir(), "llm-mem-benchmark-repo-"));
    tempDirs.push(repoDir);
    const fakeCopilot = path.join(repoDir, "fake-copilot.mjs");
    await writeFile(fakeCopilot, "console.log('ContextCompiler context-compiler');\n", "utf8");
    const store = new SQLiteStore({ databasePath: path.join(repoDir, ".llm-mem", "test.db") });
    store.initialize();
    const runner = new BenchmarkRunner(
      store,
      new CopilotCliAdapter({ executable: process.execPath, executableArgs: [fakeCopilot] })
    );

    try {
      await expect(
        runner.runSuite(
          {
            name: "missing-otel-suite",
            tasks: [
              {
                id: "target-task",
                prompt: "Explain target.",
                repoRoot: repoDir
              }
            ]
          },
          {
            variants: ["baseline-copilot"],
            budget: 1000,
            tokenSource: "otel",
            outputRoot: path.join(repoDir, ".llm-mem", "benchmarks", "missing-otel")
          }
        )
      ).rejects.toThrow("OpenTelemetry token data");
    } finally {
      store.close();
    }
  });

  it("parses Copilot OTel token usage from chat spans", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "llm-mem-otel-"));
    tempDirs.push(tempDir);
    const otelPath = path.join(tempDir, "otel.jsonl");
    await writeFile(
      otelPath,
      [
        JSON.stringify({
          type: "span",
          name: "chat gpt-5.5",
          attributes: {
            "gen_ai.operation.name": "chat",
            "gen_ai.usage.input_tokens": 100,
            "gen_ai.usage.output_tokens": 20,
            "gen_ai.usage.reasoning.output_tokens": 12,
            "github.copilot.cost": 1.5
          }
        }),
        JSON.stringify({
          type: "span",
          name: "invoke_agent",
          attributes: {
            "gen_ai.operation.name": "invoke_agent",
            "gen_ai.usage.input_tokens": 100,
            "gen_ai.usage.output_tokens": 20
          }
        }),
        JSON.stringify({
          type: "span",
          name: "chat gpt-5.5",
          attributes: {
            "gen_ai.operation.name": "chat",
            "gen_ai.usage.input_tokens": 50,
            "gen_ai.usage.output_tokens": 10,
            "github.copilot.cost": 0.5
          }
        })
      ].join("\n"),
      "utf8"
    );

    const usage = await parseCopilotOtelTokenUsage(otelPath);

    expect(usage.source).toBe("otel-spans");
    expect(usage.chatCallCount).toBe(2);
    expect(usage.inputTokens).toBe(150);
    expect(usage.outputTokens).toBe(30);
    expect(usage.reasoningOutputTokens).toBe(12);
    expect(usage.totalTokens).toBe(180);
    expect(usage.cost).toBe(2);
  });
});
