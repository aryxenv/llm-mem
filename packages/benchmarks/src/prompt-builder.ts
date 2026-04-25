import type { ContextPack } from "@llm-mem/core";
import { estimateTokens } from "@llm-mem/core";

export interface BuildCopilotPromptOptions {
  task: string;
  contextPack?: ContextPack;
}

export interface BuiltPrompt {
  prompt: string;
  estimatedTokens: number;
}

export function buildCopilotPrompt(options: BuildCopilotPromptOptions): BuiltPrompt {
  const prompt =
    options.contextPack === undefined
      ? buildBaselinePrompt(options.task)
      : buildContextPrompt({ task: options.task, contextPack: options.contextPack });
  return {
    prompt,
    estimatedTokens: estimateTokens(prompt)
  };
}

function buildBaselinePrompt(task: string): string {
  return [
    "You are running as a coding agent.",
    "Complete the task using the repository and existing tests.",
    "Do not invent files, APIs, or behavior. Run relevant validation before finishing.",
    "",
    `Task: ${task}`
  ].join("\n");
}

function buildContextPrompt(options: Required<BuildCopilotPromptOptions>): string {
  const pack = options.contextPack;
  const sections = pack.sections
    .map((section, index) =>
      [
        `## Context section ${index + 1}: ${section.title}`,
        `Type: ${section.type}`,
        `Estimated tokens: ${section.tokens}`,
        section.content
      ].join("\n")
    )
    .join("\n\n");
  const citations =
    pack.citations.length === 0
      ? "No citations were provided."
      : pack.citations
          .map((source, index) => {
            const range =
              source.startLine === undefined
                ? ""
                : `#L${source.startLine}${source.endLine === undefined ? "" : `-L${source.endLine}`}`;
            return `${index + 1}. ${source.kind}:${source.uri}${range} (${source.trust})`;
          })
          .join("\n");

  return [
    "You are running as a coding agent with a source-grounded llm-mem context pack.",
    "Use the cited context first. If the context is insufficient, inspect the repository rather than guessing.",
    "Do not invent files, APIs, or behavior. Preserve existing behavior and run relevant validation before finishing.",
    "If you discover the context pack is stale or incomplete, state that in your final answer.",
    "",
    `Task: ${options.task}`,
    "",
    `Context pack id: ${pack.id}`,
    `Context budget: ${pack.budget.usedEstimate}/${pack.budget.maxTokens} estimated tokens`,
    "",
    "# Context pack",
    sections,
    "",
    "# Citations",
    citations
  ].join("\n");
}
