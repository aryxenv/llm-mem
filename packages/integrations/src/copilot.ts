import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export const COPILOT_MCP_CONFIG_FILE = ".mcp.json";
export const COPILOT_INSTRUCTIONS_FILE = path.join(".github", "copilot-instructions.md");
export const LLM_MEM_MCP_SERVER_NAME = "llm-mem";
export const LLM_MEM_INSTRUCTIONS_START = "<!-- llm-mem:start -->";
export const LLM_MEM_INSTRUCTIONS_END = "<!-- llm-mem:end -->";

export interface CommandSpec {
  command: string;
  args: string[];
}

export interface IntegrationFileChange {
  path: string;
  action: "create" | "update" | "delete" | "none";
  changed: boolean;
}

export interface CopilotIntegrationOptions {
  rootPath: string;
  dryRun?: boolean;
  mcpCommand?: CommandSpec;
}

export interface CopilotIntegrationStatus {
  rootPath: string;
  mcpConfigPath: string;
  instructionsPath: string;
  mcpServerInstalled: boolean;
  instructionsInstalled: boolean;
  installed: boolean;
}

export interface CopilotIntegrationResult {
  rootPath: string;
  dryRun: boolean;
  status: CopilotIntegrationStatus;
  changes: IntegrationFileChange[];
}

interface CopilotMcpServerConfig {
  type: "local";
  command: string;
  args: string[];
  tools: string[];
}

type JsonObject = Record<string, unknown>;

export async function installCopilotIntegration(
  options: CopilotIntegrationOptions
): Promise<CopilotIntegrationResult> {
  const rootPath = path.resolve(options.rootPath);
  const dryRun = options.dryRun === true;
  const mcpChange = await installMcpConfig({ ...options, rootPath, dryRun });
  const instructionsChange = await installInstructions({ rootPath, dryRun });
  const status = await getCopilotIntegrationStatus({ rootPath });

  return {
    rootPath,
    dryRun,
    status,
    changes: [mcpChange, instructionsChange]
  };
}

export async function uninstallCopilotIntegration(
  options: CopilotIntegrationOptions
): Promise<CopilotIntegrationResult> {
  const rootPath = path.resolve(options.rootPath);
  const dryRun = options.dryRun === true;
  const mcpChange = await uninstallMcpConfig({ rootPath, dryRun });
  const instructionsChange = await uninstallInstructions({ rootPath, dryRun });
  const status = await getCopilotIntegrationStatus({ rootPath });

  return {
    rootPath,
    dryRun,
    status,
    changes: [mcpChange, instructionsChange]
  };
}

export async function getCopilotIntegrationStatus(
  options: Pick<CopilotIntegrationOptions, "rootPath" | "mcpCommand">
): Promise<CopilotIntegrationStatus> {
  const rootPath = path.resolve(options.rootPath);
  const mcpConfigPath = path.join(rootPath, COPILOT_MCP_CONFIG_FILE);
  const instructionsPath = path.join(rootPath, COPILOT_INSTRUCTIONS_FILE);
  const mcpConfig = await readJsonFileIfExists(mcpConfigPath);
  const instructions = await readTextFileIfExists(instructionsPath);
  const mcpServers = isJsonObject(mcpConfig?.mcpServers) ? mcpConfig.mcpServers : {};
  const installedServer = mcpServers[LLM_MEM_MCP_SERVER_NAME];

  return {
    rootPath,
    mcpConfigPath,
    instructionsPath,
    mcpServerInstalled: isJsonObject(installedServer),
    instructionsInstalled: hasInstructionBlock(instructions ?? ""),
    installed: isJsonObject(installedServer) && hasInstructionBlock(instructions ?? "")
  };
}

export function buildCopilotMcpServerConfig(rootPath: string, commandSpec?: CommandSpec): CopilotMcpServerConfig {
  const resolvedCommand = commandSpec ?? defaultMcpCommand(rootPath);

  return {
    type: "local",
    command: resolvedCommand.command,
    args: resolvedCommand.args,
    tools: ["*"]
  };
}

