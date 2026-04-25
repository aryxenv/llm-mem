import { rm } from "node:fs/promises";

const targets = [
  "dist",
  "coverage",
  "tsconfig.tsbuildinfo",
  "apps/cli/dist",
  "apps/cli/tsconfig.tsbuildinfo",
  "apps/daemon/dist",
  "apps/daemon/tsconfig.tsbuildinfo",
  "apps/mcp-server/dist",
  "apps/mcp-server/tsconfig.tsbuildinfo",
  "packages/core/dist",
  "packages/core/tsconfig.tsbuildinfo",
  "packages/protocol/dist",
  "packages/protocol/tsconfig.tsbuildinfo",
  "packages/security/dist",
  "packages/security/tsconfig.tsbuildinfo",
  "packages/storage/dist",
  "packages/storage/tsconfig.tsbuildinfo",
  "packages/indexer/dist",
  "packages/indexer/tsconfig.tsbuildinfo",
  "packages/worktrees/dist",
  "packages/worktrees/tsconfig.tsbuildinfo",
  "packages/agents/dist",
  "packages/agents/tsconfig.tsbuildinfo",
  "packages/evals/dist",
  "packages/evals/tsconfig.tsbuildinfo",
  "packages/observability/dist",
  "packages/observability/tsconfig.tsbuildinfo"
];

await Promise.all(targets.map((target) => rm(target, { recursive: true, force: true })));
