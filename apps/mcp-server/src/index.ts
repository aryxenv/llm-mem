import readline from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ContextCompiler, estimateTokens, type RetrievalCandidate } from "@llm-mem/core";
import {
  ContextMapRequestSchema,
  ContextPackRequestSchema,
  ContextSnippetRequestSchema,
  MemoryWriteSchema,
  WorktreeCreateSchema
} from "@llm-mem/protocol";
import { SQLiteStore } from "@llm-mem/storage";
import { WorktreeManager } from "@llm-mem/worktrees";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: unknown;
}

export interface McpServerOptions {
  rootPath?: string;
  databasePath?: string;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}

export interface McpServerHandle {
  rootPath: string;
  databasePath: string;
  close(): void;
}

const TOOL_CONTEXT_MAP = "llm_mem_context_map";
const TOOL_SNIPPET = "llm_mem_snippet";
const TOOL_CONTEXT_PACK = "llm_mem_context_pack";
const TOOL_REMEMBER = "llm_mem_remember";
const TOOL_WORKTREE_CREATE = "llm_mem_worktree_create";

const LEGACY_TOOL_ALIASES = new Map<string, string>([
  ["llm_mem.context_map", TOOL_CONTEXT_MAP],
  ["llm_mem.snippet", TOOL_SNIPPET],
  ["llm_mem.context_pack", TOOL_CONTEXT_PACK],
  ["llm_mem.remember", TOOL_REMEMBER],
  ["llm_mem.worktree.create", TOOL_WORKTREE_CREATE]
]);

