import type { RetrievalCandidate, SourceRef } from "@llm-mem/core";
import { estimateTokens, truncateToTokenBudget } from "@llm-mem/core";
import { SkillRuntime, type Skill } from "./skill-runtime.js";

export interface ContextCompressorInput {
  task: string;
  candidates: RetrievalCandidate[];
  maxTokens: number;
}

export interface ContextCompressorOutput {
  content: string;
  tokens: number;
  sourceRefs: SourceRef[];
  truncated: boolean;
}

export const contextCompressorSkill: Skill<ContextCompressorInput, ContextCompressorOutput> = {
  manifest: {
    name: "context-compressor",
    version: "0.1.0",
    description: "Compresses candidate context into task-sufficient facts with preserved citations.",
    permissions: ["read_memory", "call_model"],
    modelPolicy: {
      preferred: "gpt-5.5",
      fallback: "configured.reasoning"
    }
  },
  async run(input) {
    const sourceRefs: SourceRef[] = [];
    const candidateFacts = input.candidates.map((candidate, index) => {
      sourceRefs.push(...candidate.sourceRefs);
      const body = candidate.summary ?? candidate.content;
      return [
        `Fact ${index + 1}: ${candidate.title}`,
        `Kind: ${candidate.kind}`,
        `Confidence: ${candidate.confidence.toFixed(2)}`,
        body
      ].join("\n");
    });
    const raw = [`Task: ${input.task}`, ...candidateFacts].join("\n\n");
    const fitted = truncateToTokenBudget(raw, input.maxTokens);

    return {
      content: fitted.text,
      tokens: estimateTokens(fitted.text),
      sourceRefs: uniqueSources(sourceRefs),
      truncated: fitted.truncated
    };
  }
};

export interface SourceGrounderInput {
  claim: string;
  sourceRefs: SourceRef[];
}

export interface SourceGrounderOutput {
  supported: boolean;
  reason: string;
}

export const sourceGrounderSkill: Skill<SourceGrounderInput, SourceGrounderOutput> = {
  manifest: {
    name: "source-grounder",
    version: "0.1.0",
    description: "Checks whether a claim has source references attached before durable memory is written.",
    permissions: ["read_memory"],
    modelPolicy: {
      preferred: "gpt-5.5",
      fallback: "configured.reasoning"
    }
  },
  async run(input) {
    if (input.sourceRefs.length === 0) {
      return {
        supported: false,
        reason: "The claim has no source references."
      };
    }

    const observed = input.sourceRefs.filter((sourceRef) => sourceRef.trust === "observed");
    return {
      supported: observed.length > 0,
      reason:
        observed.length > 0
          ? "The claim has at least one observed source reference."
          : "The claim only has inferred or external references."
    };
  }
};

export interface SessionSummarizerInput {
  transcript: string;
  sourceRefs: SourceRef[];
  maxTokens: number;
}

export interface SessionSummarizerOutput {
  summary: string;
  tokens: number;
  sourceRefs: SourceRef[];
}

export const sessionSummarizerSkill: Skill<SessionSummarizerInput, SessionSummarizerOutput> = {
  manifest: {
    name: "session-summarizer",
    version: "0.1.0",
    description: "Creates durable, citation-aware session summaries.",
    permissions: ["read_memory", "write_memory", "call_model"],
    modelPolicy: {
      preferred: "gpt-5.5",
      fallback: "configured.reasoning"
    }
  },
  async run(input) {
    const fitted = truncateToTokenBudget(input.transcript, input.maxTokens);
    return {
      summary: fitted.text,
      tokens: estimateTokens(fitted.text),
      sourceRefs: uniqueSources(input.sourceRefs)
    };
  }
};

export function createDefaultSkillRuntime(): import("./skill-runtime.js").SkillRuntime {
  const runtime = new SkillRuntime();
  runtime.register(contextCompressorSkill);
  runtime.register(sourceGrounderSkill);
  runtime.register(sessionSummarizerSkill);
  return runtime;
}

function uniqueSources(sourceRefs: SourceRef[]): SourceRef[] {
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

