import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { ChunkRecordInput, IndexWriter, RepoRecord, SymbolRecordInput } from "@llm-mem/core";
import { estimateTokens } from "@llm-mem/core";
import { createDefaultIgnoreRules, redactSecrets, type IgnoreRules } from "@llm-mem/security";
import { detectLanguage, isLikelyText } from "./language.js";

export interface RepositoryIndexerOptions {
  maxFileBytes?: number;
  chunkLineCount?: number;
  chunkOverlapLines?: number;
  ignoreRules?: IgnoreRules;
  loadRepoIgnoreFiles?: boolean;
}

export interface IndexResult {
  repo: RepoRecord;
  scannedFiles: number;
  indexedFiles: number;
  skippedFiles: number;
  chunks: number;
  redactions: number;
}

export class RepositoryIndexer {
  private readonly maxFileBytes: number;
  private readonly chunkLineCount: number;
  private readonly chunkOverlapLines: number;
  private readonly ignoreRules: IgnoreRules | undefined;
  private readonly loadRepoIgnoreFiles: boolean;

  public constructor(
    private readonly writer: IndexWriter,
    options: RepositoryIndexerOptions = {}
  ) {
    this.maxFileBytes = options.maxFileBytes ?? 512 * 1024;
    this.chunkLineCount = options.chunkLineCount ?? 160;
    this.chunkOverlapLines = options.chunkOverlapLines ?? 20;
    this.ignoreRules = options.ignoreRules;
    this.loadRepoIgnoreFiles = options.loadRepoIgnoreFiles ?? true;
  }

  public async index(rootPath: string, currentHead?: string): Promise<IndexResult> {
    const absoluteRoot = path.resolve(rootPath);
    const repo = await this.writer.upsertRepo(absoluteRoot, currentHead);
    const ignoreRules = this.ignoreRules ?? createDefaultIgnoreRules(await this.readRepoIgnorePatterns(absoluteRoot));
    const files = await this.listFiles(absoluteRoot, ".", ignoreRules);
    let indexedFiles = 0;
    let skippedFiles = 0;
    let chunkCount = 0;
    let redactions = 0;
    const seenPaths: string[] = [];

    for (const filePath of files) {
      const absolutePath = path.join(absoluteRoot, filePath);
      const fileStat = await stat(absolutePath);

      if (fileStat.size > this.maxFileBytes) {
        skippedFiles += 1;
        continue;
      }

      const buffer = await readFile(absolutePath);
      if (!isLikelyText(buffer)) {
        skippedFiles += 1;
        continue;
      }

      const rawText = buffer.toString("utf8");
      const redacted = redactSecrets(rawText);
      const normalizedPath = normalizePath(filePath);
      redactions += redacted.redactionCount;
      const contentHash = hashText(rawText);
      const file = await this.writer.upsertFile({
        repoId: repo.id,
        path: normalizedPath,
        contentHash,
        language: detectLanguage(filePath),
        sizeBytes: fileStat.size
      });
      seenPaths.push(normalizedPath);
      const chunks = this.chunkFile(repo.id, file.id, normalizedPath, redacted.text, contentHash);
      await this.writer.replaceFileChunks(file.id, chunks);
      await this.writer.replaceFileSymbols?.(file.id, extractSymbols(repo.id, file.id, normalizedPath, redacted.text));
      indexedFiles += 1;
      chunkCount += chunks.length;
    }

    await this.writer.pruneMissingFiles?.(repo.id, seenPaths);

    return {
      repo,
      scannedFiles: files.length,
      indexedFiles,
      skippedFiles,
      chunks: chunkCount,
      redactions
    };
  }

  private async listFiles(rootPath: string, relativeDirectory: string, ignoreRules: IgnoreRules): Promise<string[]> {
    const absoluteDirectory = path.join(rootPath, relativeDirectory);
    const entries = await readdir(absoluteDirectory, { withFileTypes: true });
    const files: string[] = [];

    for (const entry of entries) {
      const relativePath = normalizePath(path.join(relativeDirectory, entry.name));
      if (ignoreRules.shouldIgnore(relativePath)) {
        continue;
      }

      if (entry.isDirectory()) {
        files.push(...(await this.listFiles(rootPath, relativePath, ignoreRules)));
      } else if (entry.isFile()) {
        files.push(relativePath);
      }
    }

    return files;
  }

