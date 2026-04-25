import path from "node:path";
import ignore from "ignore";

const DEFAULT_IGNORES = [
  ".git",
  "node_modules",
  "dist",
  "coverage",
  ".llm-mem",
  ".env",
  ".env.*",
  "*.pem",
  "*.key",
  "*.pfx",
  "*.p12"
];

export interface IgnoreRules {
  shouldIgnore(relativePath: string): boolean;
}

export function createDefaultIgnoreRules(extraPatterns: string[] = []): IgnoreRules {
  const matcher = ignore().add([...DEFAULT_IGNORES, ...extraPatterns.filter((pattern) => pattern.trim().length > 0)]);

  return {
    shouldIgnore(relativePath: string): boolean {
      const normalized = normalize(relativePath);
      return matcher.ignores(normalized);
    }
  };
}

function normalize(input: string): string {
  return input.split(path.sep).join("/").replace(/^\.\//, "");
}
