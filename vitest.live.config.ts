import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const fromRoot = (value: string) => fileURLToPath(new URL(value, import.meta.url));

export default defineConfig({
  test: {
    include: ["tests/live/**/*.test.ts"]
  },
  resolve: {
    alias: {
      "@llm-mem/core": fromRoot("./packages/core/src/index.ts"),
      "@llm-mem/security": fromRoot("./packages/security/src/index.ts"),
      "@llm-mem/storage": fromRoot("./packages/storage/src/index.ts"),
      "@llm-mem/indexer": fromRoot("./packages/indexer/src/index.ts"),
      "@llm-mem/worktrees": fromRoot("./packages/worktrees/src/index.ts"),
      "@llm-mem/agents": fromRoot("./packages/agents/src/index.ts"),
      "@llm-mem/benchmarks": fromRoot("./packages/benchmarks/src/index.ts"),
      "@llm-mem/evals": fromRoot("./packages/evals/src/index.ts")
    }
  }
});
