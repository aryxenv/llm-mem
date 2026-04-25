import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BenchmarkRunner, CopilotCliAdapter, buildCopilotPrompt } from "../packages/benchmarks/src/index.js";
import type { ContextPack } from "../packages/core/src/index.js";
import { SQLiteStore } from "../packages/storage/src/index.js";

const tempDirs: string[] = [];

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
        outputRoot: path.join(repoDir, ".llm-mem", "benchmarks", "test-run")
      }
    );

    expect(report.results).toHaveLength(2);
    expect(report.aggregate.resolvedByVariant["baseline-copilot"]).toBe(1);
    expect(report.aggregate.meanContextRecallByVariant["llm-mem-context"]).toBe(1);
    store.close();
  });
});
