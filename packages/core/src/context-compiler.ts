import { randomUUID } from "node:crypto";
import type {
  ContextPack,
  ContextPackSection,
  ContextRetriever,
  RetrievalCandidate,
  SourceRef,
  TaskInput
} from "./types.js";
import { estimateSectionTokens, estimateTokens, truncateToTokenBudget } from "./token-budget.js";

export interface ContextCompilerOptions {
  maxTokens: number;
  reservedTokens?: number;
  maxCandidates?: number;
  modelPolicy?: string;
}

const COMPILER_VERSION = "0.1.0";

export class ContextCompiler {
  public constructor(private readonly retriever: ContextRetriever) {}

  public async compile(input: TaskInput, options: ContextCompilerOptions): Promise<ContextPack> {
    validateMaxTokens(options.maxTokens);
    const reservedTokens = options.reservedTokens ?? Math.ceil(options.maxTokens * 0.1);
    const usableTokens = Math.max(0, options.maxTokens - reservedTokens);
    const maxCandidates = options.maxCandidates ?? 24;
    const candidates = await this.retriever.retrieve(input, maxCandidates);
    const selected = this.deduplicate(candidates).sort(compareCandidate);

    const sections: ContextPackSection[] = [];
    const taskSummaryBudget = Math.min(options.maxTokens, Math.max(32, Math.floor(usableTokens * 0.2)));
    const taskSummary = this.createTaskSummary(input, taskSummaryBudget);
    sections.push(taskSummary);

    let usedEstimate = taskSummary.tokens;
    let truncatedCandidateCount = 0;
    const sourceRefs: SourceRef[] = [];

    for (const candidate of selected) {
      const remaining = Math.min(usableTokens, options.maxTokens) - usedEstimate;
      if (remaining <= 64) {
        truncatedCandidateCount += 1;
        continue;
      }

      const section = this.sectionFromCandidate(candidate, remaining);
      if (section.content.length === 0) {
        truncatedCandidateCount += 1;
        continue;
      }

      if (section.content.includes("[truncated; request expansion]")) {
        truncatedCandidateCount += 1;
      }

      sections.push(section);
      usedEstimate += section.tokens;
      sourceRefs.push(...section.sourceRefs);
    }

    const citations = this.uniqueSources(sourceRefs);
    const remainingForCitations = options.maxTokens - usedEstimate;
    const citationSection = this.createCitationSection(citations, Math.max(0, remainingForCitations));
    if (citationSection.content.length > 0 && usedEstimate + citationSection.tokens <= options.maxTokens) {
      sections.push(citationSection);
      usedEstimate += citationSection.tokens;
    }

    return {
      id: randomUUID(),
      task: input.task,
      ...(input.repoId === undefined ? {} : { repoId: input.repoId }),
      createdAt: new Date().toISOString(),
      budget: {
        maxTokens: options.maxTokens,
        usedEstimate,
        reservedTokens
      },
      sections,
      citations,
      metadata: {
        compilerVersion: COMPILER_VERSION,
        retrievalCandidateCount: candidates.length,
        truncatedCandidateCount,
        modelPolicy: options.modelPolicy ?? "preferred:gpt-5.5"
      }
    };
  }

  private createTaskSummary(input: TaskInput, maxTokens: number): ContextPackSection {
    const constraints =
      input.constraints && input.constraints.length > 0
        ? `\nConstraints:\n${input.constraints.map((constraint) => `- ${constraint}`).join("\n")}`
        : "";
    const workingDirectory = input.workingDirectory ? `\nWorking directory: ${input.workingDirectory}` : "";
    const rawContent = `Task: ${input.task}${workingDirectory}${constraints}`;
    const content = truncateToTokenBudget(rawContent, maxTokens).text;

    return {
      type: "task_summary",
      title: "Task summary",
      content,
      tokens: estimateSectionTokens({ title: "Task summary", content }),
      sourceRefs: []
    };
  }

  private sectionFromCandidate(candidate: RetrievalCandidate, remainingTokens: number): ContextPackSection {
    const header = [
      `Kind: ${candidate.kind}`,
      `Confidence: ${candidate.confidence.toFixed(2)}`,
      `Freshness: ${candidate.freshness ?? "unknown"}`,
      candidate.expansionId ? `Expansion: ${candidate.expansionId}` : undefined
    ]
      .filter((value): value is string => value !== undefined)
      .join("\n");

    const preferredContent = candidate.summary ?? candidate.content;
    const body = `${header}\n\n${preferredContent}`;
    const fitted = truncateToTokenBudget(body, Math.max(0, remainingTokens - 16));
    const content = fitted.text;

    return {
      type: "retrieved_context",
      title: candidate.title,
      content,
      tokens: estimateSectionTokens({ title: candidate.title, content }),
      sourceRefs: candidate.sourceRefs
    };
  }

  private createCitationSection(citations: SourceRef[], maxTokens: number): ContextPackSection {
    const rawContent =
      citations.length === 0
        ? "No citations were available for this pack."
        : citations
            .map((source, index) => {
              const range =
                source.startLine === undefined
                  ? ""
                  : `#L${source.startLine}${source.endLine === undefined ? "" : `-L${source.endLine}`}`;
              return `${index + 1}. ${source.kind}:${source.uri}${range} (${source.trust})`;
            })
            .join("\n");
    const content = truncateToTokenBudget(rawContent, maxTokens).text;

    return {
      type: "citations",
      title: "Citations",
      content,
      tokens: estimateSectionTokens({ title: "Citations", content }),
      sourceRefs: citations
    };
  }

  private deduplicate(candidates: RetrievalCandidate[]): RetrievalCandidate[] {
    const byKey = new Map<string, RetrievalCandidate>();

    for (const candidate of candidates) {
      const firstSource = candidate.sourceRefs[0];
      const key = firstSource
        ? `${candidate.kind}:${firstSource.uri}:${firstSource.startLine ?? ""}:${firstSource.endLine ?? ""}`
        : `${candidate.kind}:${candidate.id}`;
      const existing = byKey.get(key);

      if (!existing || candidate.score > existing.score) {
        byKey.set(key, candidate);
      }
    }

    return [...byKey.values()];
  }

  private uniqueSources(sourceRefs: SourceRef[]): SourceRef[] {
    const seen = new Set<string>();
    const unique: SourceRef[] = [];

    for (const sourceRef of sourceRefs) {
      const key = `${sourceRef.kind}:${sourceRef.uri}:${sourceRef.startLine ?? ""}:${sourceRef.endLine ?? ""}`;
      if (!seen.has(key)) {
        seen.add(key);
        unique.push(sourceRef);
      }
    }

    return unique;
  }
}

function validateMaxTokens(maxTokens: number): void {
  if (!Number.isFinite(maxTokens) || !Number.isInteger(maxTokens)) {
    throw new RangeError("maxTokens must be a finite integer.");
  }

  if (maxTokens < 64) {
    throw new RangeError("maxTokens must be at least 64.");
  }
}

function compareCandidate(left: RetrievalCandidate, right: RetrievalCandidate): number {
  const rightScore = right.score * right.confidence;
  const leftScore = left.score * left.confidence;
  return rightScore - leftScore;
}
