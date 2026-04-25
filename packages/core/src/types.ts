export type SourceKind =
  | "file"
  | "git"
  | "url"
  | "memory"
  | "tool"
  | "session"
  | "doc"
  | "eval";

export type TrustLevel = "observed" | "inferred" | "external";
export type MemoryType =
  | "project"
  | "decision"
  | "task"
  | "session"
  | "code"
  | "research"
  | "user"
  | "agent";

export interface SourceRef {
  kind: SourceKind;
  uri: string;
  trust: TrustLevel;
  title?: string | undefined;
  startLine?: number | undefined;
  endLine?: number | undefined;
  contentHash?: string | undefined;
  capturedAt?: string | undefined;
}

export interface TokenBudget {
  maxTokens: number;
  usedEstimate: number;
  reservedTokens: number;
}

export interface TaskInput {
  task: string;
  repoId?: string | undefined;
  workingDirectory?: string | undefined;
  constraints?: string[] | undefined;
}

export interface RetrievalCandidate {
  id: string;
  kind: "memory" | "chunk" | "symbol" | "patch" | "decision" | "tool";
  title: string;
  content: string;
  score: number;
  confidence: number;
  sourceRefs: SourceRef[];
  summary?: string | undefined;
  tags?: string[] | undefined;
  freshness?: "fresh" | "stale" | "unknown";
  expansionId?: string | undefined;
}

export interface ContextPackSection {
  type:
    | "task_summary"
    | "retrieved_context"
    | "constraints"
    | "citations"
    | "open_questions"
    | "diagnostics";
  title: string;
  content: string;
  tokens: number;
  sourceRefs: SourceRef[];
}

export interface ContextPack {
  id: string;
  task: string;
  repoId?: string | undefined;
  createdAt: string;
  budget: TokenBudget;
  sections: ContextPackSection[];
  citations: SourceRef[];
  metadata: {
    compilerVersion: string;
    retrievalCandidateCount: number;
    truncatedCandidateCount: number;
    modelPolicy: string;
  };
}

export interface MemoryRecord {
  id: string;
  repoId: string;
  type: MemoryType;
  title: string;
  content: string;
  confidence: number;
  sourceRefs: SourceRef[];
  summary?: string | undefined;
  tags?: string[] | undefined;
  supersedesId?: string | undefined;
  expiresAt?: string | undefined;
  createdAt: string;
  updatedAt: string;
}

export interface FileRecordInput {
  repoId: string;
  path: string;
  contentHash: string;
  language: string;
  sizeBytes: number;
}

export interface ChunkRecordInput {
  repoId: string;
  fileId: string;
  path: string;
  startLine: number;
  endLine: number;
  contentHash: string;
  text: string;
  summary?: string | undefined;
  tokenCount: number;
}

export interface RepoRecord {
  id: string;
  rootPath: string;
  currentHead?: string | undefined;
}

export interface IndexWriter {
  upsertRepo(rootPath: string, currentHead?: string): Promise<RepoRecord>;
  upsertFile(input: FileRecordInput): Promise<{ id: string }>;
  replaceFileChunks(fileId: string, chunks: ChunkRecordInput[]): Promise<void>;
  pruneMissingFiles?(repoId: string, seenPaths: string[]): Promise<number>;
}

export interface ContextRetriever {
  retrieve(input: TaskInput, maxCandidates: number): Promise<RetrievalCandidate[]>;
}
