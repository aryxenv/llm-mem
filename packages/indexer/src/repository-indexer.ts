import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { ChunkRecordInput, IndexWriter, RepoRecord } from "@llm-mem/core";
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
