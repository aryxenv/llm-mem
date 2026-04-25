import { describe, expect, it } from "vitest";
import { ContextCompiler, type ContextRetriever, type TaskInput } from "../packages/core/src/index.js";

describe("ContextCompiler", () => {
  it("builds a proof-carrying context pack within budget", async () => {
    const retriever: ContextRetriever = {
      async retrieve(_input: TaskInput) {
        return [
          {
            id: "candidate-1",
            kind: "chunk",
            title: "src/cache.ts:L1-L40",
            content: "export function invalidateCache(key: string) { return key.length > 0; }",
            score: 0.9,
            confidence: 0.95,
            sourceRefs: [
              {
                kind: "file",
                uri: "src/cache.ts",
                trust: "observed",
                startLine: 1,
                endLine: 40
              }
            ],
            freshness: "fresh",
            expansionId: "chunk:candidate-1"
          }
        ];
      }
    };

    const compiler = new ContextCompiler(retriever);
    const pack = await compiler.compile({ task: "Fix cache invalidation", repoId: "repo-1" }, { maxTokens: 800 });

    expect(pack.repoId).toBe("repo-1");
    expect(pack.budget.usedEstimate).toBeLessThanOrEqual(pack.budget.maxTokens);
    expect(pack.citations).toHaveLength(1);
    expect(pack.sections.some((section) => section.type === "retrieved_context")).toBe(true);
  });

  it("bounds oversized task summaries", async () => {
    const retriever: ContextRetriever = {
      async retrieve() {
        return [];
      }
    };
    const compiler = new ContextCompiler(retriever);
    const pack = await compiler.compile({ task: "x".repeat(10_000) }, { maxTokens: 100 });

    expect(pack.budget.usedEstimate).toBeLessThanOrEqual(pack.budget.maxTokens);
    expect(pack.sections[0]?.content).toContain("[truncated; request expansion]");
  });

  it("rejects invalid token budgets", async () => {
    const retriever: ContextRetriever = {
      async retrieve() {
        return [];
      }
    };
    const compiler = new ContextCompiler(retriever);

    await expect(compiler.compile({ task: "test" }, { maxTokens: Number.NaN })).rejects.toThrow("maxTokens");
    await expect(compiler.compile({ task: "test" }, { maxTokens: 1 })).rejects.toThrow("at least 64");
  });
});
