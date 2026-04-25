import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { estimateTokens } from "@llm-mem/core";

export interface CopilotCliAdapterOptions {
  executable?: string;
  executableArgs?: string[];
  defaultModel?: string;
}

export interface CopilotRunOptions {
  cwd: string;
  prompt: string;
  outputDirectory: string;
  model?: string;
  outputFormat?: "text" | "json";
  promptTransport?: "auto" | "argv" | "file";
  allowAllTools?: boolean;
  noAskUser?: boolean;
  sharePath?: string;
  dryRun?: boolean;
  env?: NodeJS.ProcessEnv;
}

export interface CopilotRunResult {
  command: string;
  args: string[];
  cwd: string;
  dryRun: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  promptPath: string;
  promptTransport: "argv" | "file";
  promptTokensEstimate: number;
}

export class CopilotCliAdapter {
  private readonly executable: string;
  private readonly executableArgs: string[];
  private readonly defaultModel: string;

  public constructor(options: CopilotCliAdapterOptions = {}) {
    this.executable = options.executable ?? "copilot";
    this.executableArgs = options.executableArgs ?? [];
    this.defaultModel = options.defaultModel ?? "gpt-5.5";
  }

  public async run(options: CopilotRunOptions): Promise<CopilotRunResult> {
    await mkdir(options.outputDirectory, { recursive: true });
    const promptPath = path.join(options.outputDirectory, "prompt.md");
    await writeFile(promptPath, options.prompt, "utf8");
    const promptTransport = choosePromptTransport(options);
    const args = this.buildArgs(options, promptPath, promptTransport);
    const startedAt = new Date();

    if (options.dryRun === true) {
      const finishedAt = new Date();
      const result = {
        command: this.executable,
        args,
        cwd: options.cwd,
        dryRun: true,
        exitCode: null,
        stdout: "",
        stderr: "",
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        durationMs: finishedAt.getTime() - startedAt.getTime(),
        promptPath,
        promptTransport,
        promptTokensEstimate: estimateTokens(options.prompt)
      };
      await this.writeResult(options.outputDirectory, result);
      return result;
    }

    const result = await this.spawnCopilot(options, args, startedAt, promptPath, promptTransport);
    await this.writeResult(options.outputDirectory, result);
    return result;
  }

  private buildArgs(options: CopilotRunOptions, promptPath: string, promptTransport: "argv" | "file"): string[] {
    const args = [...this.executableArgs];
    args.push("--model", options.model ?? this.defaultModel);
    args.push("--output-format", options.outputFormat ?? "json");

    if (options.allowAllTools !== false) {
      args.push("--allow-all-tools");
    }

    if (options.noAskUser !== false) {
      args.push("--no-ask-user");
    }

    if (options.sharePath) {
      args.push(`--share=${options.sharePath}`);
    }

    if (promptTransport === "file") {
      args.push("--add-dir", path.dirname(promptPath));
    }

    args.push("-p", promptTransport === "argv" ? options.prompt : filePromptInstruction(promptPath));
    return args;
  }

  private async spawnCopilot(
    options: CopilotRunOptions,
    args: string[],
    startedAt: Date,
    promptPath: string,
    promptTransport: "argv" | "file"
  ): Promise<CopilotRunResult> {
    return await new Promise((resolve, reject) => {
      const child = spawn(this.executable, args, {
        cwd: options.cwd,
        env: { ...process.env, ...options.env },
        windowsHide: true
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];

      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      child.on("error", reject);
      child.on("close", (exitCode) => {
        const finishedAt = new Date();
        resolve({
          command: this.executable,
          args,
          cwd: options.cwd,
          dryRun: false,
          exitCode,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
          startedAt: startedAt.toISOString(),
          finishedAt: finishedAt.toISOString(),
          durationMs: finishedAt.getTime() - startedAt.getTime(),
          promptPath,
          promptTransport,
          promptTokensEstimate: estimateTokens(options.prompt)
        });
      });
    });
  }

  private async writeResult(outputDirectory: string, result: CopilotRunResult): Promise<void> {
    await writeFile(path.join(outputDirectory, "copilot-result.json"), JSON.stringify(result, null, 2), "utf8");
  }
}

function choosePromptTransport(options: CopilotRunOptions): "argv" | "file" {
  const requested = options.promptTransport ?? "auto";
  if (requested === "argv" || requested === "file") {
    return requested;
  }

  return options.prompt.length > 6000 ? "file" : "argv";
}

function filePromptInstruction(promptPath: string): string {
  return [
    `Read the full task prompt and llm-mem context pack from this file: ${promptPath}`,
    "Follow that file exactly. It contains the task, source-grounded context, citations, and validation instructions.",
    "Do not proceed from this short launcher prompt alone."
  ].join("\n");
}
