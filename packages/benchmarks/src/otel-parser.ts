import { readFile } from "node:fs/promises";

export interface CopilotTokenUsage {
  inputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  cost: number;
  chatCallCount: number;
  source: "otel-spans" | "missing";
}

type JsonObject = Record<string, unknown>;

export async function parseCopilotOtelTokenUsage(filePath: string): Promise<CopilotTokenUsage> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if (isNotFoundError(error)) {
      return emptyUsage();
    }
    throw error;
  }

  let inputTokens = 0;
  let outputTokens = 0;
  let reasoningOutputTokens = 0;
  let cost = 0;
  let chatCallCount = 0;

  for (const line of raw.split(/\r?\n/)) {
    if (line.trim().length === 0) {
      continue;
    }

    const entry = parseJsonLine(line);
    if (!isJsonObject(entry) || entry.type !== "span" || !isJsonObject(entry.attributes)) {
      continue;
    }

    const attributes = entry.attributes;
    if (attributes["gen_ai.operation.name"] !== "chat") {
      continue;
    }

    const input = numberAttribute(attributes, "gen_ai.usage.input_tokens");
    const output = numberAttribute(attributes, "gen_ai.usage.output_tokens");
    if (input === undefined && output === undefined) {
      continue;
    }

    inputTokens += input ?? 0;
    outputTokens += output ?? 0;
    reasoningOutputTokens += numberAttribute(attributes, "gen_ai.usage.reasoning.output_tokens") ?? 0;
    cost += numberAttribute(attributes, "github.copilot.cost") ?? 0;
    chatCallCount += 1;
  }

  if (chatCallCount === 0) {
    return emptyUsage();
  }

  return {
    inputTokens,
    outputTokens,
    reasoningOutputTokens,
    totalTokens: inputTokens + outputTokens,
    cost,
    chatCallCount,
    source: "otel-spans"
  };
}

function emptyUsage(): CopilotTokenUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
    cost: 0,
    chatCallCount: 0,
    source: "missing"
  };
}

function parseJsonLine(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

function numberAttribute(attributes: JsonObject, key: string): number | undefined {
  const value = attributes[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNotFoundError(error: unknown): boolean {
  return isJsonObject(error) && error.code === "ENOENT";
}
