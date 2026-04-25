import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { startMcpServer } from "../apps/mcp-server/src/index.js";
import { RepositoryIndexer } from "../packages/indexer/src/index.js";
import { SQLiteStore } from "../packages/storage/src/index.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("MCP server", () => {
  it("resolves the current repository when context_pack is called without repoId", async () => {
    const repoDir = await mkdtemp(path.join(os.tmpdir(), "llm-mem-mcp-repo-"));
    tempDirs.push(repoDir);
    await writeFile(path.join(repoDir, "target.ts"), "export const TargetSymbol = 'indexed';\n", "utf8");
    const databasePath = path.join(repoDir, ".llm-mem", "test.db");
    const store = new SQLiteStore({ databasePath });
    store.initialize();
    await new RepositoryIndexer(store).index(repoDir, "test-head");
    store.close();
    const input = new PassThrough();
    const output = new PassThrough();
    const server = startMcpServer({ rootPath: repoDir, databasePath, input, output });
    const responsePromise = nextJsonLine(output);

    input.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "llm_mem.context_pack",
          arguments: { task: "TargetSymbol" }
        }
      })}\n`
    );

    const response = (await responsePromise) as {
      result: { content: Array<{ text: string }> };
    };
    const pack = JSON.parse(response.result.content[0]?.text ?? "{}") as {
      sections: Array<{ content: string }>;
    };

    expect(pack.sections.some((section) => section.content.includes("TargetSymbol"))).toBe(true);
    server.close();
  });

  it("returns a compact context_map and expands snippets by expansionId", async () => {
    const repoDir = await mkdtemp(path.join(os.tmpdir(), "llm-mem-mcp-repo-"));
    tempDirs.push(repoDir);
    await writeFile(
      path.join(repoDir, "target.ts"),
      "export class TargetSymbol {\n  run() {\n    return 'indexed';\n  }\n}\n",
      "utf8"
    );
    const databasePath = path.join(repoDir, ".llm-mem", "test.db");
    const store = new SQLiteStore({ databasePath });
    store.initialize();
    await new RepositoryIndexer(store).index(repoDir, "test-head");
    store.close();
    const input = new PassThrough();
    const output = new PassThrough();
    const server = startMcpServer({ rootPath: repoDir, databasePath, input, output });

    const mapResponsePromise = nextJsonLine(output);
    input.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "llm_mem.context_map",
          arguments: { task: "Explain TargetSymbol", maxCandidates: 4 }
        }
      })}\n`
    );

    const mapResponse = (await mapResponsePromise) as {
      result: { content: Array<{ text: string }> };
    };
    const map = JSON.parse(mapResponse.result.content[0]?.text ?? "{}") as {
      candidates: Array<{ expansionId?: string; title: string; content?: string }>;
    };
    const expansionId = map.candidates[0]?.expansionId;
    expect(map.candidates[0]?.title).toContain("target.ts");
    expect(map.candidates[0]?.content).toBeUndefined();
    expect(expansionId).toBeTruthy();

    const snippetResponsePromise = nextJsonLine(output);
    input.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "llm_mem.snippet",
          arguments: { expansionId, maxTokens: 300 }
        }
      })}\n`
    );

    const snippetResponse = (await snippetResponsePromise) as {
      result: { content: Array<{ text: string }> };
    };
    const snippet = JSON.parse(snippetResponse.result.content[0]?.text ?? "{}") as {
      content: string;
      sourceRefs: Array<{ uri: string }>;
    };
    expect(snippet.content).toContain("TargetSymbol");
    expect(snippet.sourceRefs[0]?.uri).toBe("target.ts");
    server.close();
  });

  it("uses workingDirectory repo resolution before server root fallback", async () => {
    const rootRepo = await mkdtemp(path.join(os.tmpdir(), "llm-mem-mcp-root-"));
    const worktreeRepo = await mkdtemp(path.join(os.tmpdir(), "llm-mem-mcp-worktree-"));
    tempDirs.push(rootRepo, worktreeRepo);
    await writeFile(path.join(rootRepo, "root.ts"), "export const RootOnlySymbol = true;\n", "utf8");
    await writeFile(path.join(worktreeRepo, "worktree.ts"), "export const WorktreeOnlySymbol = true;\n", "utf8");
    const databasePath = path.join(rootRepo, ".llm-mem", "test.db");
    const store = new SQLiteStore({ databasePath });
    store.initialize();
    await new RepositoryIndexer(store).index(rootRepo, "root-head");
    await new RepositoryIndexer(store).index(worktreeRepo, "worktree-head");
    store.close();
    const input = new PassThrough();
    const output = new PassThrough();
    const server = startMcpServer({ rootPath: rootRepo, databasePath, input, output });
    const responsePromise = nextJsonLine(output);

    input.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "llm_mem.context_map",
          arguments: { task: "WorktreeOnlySymbol", workingDirectory: worktreeRepo }
        }
      })}\n`
    );

    const response = (await responsePromise) as {
      result: { content: Array<{ text: string }> };
    };
    const map = JSON.parse(response.result.content[0]?.text ?? "{}") as {
      candidates: Array<{ title: string }>;
    };
    expect(map.candidates[0]?.title).toContain("worktree.ts");
    server.close();
  });
});

function nextJsonLine(output: PassThrough): Promise<unknown> {
  let buffer = "";
  return new Promise((resolve) => {
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) {
        return;
      }
      output.off("data", onData);
      resolve(JSON.parse(buffer.slice(0, newlineIndex)) as unknown);
    };
    output.on("data", onData);
  });
}
