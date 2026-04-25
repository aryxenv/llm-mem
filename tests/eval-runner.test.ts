import { describe, expect, it } from "vitest";
import type { ContextRetriever } from "../packages/core/src/index.js";
import { EvalRunner } from "../packages/evals/src/index.js";

describe("EvalRunner", () => {
  it("scores context recall from context-pack citations", async () => {
    const retriever: ContextRetriever = {
      async retrieve() {
        return [
          {
            id: "cache",
            kind: "chunk",
            title: "cache.ts",
            content: "export function invalidateCache() {}",
            score: 1,
            confidence: 1,
            sourceRefs: [{ kind: "file", uri: "cache.ts", trust: "observed" }]
          }
        ];
      }
    };
    const runner = new EvalRunner(retriever);
    const result = await runner.run(
      [
        {
          id: "scenario",
          taskType: "codebase_qa",
          prompt: "How does cache invalidation work?",
          goldFiles: ["cache.ts"],
          metrics: ["context_recall"]
        }
      ],
      { repoId: "repo", maxTokens: 1000 }
    );

    expect(result.aggregate.scenarioCount).toBe(1);
    expect(result.scenarios[0]?.contextRecall).toBe(1);
  });
});