export function startMcpServer(options: McpServerOptions = {}): McpServerHandle {
  const rootPath = path.resolve(options.rootPath ?? process.cwd());
  const databasePath = options.databasePath ?? path.join(rootPath, ".llm-mem", "llm-mem.db");
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const store = new SQLiteStore({ databasePath });
  store.initialize();
  const compiler = new ContextCompiler(store);
  const worktrees = new WorktreeManager();
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  let closed = false;

  rl.on("line", (line) => {
    void handleLine(line);
  });
  rl.on("close", () => {
    closeStore();
  });

  async function handleLine(line: string): Promise<void> {
    if (line.trim().length === 0) {
      return;
    }

    let requestId: string | number | null = null;

    try {
      const request = JSON.parse(line) as JsonRpcRequest;
      if (request.id === undefined) {
        return;
      }
      requestId = request.id;

      const result = await dispatch(request);
      writeResponse({ jsonrpc: "2.0", id: request.id, result });
    } catch (error) {
      writeResponse({
        jsonrpc: "2.0",
        id: requestId,
        error: {
          code: error instanceof SyntaxError ? -32700 : -32000,
          message: error instanceof Error ? error.message : String(error)
        }
      });
    }
  }

  async function dispatch(request: JsonRpcRequest): Promise<unknown> {
    switch (request.method) {
      case "initialize":
        return {
          protocolVersion: "2024-11-05",
          capabilities: {
            tools: {},
            resources: {},
            prompts: {}
          },
          serverInfo: {
            name: "llm-mem",
            version: "0.1.0"
          }
        };
      case "tools/list":
        return {
          tools: [
            {
              name: TOOL_CONTEXT_MAP,
              description: "Return a compact retrieval map for a coding task. Use this before requesting snippets.",
              inputSchema: {
                type: "object",
                properties: {
                  task: { type: "string" },
                  repoId: { type: "string" },
                  workingDirectory: { type: "string" },
                  constraints: { type: "array", items: { type: "string" } },
                  maxCandidates: { type: "number" }
                },
                required: ["task"]
              }
            },
            {
              name: TOOL_SNIPPET,
              description: "Expand one context_map candidate by expansionId into a cited source snippet.",
              inputSchema: {
                type: "object",
                properties: {
                  expansionId: { type: "string" },
                  repoId: { type: "string" },
                  workingDirectory: { type: "string" },
                  maxTokens: { type: "number" }
                },
                required: ["expansionId"]
              }
            },
            {
              name: TOOL_CONTEXT_PACK,
              description: "Build a larger source-grounded context pack for broad/debug tasks. Prefer context_map first.",
              inputSchema: {
                type: "object",
                properties: {
                  task: { type: "string" },
                  repoId: { type: "string" },
                  workingDirectory: { type: "string" },
                  constraints: { type: "array", items: { type: "string" } },
                  maxTokens: { type: "number" }
                },
                required: ["task"]
              }
            },
            {
              name: TOOL_REMEMBER,
              description: "Store a source-grounded memory.",
              inputSchema: {
                type: "object",
                properties: {
                  repoId: { type: "string" },
                  type: { type: "string" },
                  title: { type: "string" },
                  content: { type: "string" },
                  sourceRefs: { type: "array" }
                },
                required: ["repoId", "type", "title", "content"]
              }
            },
            {
              name: TOOL_WORKTREE_CREATE,
              description: "Create a task-bound git worktree lease.",
              inputSchema: {
                type: "object",
                properties: {
                  repoRoot: { type: "string" },
                  taskId: { type: "string" },
                  slug: { type: "string" },
                  baseRef: { type: "string" }
                },
                required: ["repoRoot", "taskId", "slug"]
              }
            }
          ]
        };
      case "resources/list":
        return {
          resources: [
            { uri: "repo://current/summary", name: "Current repository summary" },
            { uri: "repo://current/index/status", name: "Current repository index status" }
          ]
        };
      case "resources/read":
        return readResource(request.params);
      case "prompts/list":
        return {
          prompts: [
            {
              name: "coding-task-with-context",
              description: "Use llm-mem context packs before coding."
            },
            {
              name: "summarize-session-into-memory",
              description: "Summarize completed work into source-grounded memory."
            }
          ]
        };
      case "prompts/get":
        return getPrompt(request.params);
      case "tools/call":
        return callTool(request.params);
      default:
        throw new Error(`Unsupported method: ${request.method}`);
    }
  }

  async function callTool(params: unknown): Promise<unknown> {
    const parsed = params as { name?: string; arguments?: unknown };
    const toolName = normalizeToolName(parsed.name);

    switch (toolName) {
      case TOOL_CONTEXT_PACK: {
        const args = ContextPackRequestSchema.parse(parsed.arguments);
        const { repoId, workingDirectory } = await resolveRepoContext(args.repoId, args.workingDirectory);
        const pack = await compiler.compile(
          {
            task: args.task,
            repoId,
            workingDirectory,
            ...(args.constraints === undefined ? {} : { constraints: args.constraints })
          },
          { maxTokens: args.maxTokens, modelPolicy: "preferred:gpt-5.5" }
        );
        store.recordContextPack(pack);
        return { content: [{ type: "text", text: JSON.stringify(pack, null, 2) }] };
      }
      case TOOL_CONTEXT_MAP: {
        const args = ContextMapRequestSchema.parse(parsed.arguments);
        const { repoId, workingDirectory } = await resolveRepoContext(args.repoId, args.workingDirectory);
        const candidates = await store.retrieve(
          {
            task: args.task,
            repoId,
            workingDirectory,
            ...(args.constraints === undefined ? {} : { constraints: args.constraints })
          },
          args.maxCandidates
        );
        const map = {
          task: args.task,
          repoId,
          workingDirectory,
          candidateCount: candidates.length,
          estimatedTokens: estimateTokens(JSON.stringify(candidates.map(contextMapCandidate))),
          usage:
            `Use expansionId with ${TOOL_SNIPPET} for only the files or symbols needed. Avoid ${TOOL_CONTEXT_PACK} unless this compact map is insufficient.`,
          candidates: candidates.map(contextMapCandidate)
        };
        return { content: [{ type: "text", text: JSON.stringify(map, null, 2) }] };
      }
      case TOOL_SNIPPET: {
        const args = ContextSnippetRequestSchema.parse(parsed.arguments);
        const { repoId, workingDirectory } = await resolveRepoContext(args.repoId, args.workingDirectory);
        const candidate = store.getCandidateByExpansionId(repoId, args.expansionId, args.maxTokens);
        if (candidate === undefined) {
          throw new Error(`Unknown or stale expansionId for ${workingDirectory}: ${args.expansionId}`);
        }
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  expansionId: args.expansionId,
                  repoId,
                  workingDirectory,
                  ...snippetPayload(candidate)
                },
                null,
                2
              )
            }
          ]
        };
      }
      case TOOL_REMEMBER: {
        const args = MemoryWriteSchema.parse(parsed.arguments);
        const memory = store.rememberMemory(args);
        return { content: [{ type: "text", text: JSON.stringify(memory, null, 2) }] };
      }
      case TOOL_WORKTREE_CREATE: {
        const args = WorktreeCreateSchema.parse(parsed.arguments);
        const lease = await worktrees.createLease(args);
        const repo = await store.upsertRepo(path.resolve(args.repoRoot));
        const leaseRecord = store.recordWorktreeLease({
          repoId: repo.id,
          taskId: args.taskId,
          branchName: lease.branchName,
          path: lease.path,
          baseRef: lease.baseRef
        });
        return { content: [{ type: "text", text: JSON.stringify({ ...lease, leaseId: leaseRecord.id }, null, 2) }] };
      }
      default:
        throw new Error(`Unsupported tool: ${parsed.name ?? "<missing>"}`);
    }
  }

  function readResource(params: unknown): unknown {
    const parsed = params as { uri?: string };

    switch (parsed.uri) {
      case "repo://current/summary":
        return {
          contents: [
            {
              uri: parsed.uri,
              mimeType: "text/plain",
              text: `Repository root: ${rootPath}\nPrimary output: proof-carrying context packs.`
            }
          ]
        };
      case "repo://current/index/status":
        return {
          contents: [
            {
              uri: parsed.uri,
              mimeType: "application/json",
              text: JSON.stringify({ rootPath, database: databasePath }, null, 2)
            }
          ]
        };
      default:
        throw new Error(`Unsupported resource: ${parsed.uri ?? "<missing>"}`);
    }
  }

  function getPrompt(params: unknown): unknown {
    const parsed = params as { name?: string };

    switch (parsed.name) {
      case "coding-task-with-context":
        return {
          description: "Use llm-mem map-first context before coding.",
          messages: [
            {
              role: "user",
              content: {
                type: "text",
                text: `For non-trivial repo tasks, call ${TOOL_CONTEXT_MAP} first. Expand only necessary candidates with ${TOOL_SNIPPET}. Use ${TOOL_CONTEXT_PACK} only when the compact map is insufficient.`
              }
            }
          ]
        };
      case "summarize-session-into-memory":
        return {
          description: "Summarize completed work into source-grounded memory.",
          messages: [
            {
              role: "user",
              content: {
                type: "text",
                text: "Summarize the completed session as durable memory with citations, confidence, and stale-fact risks."
              }
            }
          ]
        };
      default:
        throw new Error(`Unsupported prompt: ${parsed.name ?? "<missing>"}`);
    }
  }

  function normalizeToolName(name: string | undefined): string | undefined {
    return name === undefined ? undefined : (LEGACY_TOOL_ALIASES.get(name) ?? name);
  }

  function writeResponse(response: unknown): void {
    output.write(`${JSON.stringify(response)}\n`);
  }

  async function resolveRepoContext(repoId: string | undefined, workingDirectoryInput: string | undefined): Promise<{ repoId: string; workingDirectory: string }> {
    const workingDirectory = path.resolve(workingDirectoryInput ?? rootPath);
    if (repoId !== undefined) {
      return { repoId, workingDirectory };
    }

    const repo =
      workingDirectoryInput === undefined
        ? store.getRepoByRoot(rootPath) ?? (await store.upsertRepo(rootPath))
        : store.getRepoByRoot(workingDirectory) ?? (await store.upsertRepo(workingDirectory));
    return { repoId: repo.id, workingDirectory };
  }

  return {
    rootPath,
    databasePath,
    close(): void {
      rl.close();
      closeStore();
    }
  };

  function closeStore(): void {
    if (!closed) {
      closed = true;
      store.close();
    }
  }
}

function contextMapCandidate(candidate: RetrievalCandidate): Record<string, unknown> {
  return {
    expansionId: candidate.expansionId,
    kind: candidate.kind,
    title: candidate.title,
    score: Number(candidate.score.toFixed(3)),
    confidence: Number(candidate.confidence.toFixed(3)),
    tokenCost: candidate.tokenCost,
    matchReasons: candidate.matchReasons ?? [],
    sourceRefs: candidate.sourceRefs
  };
}

function snippetPayload(candidate: RetrievalCandidate): Record<string, unknown> {
  return {
    kind: candidate.kind,
    title: candidate.title,
    tokenCost: candidate.tokenCost,
    matchReasons: candidate.matchReasons ?? [],
    sourceRefs: candidate.sourceRefs,
    content: candidate.content
  };
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startMcpServer();
}
