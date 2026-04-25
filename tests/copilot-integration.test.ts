import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  COPILOT_INSTRUCTIONS_FILE,
  COPILOT_MCP_CONFIG_FILE,
  LLM_MEM_INSTRUCTIONS_START,
  defaultMcpCommand,
  installCopilotIntegration,
  uninstallCopilotIntegration
} from "../packages/integrations/src/index.js";

const tempDirs: string[] = [];
const mcpCommand = { command: "llm-mem", args: ["mcp", "stdio", "--root", "."] };

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("Copilot integration", () => {
  it("installs MCP config and repository instructions without replacing existing servers", async () => {
    const repoDir = await tempRepo();
    const mcpPath = path.join(repoDir, COPILOT_MCP_CONFIG_FILE);
    await writeFile(
      mcpPath,
      `${JSON.stringify(
        {
          mcpServers: {
            existing: { type: "local", command: "existing-mcp", args: [], tools: ["*"] }
          }
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    const result = await installCopilotIntegration({ rootPath: repoDir, mcpCommand });

    expect(result.status.installed).toBe(true);
    const mcpConfig = JSON.parse(await readFile(mcpPath, "utf8")) as {
      mcpServers: Record<string, { command: string; args: string[] }>;
    };
    expect(mcpConfig.mcpServers.existing?.command).toBe("existing-mcp");
    expect(mcpConfig.mcpServers["llm-mem"]?.command).toBe("llm-mem");
    expect(mcpConfig.mcpServers["llm-mem"]?.args).toEqual(["mcp", "stdio", "--root", "."]);

    const instructions = await readFile(path.join(repoDir, COPILOT_INSTRUCTIONS_FILE), "utf8");
    expect(instructions).toContain("llm_mem.context_pack");

    const secondInstall = await installCopilotIntegration({ rootPath: repoDir, mcpCommand });
    expect(secondInstall.changes.every((change) => !change.changed)).toBe(true);
  });

  it("uninstalls only the llm-mem MCP entry and marked instruction block", async () => {
    const repoDir = await tempRepo();
    await writeFile(
      path.join(repoDir, COPILOT_MCP_CONFIG_FILE),
      `${JSON.stringify(
        {
          mcpServers: {
            existing: { type: "local", command: "existing-mcp", args: [], tools: ["*"] }
          }
        },
        null,
        2
      )}\n`,
      "utf8"
    );
    const instructionsPath = path.join(repoDir, COPILOT_INSTRUCTIONS_FILE);
    await mkdir(path.dirname(instructionsPath), { recursive: true });
    await writeFile(instructionsPath, "Keep tests green.\n", "utf8");
    await installCopilotIntegration({ rootPath: repoDir, mcpCommand });

    const result = await uninstallCopilotIntegration({ rootPath: repoDir, mcpCommand });

    expect(result.status.installed).toBe(false);
    const mcpConfig = JSON.parse(await readFile(path.join(repoDir, COPILOT_MCP_CONFIG_FILE), "utf8")) as {
      mcpServers: Record<string, unknown>;
    };
    expect(mcpConfig.mcpServers["llm-mem"]).toBeUndefined();
    expect(mcpConfig.mcpServers.existing).toBeDefined();
    const instructions = await readFile(instructionsPath, "utf8");
    expect(instructions).toBe("Keep tests green.\n");
  });

  it("supports dry-run install without writing files", async () => {
    const repoDir = await tempRepo();

    const result = await installCopilotIntegration({ rootPath: repoDir, mcpCommand, dryRun: true });

    expect(result.status.installed).toBe(false);
    expect(result.changes.every((change) => change.changed)).toBe(true);
    await expect(fileExists(path.join(repoDir, COPILOT_MCP_CONFIG_FILE))).resolves.toBe(false);
    await expect(fileExists(path.join(repoDir, COPILOT_INSTRUCTIONS_FILE))).resolves.toBe(false);
  });

  it("does not infer the MCP command from project-local files", async () => {
    const repoDir = await tempRepo();
    await mkdir(path.join(repoDir, "apps", "cli", "dist"), { recursive: true });
    await writeFile(path.join(repoDir, "apps", "cli", "dist", "index.js"), "throw new Error('not llm-mem');\n", "utf8");

    expect(defaultMcpCommand(repoDir)).toEqual({
      command: "llm-mem",
      args: ["mcp", "stdio", "--root", "."]
    });
  });

  it("removes generated instructions file when no user content remains", async () => {
    const repoDir = await tempRepo();
    await installCopilotIntegration({ rootPath: repoDir, mcpCommand });
    const instructionsPath = path.join(repoDir, COPILOT_INSTRUCTIONS_FILE);
    expect(await readFile(instructionsPath, "utf8")).toContain(LLM_MEM_INSTRUCTIONS_START);

    await uninstallCopilotIntegration({ rootPath: repoDir, mcpCommand });

    await expect(fileExists(instructionsPath)).resolves.toBe(false);
    await expect(fileExists(path.join(repoDir, COPILOT_MCP_CONFIG_FILE))).resolves.toBe(false);
  });
});

async function tempRepo(): Promise<string> {
  const repoDir = await mkdtemp(path.join(os.tmpdir(), "llm-mem-copilot-integration-"));
  tempDirs.push(repoDir);
  return repoDir;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    if (isNotFoundError(error)) {
      return false;
    }
    throw error;
  }
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
