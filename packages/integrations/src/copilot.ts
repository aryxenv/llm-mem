import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export const COPILOT_MCP_CONFIG_FILE = ".mcp.json";
export const LLM_MEM_IGNORE_FILE = ".llm-memignore";
export const COPILOT_INSTRUCTIONS_FILE = path.join(
  ".github",
  "copilot-instructions.md",
);
export const COPILOT_SKILL_FILE = path.join(
  ".github",
  "skills",
  "llm-mem",
  "SKILL.md",
);
export const LLM_MEM_MCP_SERVER_NAME = "llm-mem";
export const LLM_MEM_INSTRUCTIONS_START = "<!-- llm-mem:start -->";
export const LLM_MEM_INSTRUCTIONS_END = "<!-- llm-mem:end -->";
export type CopilotGuidanceMode = "skill" | "instructions" | "both" | "none";

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
  guidanceMode?: CopilotGuidanceMode;
}

export interface CopilotIntegrationStatus {
  rootPath: string;
  mcpConfigPath: string;
  skillPath: string;
  instructionsPath: string;
  mcpServerInstalled: boolean;
  skillInstalled: boolean;
  instructionsInstalled: boolean;
  guidanceInstalled: boolean;
  installed: boolean;
}

export interface CopilotIntegrationResult {
  rootPath: string;
  dryRun: boolean;
  status: CopilotIntegrationStatus;
  changes: IntegrationFileChange[];
}

interface CopilotMcpServerConfig {
  type: "stdio";
  command: string;
  args: string[];
}

type JsonObject = Record<string, unknown>;

export async function installCopilotIntegration(
  options: CopilotIntegrationOptions,
): Promise<CopilotIntegrationResult> {
  const rootPath = path.resolve(options.rootPath);
  const dryRun = options.dryRun === true;
  const guidanceMode = options.guidanceMode ?? "both";
  const ignoreChange = await installLlmMemIgnore({ rootPath, dryRun });
  const mcpChange = await installMcpConfig({ ...options, rootPath, dryRun });
  const guidanceChanges = await installGuidance({
    rootPath,
    dryRun,
    guidanceMode,
  });
  const status = await getCopilotIntegrationStatus({ rootPath });

  return {
    rootPath,
    dryRun,
    status,
    changes: [ignoreChange, mcpChange, ...guidanceChanges],
  };
}

export async function uninstallCopilotIntegration(
  options: CopilotIntegrationOptions,
): Promise<CopilotIntegrationResult> {
  const rootPath = path.resolve(options.rootPath);
  const dryRun = options.dryRun === true;
  const mcpChange = await uninstallMcpConfig({ rootPath, dryRun });
  const skillChange = await uninstallSkill({ rootPath, dryRun });
  const instructionsChange = await uninstallInstructions({ rootPath, dryRun });
  const status = await getCopilotIntegrationStatus({ rootPath });

  return {
    rootPath,
    dryRun,
    status,
    changes: [mcpChange, skillChange, instructionsChange],
  };
}

export async function getCopilotIntegrationStatus(
  options: Pick<CopilotIntegrationOptions, "rootPath" | "mcpCommand">,
): Promise<CopilotIntegrationStatus> {
  const rootPath = path.resolve(options.rootPath);
  const mcpConfigPath = path.join(rootPath, COPILOT_MCP_CONFIG_FILE);
  const skillPath = path.join(rootPath, COPILOT_SKILL_FILE);
  const instructionsPath = path.join(rootPath, COPILOT_INSTRUCTIONS_FILE);
  const mcpConfig = await readJsonFileIfExists(mcpConfigPath);
  const skill = await readTextFileIfExists(skillPath);
  const instructions = await readTextFileIfExists(instructionsPath);
  const servers = isJsonObject(mcpConfig?.mcpServers)
    ? mcpConfig.mcpServers
    : {};
  const installedServer = servers[LLM_MEM_MCP_SERVER_NAME];
  const skillInstalled = hasSkillContent(skill ?? "");
  const instructionsInstalled = hasInstructionBlock(instructions ?? "");

  return {
    rootPath,
    mcpConfigPath,
    skillPath,
    instructionsPath,
    mcpServerInstalled: isJsonObject(installedServer),
    skillInstalled,
    instructionsInstalled,
    guidanceInstalled: skillInstalled || instructionsInstalled,
    installed:
      isJsonObject(installedServer) &&
      (skillInstalled || instructionsInstalled),
  };
}

export function buildCopilotMcpServerConfig(
  rootPath: string,
  commandSpec?: CommandSpec,
): CopilotMcpServerConfig {
  const resolvedCommand = commandSpec ?? defaultMcpCommand(rootPath);

  return {
    type: "stdio",
    command: resolvedCommand.command,
    args: resolvedCommand.args,
  };
}

