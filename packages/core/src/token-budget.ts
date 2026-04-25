import type { ContextPackSection } from "./types.js";

export function estimateTokens(input: string): number {
  if (input.length === 0) {
    return 0;
  }

  return Math.ceil(input.length / 4);
}

export function estimateSectionTokens(section: Pick<ContextPackSection, "title" | "content">): number {
  return estimateTokens(`${section.title}\n${section.content}`);
}

export function truncateToTokenBudget(input: string, maxTokens: number): { text: string; truncated: boolean } {
  if (estimateTokens(input) <= maxTokens) {
    return { text: input, truncated: false };
  }

  const maxChars = Math.max(0, Math.floor(maxTokens * 4));
  if (maxChars <= 32) {
    return { text: "", truncated: true };
  }

  return {
    text: `${input.slice(0, maxChars - 32).trimEnd()}\n...[truncated; request expansion]`,
    truncated: true
  };
}
