import { randomUUID } from "node:crypto";

export type SkillPermission =
  | "read_repo"
  | "write_repo"
  | "read_memory"
  | "write_memory"
  | "network"
  | "execute_shell"
  | "manage_worktrees"
  | "call_model";

export interface SkillManifest {
  name: string;
  version: string;
  description: string;
  permissions: SkillPermission[];
  modelPolicy: {
    preferred: string;
    fallback?: string;
  };
}

export interface SkillContext {
  runId: string;
  now: string;
}

export interface Skill<I, O> {
  manifest: SkillManifest;
  run(input: I, context: SkillContext): Promise<O>;
}

export class SkillRuntime {
  private readonly skills = new Map<string, Skill<unknown, unknown>>();

  public register<I, O>(skill: Skill<I, O>): void {
    if (this.skills.has(skill.manifest.name)) {
      throw new Error(`Skill already registered: ${skill.manifest.name}`);
    }

    this.skills.set(skill.manifest.name, skill as Skill<unknown, unknown>);
  }

  public list(): SkillManifest[] {
    return [...this.skills.values()].map((skill) => skill.manifest);
  }

  public async run<I, O>(name: string, input: I): Promise<O> {
    const skill = this.skills.get(name);
    if (!skill) {
      throw new Error(`Unknown skill: ${name}`);
    }

    return (await skill.run(input, {
      runId: randomUUID(),
      now: new Date().toISOString()
    })) as O;
  }
}
