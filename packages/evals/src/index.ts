import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { ContextPack, ContextRetriever } from "@llm-mem/core";
import { ContextCompiler } from "@llm-mem/core";

export const EvalScenarioSchema = z.object({
  id: z.string().min(1),
  taskType: z.string().min(1),
  prompt: z.string().min(1),
  goldFiles: z.array(z.string()).default([]),
  metrics: z.array(z.string()).default([])
});

export const EvalDatasetSchema = z.array(EvalScenarioSchema);

export type EvalScenario = z.infer<typeof EvalScenarioSchema>;

export interface EvalRunOptions {
  repoId: string;
  maxTokens: number;
}

export interface EvalScenarioResult {
  id: string;
  taskType: string;
  prompt: string;
  packId: string;
  usedTokens: number;
  contextRecall: number;
  citedGoldFiles: string[];
  missingGoldFiles: string[];
}

export interface EvalRunResult {
  scenarios: EvalScenarioResult[];
  aggregate: {
    scenarioCount: number;
    meanUsedTokens: number;
    meanContextRecall: number;
  };
}

export async function loadEvalDataset(filePath: string): Promise<EvalScenario[]> {
  const raw = await readFile(filePath, "utf8");
  return EvalDatasetSchema.parse(JSON.parse(raw));
}

export class EvalRunner {
  private readonly compiler: ContextCompiler;

  public constructor(retriever: ContextRetriever) {
    this.compiler = new ContextCompiler(retriever);
  }

  public async run(scenarios: EvalScenario[], options: EvalRunOptions): Promise<EvalRunResult> {
    const results: EvalScenarioResult[] = [];

    for (const scenario of scenarios) {
      const pack = await this.compiler.compile(
        {
          task: scenario.prompt,
          repoId: options.repoId,
          constraints: [
            "Prefer source-grounded context over broad file dumps.",
            "Preserve citations for every included code or memory fact."
          ]
        },
        { maxTokens: options.maxTokens, modelPolicy: "preferred:gpt-5.5" }
      );
      results.push(scoreScenario(scenario, pack));
    }

    const meanUsedTokens =
      results.length === 0 ? 0 : results.reduce((sum, result) => sum + result.usedTokens, 0) / results.length;
    const meanContextRecall =
      results.length === 0 ? 0 : results.reduce((sum, result) => sum + result.contextRecall, 0) / results.length;

    return {
      scenarios: results,
      aggregate: {
        scenarioCount: results.length,
        meanUsedTokens,
        meanContextRecall
      }
    };
  }
}

function scoreScenario(scenario: EvalScenario, pack: ContextPack): EvalScenarioResult {
  const citedUris = new Set(pack.citations.map((sourceRef) => normalizePath(sourceRef.uri)));
  const goldFiles = scenario.goldFiles.map(normalizePath);
  const citedGoldFiles = goldFiles.filter((goldFile) =>
    [...citedUris].some((uri) => uri === goldFile || uri.endsWith(`/${goldFile}`))
  );
  const missingGoldFiles = goldFiles.filter((goldFile) => !citedGoldFiles.includes(goldFile));

  return {
    id: scenario.id,
    taskType: scenario.taskType,
    prompt: scenario.prompt,
    packId: pack.id,
    usedTokens: pack.budget.usedEstimate,
    contextRecall: goldFiles.length === 0 ? 1 : citedGoldFiles.length / goldFiles.length,
    citedGoldFiles,
    missingGoldFiles
  };
}

function normalizePath(input: string): string {
  return input.replaceAll("\\", "/");
}
