import readline from "node:readline";
import path from "node:path";
import { ContextCompiler } from "@llm-mem/core";
import { ContextPackRequestSchema, MemoryWriteSchema, WorktreeCreateSchema } from "@llm-mem/protocol";
import { SQLiteStore } from "@llm-mem/storage";
import { WorktreeManager } from "@llm-mem/worktrees";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: unknown;
}

const rootPath = process.cwd();
const store = new SQLiteStore({ databasePath: path.join(rootPath, ".llm-mem", "llm-mem.db") });
store.initialize();
const compiler = new ContextCompiler(store);
const worktrees = new WorktreeManager();

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  void handleLine(line);
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
            name: "llm_mem.context_pack",
            description: "Build a source-grounded context pack for a coding task.",
            inputSchema: {
              type: "object",
              properties: {
                task: { type: "string" },
                repoId: { type: "string" },
                maxTokens: { type: "number" }
              },
              required: ["task"]
            }
          },
          {
            name: "llm_mem.remember",
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
            name: "llm_mem.worktree.create",
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

  switch (parsed.name) {
    case "llm_mem.context_pack": {
      const args = ContextPackRequestSchema.parse(parsed.arguments);
      const pack = await compiler.compile(
        {
          task: args.task,
          ...(args.repoId === undefined ? {} : { repoId: args.repoId }),
          ...(args.workingDirectory === undefined ? {} : { workingDirectory: args.workingDirectory }),
          ...(args.constraints === undefined ? {} : { constraints: args.constraints })
        },
        { maxTokens: args.maxTokens, modelPolicy: "preferred:gpt-5.5" }
      );
      store.recordContextPack(pack);
      return { content: [{ type: "text", text: JSON.stringify(pack, null, 2) }] };
    }
    case "llm_mem.remember": {
      const args = MemoryWriteSchema.parse(parsed.arguments);
      const memory = store.rememberMemory(args);
      return { content: [{ type: "text", text: JSON.stringify(memory, null, 2) }] };
    }
    case "llm_mem.worktree.create": {
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
            text: JSON.stringify({ rootPath, database: ".llm-mem/llm-mem.db" }, null, 2)
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
        description: "Use llm-mem context packs before coding.",
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: "Before editing code, call llm_mem.context_pack for the task and use cited context first."
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

function writeResponse(response: unknown): void {
  process.stdout.write(`${JSON.stringify(response)}\n`);
}