export function defaultMcpCommand(_rootPath: string): CommandSpec {
  return {
    command: "llm-mem",
    args: ["mcp", "stdio", "--root", "."],
  };
}

function integrationPaths(rootPath: string): {
  mcpConfigPath: string;
  instructionsPath: string;
} {
  return {
    mcpConfigPath: path.join(rootPath, COPILOT_MCP_CONFIG_FILE),
    instructionsPath: path.join(rootPath, COPILOT_INSTRUCTIONS_FILE),
  };
}

function guidancePaths(rootPath: string): {
  skillPath: string;
  instructionsPath: string;
} {
  return {
    skillPath: path.join(rootPath, COPILOT_SKILL_FILE),
    instructionsPath: path.join(rootPath, COPILOT_INSTRUCTIONS_FILE),
  };
}

async function installLlmMemIgnore(
  options: Required<Pick<CopilotIntegrationOptions, "rootPath" | "dryRun">>,
): Promise<IntegrationFileChange> {
  const ignorePath = path.join(options.rootPath, LLM_MEM_IGNORE_FILE);
  const existingText = await readTextFileIfExists(ignorePath);
  if (existingText !== undefined) {
    return { path: ignorePath, action: "none", changed: false };
  }

  const nextText = buildLlmMemIgnoreContent();

  if (options.dryRun !== true) {
    await writeFile(ignorePath, nextText, "utf8");
  }

  return { path: ignorePath, action: "create", changed: true };
}

async function installMcpConfig(
  options: Required<Pick<CopilotIntegrationOptions, "rootPath" | "dryRun">> &
    Pick<CopilotIntegrationOptions, "mcpCommand">,
): Promise<IntegrationFileChange> {
  const { mcpConfigPath } = integrationPaths(options.rootPath);
  const existingConfig = (await readJsonFileIfExists(mcpConfigPath)) ?? {};
  if (!isJsonObject(existingConfig)) {
    throw new Error(`${mcpConfigPath} must contain a JSON object.`);
  }

  const nextConfig = mergeMcpServer(
    existingConfig,
    buildCopilotMcpServerConfig(options.rootPath, options.mcpCommand),
  );
  const existingText = await readTextFileIfExists(mcpConfigPath);
  const nextText = `${JSON.stringify(nextConfig, null, 2)}\n`;
  const changed = existingText !== nextText;
  const action =
    existingText === undefined ? "create" : changed ? "update" : "none";

  if (changed && options.dryRun !== true) {
    await mkdir(path.dirname(mcpConfigPath), { recursive: true });
    await writeFile(mcpConfigPath, nextText, "utf8");
  }

  return { path: mcpConfigPath, action, changed };
}

async function uninstallMcpConfig(
  options: Required<Pick<CopilotIntegrationOptions, "rootPath" | "dryRun">>,
): Promise<IntegrationFileChange> {
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
    await mkdir(path.dirname(mcpConfigPath), { recursive: true });
    await writeFile(mcpConfigPath, nextText, "utf8");
  }

  return { path: mcpConfigPath, action: changed ? "update" : "none", changed };
}

async function installGuidance(
  options: Required<Pick<CopilotIntegrationOptions, "rootPath" | "dryRun">> & {
    guidanceMode: CopilotGuidanceMode;
  },
): Promise<IntegrationFileChange[]> {
  switch (options.guidanceMode) {
    case "skill":
      return [await installSkill(options)];
    case "instructions":
      return [await installInstructions(options)];
    case "both":
      return [await installSkill(options), await installInstructions(options)];
    case "none":
      return [];
  }
}

async function installSkill(
  options: Required<Pick<CopilotIntegrationOptions, "rootPath" | "dryRun">>,
): Promise<IntegrationFileChange> {
  const { skillPath } = guidancePaths(options.rootPath);
  const existingText = await readTextFileIfExists(skillPath);
  const nextText = buildSkillContent();
  if (existingText !== undefined && !isGeneratedSkillContent(existingText)) {
    throw new Error(
      `${skillPath} already exists and does not match the generated llm-mem skill. Refusing to overwrite user content. Remove it or use --guidance instructions.`,
    );
  }

  const changed = existingText !== nextText;
  const action =
    existingText === undefined ? "create" : changed ? "update" : "none";

  if (changed && options.dryRun !== true) {
    await mkdir(path.dirname(skillPath), { recursive: true });
    await writeFile(skillPath, nextText, "utf8");
  }

  return { path: skillPath, action, changed };
}

