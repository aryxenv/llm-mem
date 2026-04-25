import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CopilotCliAdapter } from "../../packages/benchmarks/src/index.js";

const runLive = process.env.LLM_MEM_LIVE_COPILOT === "1";
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

(runLive ? describe : describe.skip)("live Copilot CLI smoke", () => {
  it("can invoke Copilot CLI without editing files", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "llm-mem-live-copilot-"));
    tempDirs.push(tempDir);
    const adapter = new CopilotCliAdapter();

    const result = await adapter.run({
      cwd: tempDir,
      prompt: "Reply with exactly: llm-mem-live-ok. Do not create or edit files.",
      outputDirectory: path.join(tempDir, "out"),
      allowAllTools: false,
      noAskUser: true,
      outputFormat: "text"
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("llm-mem-live-ok");
  }, 180000);
});