  private async readRepoIgnorePatterns(rootPath: string): Promise<string[]> {
    if (!this.loadRepoIgnoreFiles) {
      return [];
    }

    const ignoreFiles = [".gitignore", ".llm-memignore"];
    const patterns: string[] = [];

    for (const ignoreFile of ignoreFiles) {
      try {
        const text = await readFile(path.join(rootPath, ignoreFile), "utf8");
        patterns.push(...text.split(/\r?\n/));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }
    }

    return patterns;
  }

  private chunkFile(
    repoId: string,
    fileId: string,
    filePath: string,
    text: string,
    contentHash: string
  ): ChunkRecordInput[] {
    const lines = text.split(/\r?\n/);
    const chunks: ChunkRecordInput[] = [];
    const step = Math.max(1, this.chunkLineCount - this.chunkOverlapLines);

    for (let index = 0; index < lines.length; index += step) {
      const endExclusive = Math.min(lines.length, index + this.chunkLineCount);
      const chunkLines = lines.slice(index, endExclusive);
      const chunkText = chunkLines.join("\n");

      if (chunkText.trim().length === 0) {
        continue;
      }

      chunks.push({
        repoId,
        fileId,
        path: filePath,
        startLine: index + 1,
        endLine: endExclusive,
        contentHash,
        text: chunkText,
        tokenCount: estimateTokens(chunkText)
      });

      if (endExclusive === lines.length) {
        break;
      }
    }

    return chunks;
  }
}

function hashText(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function normalizePath(input: string): string {
  return input.split(path.sep).join("/").replace(/^\.\//, "");
}

function extractSymbols(repoId: string, fileId: string, filePath: string, text: string): SymbolRecordInput[] {
  if (!/\.(cjs|cts|js|jsx|mjs|mts|ts|tsx)$/.test(filePath)) {
    return [];
  }

  const lines = text.split(/\r?\n/);
  const symbols: SymbolRecordInput[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const parsed = parseSymbolLine(line);
    if (parsed === undefined) {
      continue;
    }

    const startLine = index + 1;
    symbols.push({
      repoId,
      fileId,
      name: parsed.name,
      kind: parsed.kind,
      startLine,
      endLine: findSymbolEndLine(lines, index),
      signature: line.trim()
    });
  }

  return symbols;
}

function parseSymbolLine(line: string): { name: string; kind: string } | undefined {
  const trimmed = line.trim();
  if (trimmed.startsWith("//") || trimmed.startsWith("*")) {
    return undefined;
  }

  const declarations = [
    { kind: "class", pattern: /^(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/ },
    { kind: "interface", pattern: /^(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/ },
    { kind: "type", pattern: /^(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\b/ },
    { kind: "enum", pattern: /^(?:export\s+)?enum\s+([A-Za-z_$][\w$]*)/ },
    { kind: "function", pattern: /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/ },
    { kind: "const", pattern: /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\b/ }
  ];

  for (const declaration of declarations) {
    const match = declaration.pattern.exec(trimmed);
    if (match?.[1]) {
      return { name: match[1], kind: declaration.kind };
    }
  }

  const methodMatch = /^(?:public\s+|private\s+|protected\s+|static\s+|async\s+|readonly\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::[^{]+)?\{?/.exec(
    trimmed
  );
  const methodName = methodMatch?.[1];
  if (methodName && !RESERVED_METHOD_WORDS.has(methodName)) {
    return { name: methodName, kind: "method" };
  }

  return undefined;
}

function findSymbolEndLine(lines: string[], startIndex: number): number {
  const start = lines[startIndex] ?? "";
  if (!start.includes("{")) {
    return startIndex + 1;
  }

  let depth = 0;
  for (let index = startIndex; index < lines.length; index += 1) {
    const line = stripLineComment(lines[index] ?? "");
    for (const char of line) {
      if (char === "{") {
        depth += 1;
      } else if (char === "}") {
        depth -= 1;
        if (depth <= 0) {
          return index + 1;
        }
      }
    }
  }

  return Math.min(lines.length, startIndex + 80);
}

function stripLineComment(line: string): string {
  const commentIndex = line.indexOf("//");
  return commentIndex === -1 ? line : line.slice(0, commentIndex);
}

const RESERVED_METHOD_WORDS = new Set([
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "function",
  "return",
  "describe",
  "it",
  "test",
  "expect"
]);