export function defaultMcpCommand(_rootPath: string): CommandSpec {
  return {
    command: "llm-mem",
    args: ["mcp", "stdio", "--root", "."]
  };
}

function integrationPaths(rootPath: string): { mcpConfigPath: string; instructionsPath: string } {
  return {
    mcpConfigPath: path.join(rootPath, COPILOT_MCP_CONFIG_FILE),
    instructionsPath: path.join(rootPath, COPILOT_INSTRUCTIONS_FILE)
  };
}

async function installMcpConfig(options: Required<Pick<CopilotIntegrationOptions, "rootPath" | "dryRun">> & Pick<CopilotIntegrationOptions, "mcpCommand">): Promise<IntegrationFileChange> {
  const { mcpConfigPath } = integrationPaths(options.rootPath);
  const existingConfig = (await readJsonFileIfExists(mcpConfigPath)) ?? {};
  if (!isJsonObject(existingConfig)) {
    throw new Error(`${mcpConfigPath} must contain a JSON object.`);
  }

  const nextConfig = mergeMcpServer(existingConfig, buildCopilotMcpServerConfig(options.rootPath, options.mcpCommand));
  const existingText = await readTextFileIfExists(mcpConfigPath);
  const nextText = `${JSON.stringify(nextConfig, null, 2)}\n`;
  const changed = existingText !== nextText;
  const action = existingText === undefined ? "create" : changed ? "update" : "none";

  if (changed && options.dryRun !== true) {
    await writeFile(mcpConfigPath, nextText, "utf8");
  }

  return { path: mcpConfigPath, action, changed };
}

async function uninstallMcpConfig(options: Required<Pick<CopilotIntegrationOptions, "rootPath" | "dryRun">>): Promise<IntegrationFileChange> {
  const { mcpConfigPath } = integrationPaths(options.rootPath);
  const existingText = await readTextFileIfExists(mcpConfigPath);
  if (existingText === undefined) {
    return { path: mcpConfigPath, action: "none", changed: false };
  }

  const existingConfig = await readJsonFileIfExists(mcpConfigPath);
  if (!isJsonObject(existingConfig)) {
    throw new Error(`${mcpConfigPath} must contain a JSON object.`);
  }

  const nextConfig = removeMcpServer(existingConfig);
  if (isEmptyMcpOnlyConfig(nextConfig)) {
    if (options.dryRun !== true) {
      await rm(mcpConfigPath, { force: true });
    }
    return { path: mcpConfigPath, action: "delete", changed: true };
  }

  const nextText = `${JSON.stringify(nextConfig, null, 2)}\n`;
  const changed = existingText !== nextText;

  if (changed && options.dryRun !== true) {
    await writeFile(mcpConfigPath, nextText, "utf8");
  }

  return { path: mcpConfigPath, action: changed ? "update" : "none", changed };
}

async function installInstructions(
  options: Required<Pick<CopilotIntegrationOptions, "rootPath" | "dryRun">>
): Promise<IntegrationFileChange> {
  const { instructionsPath } = integrationPaths(options.rootPath);
  const existingText = await readTextFileIfExists(instructionsPath);
  const nextText = upsertInstructionBlock(existingText ?? "");
  const changed = existingText !== nextText;
  const action = existingText === undefined ? "create" : changed ? "update" : "none";

  if (changed && options.dryRun !== true) {
    await mkdir(path.dirname(instructionsPath), { recursive: true });
    await writeFile(instructionsPath, nextText, "utf8");
  }

  return { path: instructionsPath, action, changed };
}

async function uninstallInstructions(
  options: Required<Pick<CopilotIntegrationOptions, "rootPath" | "dryRun">>
): Promise<IntegrationFileChange> {
  const { instructionsPath } = integrationPaths(options.rootPath);
  const existingText = await readTextFileIfExists(instructionsPath);
  if (existingText === undefined) {
    return { path: instructionsPath, action: "none", changed: false };
  }

  const nextText = removeInstructionBlock(existingText);
  if (nextText === existingText) {
    return { path: instructionsPath, action: "none", changed: false };
  }

  if (options.dryRun !== true) {
    if (nextText.trim().length === 0) {
      await rm(instructionsPath, { force: true });
    } else {
      await writeFile(instructionsPath, nextText, "utf8");
    }
  }

  return { path: instructionsPath, action: nextText.trim().length === 0 ? "delete" : "update", changed: true };
}

