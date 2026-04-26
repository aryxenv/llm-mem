import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  COPILOT_INSTRUCTIONS_FILE,
  COPILOT_MCP_CONFIG_FILE,
  COPILOT_SKILL_FILE,
  GIT_IGNORE_FILE,
  LLM_MEM_CONTEXT_MAP_TOOL,
  LLM_MEM_CONTEXT_PACK_TOOL,
  LLM_MEM_IGNORE_FILE,
  LLM_MEM_INSTRUCTIONS_START,
  LLM_MEM_README_START,
  LLM_MEM_SNIPPET_TOOL,
  README_FILE,
  defaultMcpCommand,
  installCopilotIntegration,
  uninstallCopilotIntegration,
} from "../packages/integrations/src/index.js";

const tempDirs: string[] = [];
const mcpCommand = {
  command: "llm-mem",
  args: ["mcp", "stdio", "--root", "."],
};

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("Copilot integration", () => {
  it("installs MCP config, project skill, and instructions without replacing existing servers", async () => {
    const repoDir = await tempRepo();
    const mcpPath = path.join(repoDir, COPILOT_MCP_CONFIG_FILE);
    await mkdir(path.dirname(mcpPath), { recursive: true });
    await writeFile(
      mcpPath,
      `${JSON.stringify(
        {
          mcpServers: {
            existing: { type: "stdio", command: "existing-mcp", args: [] },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const result = await installCopilotIntegration({
      rootPath: repoDir,
      mcpCommand,
    });

    expect(result.status.installed).toBe(true);
    const mcpConfig = JSON.parse(await readFile(mcpPath, "utf8")) as {
      mcpServers: Record<
        string,
        { type: string; command: string; args: string[] }
      >;
    };
    expect(mcpConfig.mcpServers.existing?.command).toBe("existing-mcp");
    expect(mcpConfig.mcpServers["llm-mem"]?.type).toBe("stdio");
    expect(mcpConfig.mcpServers["llm-mem"]?.command).toBe("llm-mem");
    expect(mcpConfig.mcpServers["llm-mem"]?.args).toEqual([
      "mcp",
      "stdio",
      "--root",
      ".",
    ]);

    const llmMemIgnore = await readFile(
      path.join(repoDir, LLM_MEM_IGNORE_FILE),
      "utf8",
    );
    expect(llmMemIgnore).toContain("Repo-local llm-mem ignore rules.");
    expect(llmMemIgnore).toContain(".llm-mem/");
    expect(llmMemIgnore).toContain(".env.*");

    const gitIgnore = await readFile(
      path.join(repoDir, GIT_IGNORE_FILE),
      "utf8",
    );
    expect(gitIgnore).toBe(".llm-mem/\n");

    const readme = await readFile(path.join(repoDir, README_FILE), "utf8");
    expect(readme).toContain(LLM_MEM_README_START);
    expect(readme).toContain("## llm-mem");
    expect(readme).toContain("https://github.com/aryxenv/llm-mem");
    expect(readme).toContain("npm run link:cli");
    expect(readme).toContain("llm-mem integrate copilot install");
    expect(readme).toContain(".llm-mem/");

    const skill = await readFile(
      path.join(repoDir, COPILOT_SKILL_FILE),
      "utf8",
    );
    expect(skill).toContain("name: llm-mem");
    expect(skill).toContain(LLM_MEM_CONTEXT_MAP_TOOL);
    expect(skill).toContain(LLM_MEM_SNIPPET_TOOL);
    expect(skill).toContain(LLM_MEM_CONTEXT_PACK_TOOL);
    expect(skill).toContain(
      '"workingDirectory": "<current repository or worktree root>"',
    );
    expect(skill).toContain(
      `Do not call \`${LLM_MEM_CONTEXT_PACK_TOOL}\` as the default first move.`,
    );
    const instructions = await readFile(
      path.join(repoDir, COPILOT_INSTRUCTIONS_FILE),
      "utf8",
    );
    expect(instructions).toContain(
      "## High-priority llm-mem context optimization",
    );
    expect(instructions).toContain(
      "Do not wait for the user to invoke `/llm-mem`",
    );
    expect(instructions).toContain(LLM_MEM_CONTEXT_MAP_TOOL);

    const secondInstall = await installCopilotIntegration({
      rootPath: repoDir,
      mcpCommand,
    });
    expect(secondInstall.changes.every((change) => !change.changed)).toBe(true);
  });

  it("appends a generated llm-mem section to an existing readme", async () => {
    const repoDir = await tempRepo();
    const readmePath = path.join(repoDir, README_FILE);
    await writeFile(readmePath, "# Existing project\n\nTeam docs.\n", "utf8");

    const result = await installCopilotIntegration({
      rootPath: repoDir,
      mcpCommand,
    });

    expect(result.changes.find((change) => change.path === readmePath)).toEqual(
      { path: readmePath, action: "update", changed: true },
    );
    const readme = await readFile(readmePath, "utf8");
    expect(readme).toContain("# Existing project\n\nTeam docs.");
    expect(readme).toContain(LLM_MEM_README_START);
    expect(readme).toContain(
      "git clone https://github.com/aryxenv/llm-mem.git",
    );
    expect(readme).toContain("llm-mem integrate copilot install");
  });

  it("can install instruction guidance for compatibility", async () => {
    const repoDir = await tempRepo();

    const result = await installCopilotIntegration({
      rootPath: repoDir,
      mcpCommand,
      guidanceMode: "instructions",
    });

    expect(result.status.installed).toBe(true);
    await expect(
      fileExists(path.join(repoDir, COPILOT_SKILL_FILE)),
    ).resolves.toBe(false);
    const instructions = await readFile(
      path.join(repoDir, COPILOT_INSTRUCTIONS_FILE),
      "utf8",
    );
    expect(instructions).toContain(LLM_MEM_INSTRUCTIONS_START);
    expect(instructions).toContain(LLM_MEM_CONTEXT_MAP_TOOL);
    expect(instructions).toContain(LLM_MEM_SNIPPET_TOOL);
    expect(instructions).toContain(LLM_MEM_CONTEXT_PACK_TOOL);
  });

  it("does not overwrite an existing llm-mem ignore file", async () => {
    const repoDir = await tempRepo();
    const ignorePath = path.join(repoDir, LLM_MEM_IGNORE_FILE);
    await writeFile(ignorePath, "local-only/\n", "utf8");

    const result = await installCopilotIntegration({
      rootPath: repoDir,
      mcpCommand,
    });

    expect(result.changes.find((change) => change.path === ignorePath)).toEqual(
      { path: ignorePath, action: "none", changed: false },
    );
    expect(await readFile(ignorePath, "utf8")).toBe("local-only/\n");
  });

  it("appends llm-mem local state to an existing gitignore", async () => {
    const repoDir = await tempRepo();
    const gitIgnorePath = path.join(repoDir, GIT_IGNORE_FILE);
    await writeFile(gitIgnorePath, "node_modules/\ndist/", "utf8");

    const result = await installCopilotIntegration({
      rootPath: repoDir,
      mcpCommand,
    });

    expect(
      result.changes.find((change) => change.path === gitIgnorePath),
    ).toEqual({ path: gitIgnorePath, action: "update", changed: true });
    expect(await readFile(gitIgnorePath, "utf8")).toBe(
      "node_modules/\ndist/\n.llm-mem/\n",
    );
  });

  it("does not duplicate an existing llm-mem gitignore entry", async () => {
    const repoDir = await tempRepo();
    const gitIgnorePath = path.join(repoDir, GIT_IGNORE_FILE);
    await writeFile(gitIgnorePath, "node_modules/\n.llm-mem\n", "utf8");

    const result = await installCopilotIntegration({
      rootPath: repoDir,
      mcpCommand,
    });

    expect(
      result.changes.find((change) => change.path === gitIgnorePath),
    ).toEqual({ path: gitIgnorePath, action: "none", changed: false });
    expect(await readFile(gitIgnorePath, "utf8")).toBe(
      "node_modules/\n.llm-mem\n",
    );
  });

  it("refuses to overwrite an existing custom llm-mem skill", async () => {
    const repoDir = await tempRepo();
    const skillPath = path.join(repoDir, COPILOT_SKILL_FILE);
    const customSkill = [
      "---",
      "name: llm-mem",
      "description: Team-owned llm-mem workflow.",
      "---",
      "",
      "# Custom llm-mem",
      "",
      "Call `llm_mem.context_pack`, then follow team policy.",
    ].join("\n");
    await mkdir(path.dirname(skillPath), { recursive: true });
    await writeFile(skillPath, `${customSkill}\n`, "utf8");

    await expect(
      installCopilotIntegration({ rootPath: repoDir, mcpCommand }),
    ).rejects.toThrow("Refusing to overwrite user content");
    expect(await readFile(skillPath, "utf8")).toBe(`${customSkill}\n`);

    const uninstallResult = await uninstallCopilotIntegration({
      rootPath: repoDir,
      mcpCommand,
    });
    expect(
      uninstallResult.changes.find((change) => change.path === skillPath)
        ?.changed,
    ).toBe(false);
    expect(await readFile(skillPath, "utf8")).toBe(`${customSkill}\n`);
  });

  it("upgrades the previous generated skill template", async () => {
    const repoDir = await tempRepo();
    const skillPath = path.join(repoDir, COPILOT_SKILL_FILE);
    await mkdir(path.dirname(skillPath), { recursive: true });
    await writeFile(
      skillPath,
      [
        "---",
        "name: llm-mem",
        "description: Use llm-mem context packs before coding in this repository. Trigger when editing, debugging, explaining, refactoring, or testing project code.",
        "---",
        "",
        "# llm-mem",
        "",
        "Use llm-mem as a local context optimization layer. Do not replace normal Copilot behavior.",
        "",
        "Before code edits or repo-specific answers:",
        "",
        "1. Call `llm_mem.context_pack` with the user's task and current working directory.",
        "2. Prefer cited files, constraints, memories, and tests from the context pack.",
        "3. If context is insufficient, retrieve a narrower expansion instead of scanning unrelated files.",
        "4. After durable decisions or conventions are discovered, call `llm_mem.remember` with citations.",
        "",
        "Keep outputs concise and source-grounded. Token savings only count when task quality is preserved.",
      ].join("\n") + "\n",
      "utf8",
    );

    const result = await installCopilotIntegration({
      rootPath: repoDir,
      mcpCommand,
    });

    expect(
      result.changes.find((change) => change.path === skillPath)?.action,
    ).toBe("update");
    const upgraded = await readFile(skillPath, "utf8");
    expect(upgraded).toContain(
      "## Required first move for non-trivial repo tasks",
    );
    expect(upgraded).toContain(
      `Do not call \`${LLM_MEM_CONTEXT_PACK_TOOL}\` as the default first move.`,
    );
  });

  it("uninstalls only the llm-mem MCP entry, skill, and marked instruction block", async () => {
    const repoDir = await tempRepo();
    const mcpPath = path.join(repoDir, COPILOT_MCP_CONFIG_FILE);
    await mkdir(path.dirname(mcpPath), { recursive: true });
    await writeFile(
      mcpPath,
      `${JSON.stringify(
        {
          mcpServers: {
            existing: { type: "stdio", command: "existing-mcp", args: [] },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    const instructionsPath = path.join(repoDir, COPILOT_INSTRUCTIONS_FILE);
    await mkdir(path.dirname(instructionsPath), { recursive: true });
    await writeFile(instructionsPath, "Keep tests green.\n", "utf8");
    await installCopilotIntegration({
      rootPath: repoDir,
      mcpCommand,
      guidanceMode: "both",
    });

    const result = await uninstallCopilotIntegration({
      rootPath: repoDir,
      mcpCommand,
    });

    expect(result.status.installed).toBe(false);
    const mcpConfig = JSON.parse(
      await readFile(path.join(repoDir, COPILOT_MCP_CONFIG_FILE), "utf8"),
    ) as {
      mcpServers: Record<string, unknown>;
    };
    expect(mcpConfig.mcpServers["llm-mem"]).toBeUndefined();
    expect(mcpConfig.mcpServers.existing).toBeDefined();
    await expect(
      fileExists(path.join(repoDir, COPILOT_SKILL_FILE)),
    ).resolves.toBe(false);
    const instructions = await readFile(instructionsPath, "utf8");
    expect(instructions).toBe("Keep tests green.\n");
  });

  it("removes only the generated readme section on uninstall", async () => {
    const repoDir = await tempRepo();
    const readmePath = path.join(repoDir, README_FILE);
    await writeFile(readmePath, "# Existing project\n\nTeam docs.\n", "utf8");
    await installCopilotIntegration({ rootPath: repoDir, mcpCommand });

    const result = await uninstallCopilotIntegration({
      rootPath: repoDir,
      mcpCommand,
    });

    expect(result.changes.find((change) => change.path === readmePath)).toEqual(
      { path: readmePath, action: "update", changed: true },
    );
    expect(await readFile(readmePath, "utf8")).toBe(
      "# Existing project\n\nTeam docs.\n",
    );
  });

  it("supports dry-run install without writing files", async () => {
    const repoDir = await tempRepo();

    const result = await installCopilotIntegration({
      rootPath: repoDir,
      mcpCommand,
      dryRun: true,
    });

    expect(result.status.installed).toBe(false);
    expect(result.changes.every((change) => change.changed)).toBe(true);
    await expect(
      fileExists(path.join(repoDir, COPILOT_MCP_CONFIG_FILE)),
    ).resolves.toBe(false);
    await expect(
      fileExists(path.join(repoDir, COPILOT_INSTRUCTIONS_FILE)),
    ).resolves.toBe(false);
    await expect(fileExists(path.join(repoDir, README_FILE))).resolves.toBe(
      false,
    );
  });

  it("does not infer the MCP command from project-local files", async () => {
    const repoDir = await tempRepo();
    await mkdir(path.join(repoDir, "apps", "cli", "dist"), { recursive: true });
    await writeFile(
      path.join(repoDir, "apps", "cli", "dist", "index.js"),
      "throw new Error('not llm-mem');\n",
      "utf8",
    );

    expect(defaultMcpCommand(repoDir)).toEqual({
      command: "llm-mem",
      args: ["mcp", "stdio", "--root", "."],
    });
  });

  it("removes generated skill and MCP config when no user content remains", async () => {
    const repoDir = await tempRepo();
    await installCopilotIntegration({ rootPath: repoDir, mcpCommand });
    const skillPath = path.join(repoDir, COPILOT_SKILL_FILE);
    expect(await readFile(skillPath, "utf8")).toContain("name: llm-mem");

    await uninstallCopilotIntegration({ rootPath: repoDir, mcpCommand });

    await expect(
      fileExists(path.join(repoDir, COPILOT_INSTRUCTIONS_FILE)),
    ).resolves.toBe(false);
    await expect(
      fileExists(path.join(repoDir, COPILOT_MCP_CONFIG_FILE)),
    ).resolves.toBe(false);
    await expect(
      fileExists(path.join(repoDir, LLM_MEM_IGNORE_FILE)),
    ).resolves.toBe(true);
    await expect(fileExists(skillPath)).resolves.toBe(false);
  });
});

async function tempRepo(): Promise<string> {
  const repoDir = await mkdtemp(
    path.join(os.tmpdir(), "llm-mem-copilot-integration-"),
  );
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
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
