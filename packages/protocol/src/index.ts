import { z } from "zod";

export const SourceRefSchema = z.object({
  kind: z.enum(["file", "git", "url", "memory", "tool", "session", "doc", "eval"]),
  uri: z.string().min(1),
  trust: z.enum(["observed", "inferred", "external"]),
  title: z.string().optional(),
  startLine: z.number().int().positive().optional(),
  endLine: z.number().int().positive().optional(),
  contentHash: z.string().optional(),
  capturedAt: z.string().optional()
});

export const ContextPackRequestSchema = z.object({
  task: z.string().min(1),
  repoId: z.string().optional(),
  workingDirectory: z.string().optional(),
  constraints: z.array(z.string()).optional(),
  maxTokens: z.number().int().min(64).default(4000)
});

export const ContextMapRequestSchema = z.object({
  task: z.string().min(1),
  repoId: z.string().optional(),
  workingDirectory: z.string().optional(),
  constraints: z.array(z.string()).optional(),
  maxCandidates: z.number().int().min(1).max(24).default(8)
});

export const ContextSnippetRequestSchema = z.object({
  expansionId: z.string().min(1),
  repoId: z.string().optional(),
  workingDirectory: z.string().optional(),
  maxTokens: z.number().int().min(64).default(1200)
});

export const MemoryWriteSchema = z.object({
  repoId: z.string().min(1),
  type: z.enum(["project", "decision", "task", "session", "code", "research", "user", "agent"]),
  title: z.string().min(1),
  content: z.string().min(1),
  confidence: z.number().min(0).max(1).default(0.8),
  summary: z.string().optional(),
  tags: z.array(z.string()).default([]),
  sourceRefs: z.array(SourceRefSchema).default([])
});

export const TaskCreateSchema = z.object({
  repoId: z.string().min(1),
  title: z.string().min(1),
  description: z.string().optional()
});

export const WorktreeCreateSchema = z.object({
  repoRoot: z.string().min(1),
  taskId: z.string().min(1),
  slug: z.string().min(1),
  baseRef: z.string().default("HEAD"),
  worktreesRoot: z.string().optional()
});

export type ContextPackRequest = z.infer<typeof ContextPackRequestSchema>;
export type ContextMapRequest = z.infer<typeof ContextMapRequestSchema>;
export type ContextSnippetRequest = z.infer<typeof ContextSnippetRequestSchema>;
export type MemoryWrite = z.infer<typeof MemoryWriteSchema>;
export type TaskCreate = z.infer<typeof TaskCreateSchema>;
export type WorktreeCreate = z.infer<typeof WorktreeCreateSchema>;