function mergeMcpServer(config: JsonObject, serverConfig: CopilotMcpServerConfig): JsonObject {
  const servers = isJsonObject(config.mcpServers) ? { ...config.mcpServers } : {};
  servers[LLM_MEM_MCP_SERVER_NAME] = serverConfig;
  return { ...config, mcpServers: servers };
}

function removeMcpServer(config: JsonObject): JsonObject {
  if (!isJsonObject(config.mcpServers)) {
    return config;
  }

  const servers = { ...config.mcpServers };
  delete servers[LLM_MEM_MCP_SERVER_NAME];
  return { ...config, mcpServers: servers };
}

function isEmptyMcpOnlyConfig(config: JsonObject): boolean {
  return (
    Object.keys(config).length === 1 &&
    isJsonObject(config.mcpServers) &&
    Object.keys(config.mcpServers).length === 0
  );
}

function upsertInstructionBlock(existingText: string): string {
  const block = buildInstructionBlock();
  const start = existingText.indexOf(LLM_MEM_INSTRUCTIONS_START);
  const end = existingText.indexOf(LLM_MEM_INSTRUCTIONS_END);

  if (start !== -1 && end > start) {
    const before = existingText.slice(0, start).trimEnd();
    const after = existingText.slice(end + LLM_MEM_INSTRUCTIONS_END.length).trimStart();
    return `${[before, block, after].filter((part) => part.length > 0).join("\n\n")}\n`;
  }

  if (existingText.trim().length === 0) {
    return `${block}\n`;
  }

  return `${existingText.trimEnd()}\n\n${block}\n`;
}

function removeInstructionBlock(existingText: string): string {
  const start = existingText.indexOf(LLM_MEM_INSTRUCTIONS_START);
  const end = existingText.indexOf(LLM_MEM_INSTRUCTIONS_END);

  if (start === -1 || end <= start) {
    return existingText;
  }

  const before = existingText.slice(0, start).trimEnd();
  const after = existingText.slice(end + LLM_MEM_INSTRUCTIONS_END.length).trimStart();
  const remaining = [before, after].filter((part) => part.length > 0).join("\n\n");
  return remaining.length === 0 ? "" : `${remaining}\n`;
}

function hasInstructionBlock(input: string): boolean {
  const start = input.indexOf(LLM_MEM_INSTRUCTIONS_START);
  const end = input.indexOf(LLM_MEM_INSTRUCTIONS_END);
  return start !== -1 && end > start;
}

function buildInstructionBlock(): string {
  return [
    LLM_MEM_INSTRUCTIONS_START,
    "## llm-mem context optimization",
    "",
    "This repository is configured to use llm-mem as a local-first context compiler.",
    "",
    "Before making code changes for a user task:",
    "",
    "1. Call the MCP tool `llm_mem.context_pack` with the user's task and the current working directory.",
    "2. Prefer cited files, memories, and constraints from the context pack over broad rediscovery.",
    "3. If the context pack is insufficient, ask for or retrieve a narrower expansion instead of reading unrelated files.",
    "4. After meaningful work, use `llm_mem.remember` for durable project decisions or conventions with citations.",
    "",
    "Keep normal Copilot behavior and user intent first; llm-mem is an optimization layer, not a replacement assistant.",
    LLM_MEM_INSTRUCTIONS_END
  ].join("\n");
}

async function readTextFileIfExists(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (isNotFoundError(error)) {
      return undefined;
    }
    throw error;
  }
}

async function readJsonFileIfExists(filePath: string): Promise<JsonObject | undefined> {
  const text = await readTextFileIfExists(filePath);
  if (text === undefined) {
    return undefined;
  }

  const parsed = JSON.parse(text) as unknown;
  if (!isJsonObject(parsed)) {
    throw new Error(`${filePath} must contain a JSON object.`);
  }
  return parsed;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNotFoundError(error: unknown): boolean {
  return isJsonObject(error) && error.code === "ENOENT";
}