async function uninstallSkill(
  options: Required<Pick<CopilotIntegrationOptions, "rootPath" | "dryRun">>,
): Promise<IntegrationFileChange> {
  const { skillPath } = guidancePaths(options.rootPath);
  const existingText = await readTextFileIfExists(skillPath);
  if (existingText === undefined || !isGeneratedSkillContent(existingText)) {
    return { path: skillPath, action: "none", changed: false };
  }

  if (options.dryRun !== true) {
    await rm(skillPath, { force: true });
  }

  return { path: skillPath, action: "delete", changed: true };
}

async function installInstructions(
  options: Required<Pick<CopilotIntegrationOptions, "rootPath" | "dryRun">>,
): Promise<IntegrationFileChange> {
  const { instructionsPath } = guidancePaths(options.rootPath);
  const existingText = await readTextFileIfExists(instructionsPath);
  const nextText = upsertInstructionBlock(existingText ?? "");
  const changed = existingText !== nextText;
  const action =
    existingText === undefined ? "create" : changed ? "update" : "none";

  if (changed && options.dryRun !== true) {
    await mkdir(path.dirname(instructionsPath), { recursive: true });
    await writeFile(instructionsPath, nextText, "utf8");
  }

  return { path: instructionsPath, action, changed };
}

async function uninstallInstructions(
  options: Required<Pick<CopilotIntegrationOptions, "rootPath" | "dryRun">>,
): Promise<IntegrationFileChange> {
  const { instructionsPath } = guidancePaths(options.rootPath);
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

  return {
    path: instructionsPath,
    action: nextText.trim().length === 0 ? "delete" : "update",
    changed: true,
  };
}

function mergeMcpServer(
  config: JsonObject,
  serverConfig: CopilotMcpServerConfig,
): JsonObject {
  const servers = isJsonObject(config.mcpServers)
    ? { ...config.mcpServers }
    : {};
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
    const after = existingText
      .slice(end + LLM_MEM_INSTRUCTIONS_END.length)
      .trimStart();
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
  const after = existingText
    .slice(end + LLM_MEM_INSTRUCTIONS_END.length)
    .trimStart();
  const remaining = [before, after]
    .filter((part) => part.length > 0)
    .join("\n\n");
  return remaining.length === 0 ? "" : `${remaining}\n`;
}

function hasInstructionBlock(input: string): boolean {
  const start = input.indexOf(LLM_MEM_INSTRUCTIONS_START);
  const end = input.indexOf(LLM_MEM_INSTRUCTIONS_END);
  return start !== -1 && end > start;
}

function hasSkillContent(input: string): boolean {
  return (
    input.includes("name: llm-mem") && input.includes("llm_mem.context_pack")
  );
}

function isGeneratedSkillContent(input: string): boolean {
  return input === buildSkillContent() || input === buildLegacySkillContent();
}

