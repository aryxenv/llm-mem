import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
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

  it("indexes symbols and bridges PascalCase queries to kebab-case source paths", async () => {
    const repoDir = await mkdtemp(path.join(os.tmpdir(), "llm-mem-test-"));
    tempDirs.push(repoDir);
    await mkdir(path.join(repoDir, "packages", "core", "src"), { recursive: true });
    await mkdir(path.join(repoDir, "docs"), { recursive: true });
    await writeFile(
      path.join(repoDir, "packages", "core", "src", "context-compiler.ts"),
      [
        "export class ContextCompiler {",
        "  public async compile() {",
        "    return this.createTaskSummary();",
        "  }",
        "",
        "  private createTaskSummary() {",
        "    return 'summary';",
        "  }",
        "}"
      ].join("\n"),
      "utf8"
    );
    await writeFile(
      path.join(repoDir, "docs", "overview.md"),
      "The context compiler creates context packs for coding agents.\n",
      "utf8"
    );

    const store = new SQLiteStore({ databasePath: path.join(repoDir, ".llm-mem", "test.db") });
    store.initialize();
    const indexer = new RepositoryIndexer(store);
    const indexResult = await indexer.index(repoDir);

    const symbols = store.searchSymbols(indexResult.repo.id, "ContextCompiler compile createTaskSummary", 10);
    const compiler = new ContextCompiler(store);
    const pack = await compiler.compile(
      {
        task: "Explain how llm-mem's ContextCompiler builds a context pack and identify the main files involved.",
        repoId: indexResult.repo.id
      },
      { maxTokens: 1200 }
    );

    expect(symbols[0]?.sourceRefs[0]?.uri).toBe("packages/core/src/context-compiler.ts");
    expect(symbols[0]?.matchReasons).toContain("exact-symbol");
    expect(pack.citations.map((source) => source.uri)).toContain("packages/core/src/context-compiler.ts");
    store.close();
  });

  it("still retrieves memories for natural-language decision questions", async () => {
    const repoDir = await mkdtemp(path.join(os.tmpdir(), "llm-mem-test-"));
    tempDirs.push(repoDir);
    const store = new SQLiteStore({ databasePath: path.join(repoDir, ".llm-mem", "test.db") });
    store.initialize();
    const repo = await store.upsertRepo(repoDir);
    store.rememberMemory({
      repoId: repo.id,
      type: "decision",
      title: "Use SQLite storage",
      content: "We chose SQLite storage because llm-mem is local-first and needs a portable embedded index.",
      confidence: 0.9,
      sourceRefs: []
    });

    const direct = store.searchMemories(repo.id, "sqlite storage", 10);
    const retrieved = await store.retrieve({ repoId: repo.id, task: "Why did we choose sqlite storage?" }, 10);

    expect(direct).toHaveLength(1);
    expect(retrieved.some((candidate) => candidate.kind === "decision" && candidate.title === "Use SQLite storage")).toBe(
      true
    );
    store.close();
  });

  it("expands symbol snippets across chunk boundaries", async () => {
    const repoDir = await mkdtemp(path.join(os.tmpdir(), "llm-mem-test-"));
    tempDirs.push(repoDir);
    const body = Array.from({ length: 45 }, (_, index) => `    value += ${index};`).join("\n");
    await writeFile(
      path.join(repoDir, "large.ts"),
      ["export class LargeSymbol {", "  run() {", "    let value = 0;", body, "    return value;", "  }", "}"].join("\n"),
      "utf8"
    );

    const store = new SQLiteStore({ databasePath: path.join(repoDir, ".llm-mem", "test.db") });
    store.initialize();
    const indexer = new RepositoryIndexer(store, { chunkLineCount: 20, chunkOverlapLines: 0 });
    const indexResult = await indexer.index(repoDir);
    const symbol = store.searchSymbols(indexResult.repo.id, "LargeSymbol", 5)[0];
    const snippet = store.getCandidateByExpansionId(indexResult.repo.id, symbol?.expansionId ?? "", 2000);

    expect(symbol?.expansionId).toMatch(/^symbol:/);
    expect(snippet?.content).toContain("export class LargeSymbol");
    expect(snippet?.content).toContain("value += 44");
    expect(snippet?.content).not.toContain("Defined in large.ts");
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
    expect(store.searchSymbols(firstIndex.repo.id, "staleToken", 10)).toHaveLength(0);
    store.close();
  });
});
