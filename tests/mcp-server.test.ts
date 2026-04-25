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