function buildSkillContent(): string {
  return (
    [
      "---",
      "name: llm-mem",
      "description: Exact protocol for using llm-mem map-first context before repo-specific coding, debugging, explaining, refactoring, or testing tasks.",
      "---",
      "",
      "# llm-mem",
      "",
      "<!-- llm-mem generated skill: start -->",
      "",
      "Use llm-mem as a local context optimization layer. It is not a replacement assistant. Its value comes from replacing broad discovery with a compact map and exact snippets.",
      "",
      "## Required first move for non-trivial repo tasks",
      "",
      "For repo-specific code edits, debugging tasks, refactors, test tasks, explanations, or architecture questions, call `llm_mem.context_map` before reading broad directories or many files.",
      "",
      "Skip llm-mem for trivial one-file questions, pure shell/git questions, or tasks where the user already gave the exact file and no discovery is needed.",
      "",
      "Use this argument shape:",
      "",
      "```json",
      "{",
      '  "task": "<the user\'s actual task, including relevant constraints>",',
      '  "workingDirectory": "<current repository or worktree root>",',
      '  "maxCandidates": 8',
      "}",
      "```",
      "",
      "Do not supply `repoId` unless it is already known. The MCP server resolves the current repository from `workingDirectory` before falling back to the configured server root.",
      "",
      "## How to use the context map",
      "",
      "1. Read the returned JSON.",
      "2. Treat `candidates[].sourceRefs`, `matchReasons`, `score`, and `confidence` as the trusted map of likely files and symbols.",
      "3. Call `llm_mem.snippet` with the best `expansionId` values instead of opening broad files immediately.",
      "4. Expand only the snippets needed for the task.",
      "5. Prefer the smallest edit path that satisfies the task and cited evidence.",
      "6. If the map points to tests or validation commands, use those before inventing new validation.",
      "",
      "Snippet argument shape:",
      "",
      "```json",
      "{",
      '  "expansionId": "<candidate expansionId from context_map>",',
      '  "workingDirectory": "<current repository or worktree root>",',
      '  "maxTokens": 1200',
      "}",
      "```",
      "",
      "## If the map is insufficient",
      "",
      "Do not immediately scan the whole repo. First call `llm_mem.context_map` again with a narrower task or constraints, for example:",
      "",
      "```json",
      "{",
      '  "task": "Find the cache invalidation path for the failing benchmark",',
      '  "workingDirectory": "<current repository or worktree root>",',
      '  "constraints": ["Focus on files cited in the previous context pack", "Include tests or benchmark entrypoints"],',
      '  "maxCandidates": 6',
      "}",
      "```",
      "",
      "Only use `llm_mem.context_pack` for broad architecture/debug tasks or when a compact map plus snippets is still insufficient.",
      "",
      "## Remembering durable facts",
      "",
      "Use `llm_mem.remember` only for durable project facts, conventions, decisions, or reusable debugging findings. Do not remember transient guesses.",
      "",
      "Minimum useful shape:",
      "",
      "```json",
      "{",
      '  "repoId": "<repoId from the context pack if available>",',
      '  "type": "decision",',
      '  "title": "<short durable fact>",',
      '  "content": "<source-grounded detail>",',
      '  "confidence": 0.8,',
      '  "sourceRefs": [{ "kind": "file", "uri": "<path>", "trust": "observed" }]',
      "}",
      "```",
      "",
      "If `repoId` is not available, skip `remember` rather than guessing.",
      "",
      "## Do not",
      "",
      "- Do not run shell `llm-mem context` when the MCP tools are available.",
      "- Do not read broad directories before the first context map.",
      "- Do not call `llm_mem.context_pack` as the default first move.",
      "- Do not paste the full context pack to the user unless asked.",
      "- Do not treat uncited memories as stronger than observed files.",
      "- Do not optimize for fewer tokens if it reduces task correctness.",
      "",
      "Keep normal Copilot behavior and user intent first. Token savings only count when quality is preserved.",
      "",
      "<!-- llm-mem generated skill: end -->",
    ].join("\n") + "\n"
  );
}

function buildLegacySkillContent(): string {
  return (
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
    ].join("\n") + "\n"
  );
}

function buildInstructionBlock(): string {
  return [
    LLM_MEM_INSTRUCTIONS_START,
    "## High-priority llm-mem context optimization",
    "",
    "Always prefer llm-mem for efficient memory and context management on repo-specific coding, debugging, refactoring, testing, explanation, and architecture tasks.",
    "",
    "Do not wait for the user to invoke `/llm-mem`. When MCP tools are available, proactively use the llm-mem MCP tools before broad repository discovery.",
    "",
    "Follow this protocol:",
    "",
    '1. Call the MCP tool `llm_mem.context_map` with `{ "task": "<user task>", "workingDirectory": "<current repo/worktree root>", "maxCandidates": 8 }` before broad file search for repo-specific tasks.',
    "2. Expand only needed candidates with `llm_mem.snippet` and their `expansionId` values.",
    "3. Use cited source refs first. Prefer the smallest edit path that satisfies the task and cited constraints.",
    "4. Use `llm_mem.context_pack` only for broad/debug tasks or when map plus snippets are insufficient.",
    "5. Use `llm_mem.remember` only for durable source-grounded facts when `repoId` is available; never guess `repoId`.",
    "6. Do not run shell `llm-mem context` when the MCP tools are available, and do not paste the full pack to the user unless asked.",
    "7. Skip llm-mem only for trivial single-file edits, pure shell/git questions, or tasks where the user already supplied all necessary context.",
    "",
    "Keep normal Copilot behavior and user intent first; llm-mem is an optimization layer, not a replacement assistant.",
    LLM_MEM_INSTRUCTIONS_END,
  ].join("\n");
}

function buildLlmMemIgnoreContent(): string {
  return [
    "# Repo-local llm-mem ignore rules.",
    "# Add files here that should not be indexed or surfaced through llm-mem.",
    "",
    "# Large/generated outputs",
    ".llm-mem/",
    "dist/",
    "coverage/",
    "",
    "# Local secrets",
    ".env",
    ".env.*",
    "*.pem",
    "*.key",
    "*.pfx",
    "*.p12",
    "",
  ].join("\n");
}

async function readTextFileIfExists(
  filePath: string,
): Promise<string | undefined> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (isNotFoundError(error)) {
      return undefined;
    }
    throw error;
  }
}

async function readJsonFileIfExists(
  filePath: string,
): Promise<JsonObject | undefined> {
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
