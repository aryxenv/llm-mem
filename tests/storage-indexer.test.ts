import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ContextCompiler } from "../packages/core/src/index.js";
import { RepositoryIndexer } from "../packages/indexer/src/index.js";
import { SQLiteStore } from "../packages/storage/src/index.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("storage and indexer integration", () => {
  it("indexes source files and retrieves them into a context pack", async () => {
    const repoDir = await mkdtemp(path.join(os.tmpdir(), "llm-mem-test-"));
    tempDirs.push(repoDir);
    await writeFile(
      path.join(repoDir, "cache.ts"),
      "export function invalidateCache(key: string) {\n  return key.length > 0;\n}\n",
      "utf8"
    );

    const store = new SQLiteStore({ databasePath: path.join(repoDir, ".llm-mem", "test.db") });
    store.initialize();
    const indexer = new RepositoryIndexer(store);
    const indexResult = await indexer.index(repoDir);

    const compiler = new ContextCompiler(store);
    const pack = await compiler.compile(
      { task: "How does invalidateCache work?", repoId: indexResult.repo.id },
      { maxTokens: 1200 }
    );

    expect(indexResult.indexedFiles).toBe(1);
    expect(pack.sections.map((section) => section.content).join("\n")).toContain("invalidateCache");
    store.close();
  });

  it("prunes deleted files when re-indexing", async () => {
    const repoDir = await mkdtemp(path.join(os.tmpdir(), "llm-mem-test-"));
    tempDirs.push(repoDir);
    const stalePath = path.join(repoDir, "stale.ts");
    await writeFile(stalePath, "export const staleToken = true;\n", "utf8");

    const store = new SQLiteStore({ databasePath: path.join(repoDir, ".llm-mem", "test.db") });
    store.initialize();
    const indexer = new RepositoryIndexer(store);
    const firstIndex = await indexer.index(repoDir);
    expect(store.searchChunks(firstIndex.repo.id, "staleToken", 10)).toHaveLength(1);

    await unlink(stalePath);
    await indexer.index(repoDir);

    expect(store.searchChunks(firstIndex.repo.id, "staleToken", 10)).toHaveLength(0);
    store.close();
  });
});
