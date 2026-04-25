import path from "node:path";

const EXTENSION_LANGUAGE = new Map<string, string>([
  [".ts", "typescript"],
  [".tsx", "typescript"],
  [".js", "javascript"],
  [".jsx", "javascript"],
  [".mjs", "javascript"],
  [".cjs", "javascript"],
  [".json", "json"],
  [".md", "markdown"],
  [".py", "python"],
  [".rs", "rust"],
  [".go", "go"],
  [".cs", "csharp"],
  [".java", "java"],
  [".kt", "kotlin"],
  [".rb", "ruby"],
  [".php", "php"],
  [".yml", "yaml"],
  [".yaml", "yaml"],
  [".toml", "toml"],
  [".xml", "xml"],
  [".html", "html"],
  [".css", "css"],
  [".scss", "scss"],
  [".sql", "sql"],
  [".sh", "shell"],
  [".ps1", "powershell"]
]);

export function detectLanguage(filePath: string): string {
  return EXTENSION_LANGUAGE.get(path.extname(filePath).toLowerCase()) ?? "text";
}

export function isLikelyText(buffer: Buffer): boolean {
  if (buffer.length === 0) {
    return true;
  }

  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  return !sample.includes(0);
}
