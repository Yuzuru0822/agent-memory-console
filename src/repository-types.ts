import type { AgentId, Result } from "./shared";

export interface RepositoryAutomation {
  enabled: boolean;
  intervalSeconds: number;
  cleanupEnabled: boolean;
  retentionDays: number;
  minBackups: number;
}
export interface RepositoryConfig {
  root: string;
  agentIds: AgentId[];
  memoryFolders: Partial<Record<AgentId, string>>;
  automation: RepositoryAutomation;
  autoGrant?: string;
}
export interface RepositorySnapshot {
  root?: string;
  git?: { branch: string; dirty: number };
  history: { oid: string; message: string; timestamp: number }[];
  members: { id: AgentId; name: string; selected: boolean; memoryPath?: string; skillsPath?: string; linked: boolean; originalBackup?: string }[];
  automation: RepositoryAutomation;
  lastRun?: string;
  lastMessage?: string;
  error?: string;
  running: boolean;
  backupCount: number;
}
export interface RepositoryFile {
  key: string;
  agent: AgentId;
  kind: "memory" | "skills";
  relative: string;
  agentPath: string;
  repositoryPath: string;
  localExists?: boolean;
  repositoryExists?: boolean;
  localText?: string;
  repositoryText?: string;
  baseText?: string;
  mergedText?: string;
  binary: boolean;
  previewTruncated?: boolean;
  conflict: boolean;
  description: string;
}
export interface RepositoryPlan {
  id: string;
  expiresAt: string;
  files: RepositoryFile[];
  warnings: string[];
}
export interface RepositoryResolution { choice: "agent" | "repository" | "manual"; text?: string; sourceKey?: string }
export interface JunctionView {
  id: string;
  agent: AgentId;
  source: string;
  target: string;
  backupPath: string;
  files: { relative: string; conflict: boolean; bytes: number; localText?: string; repositoryText?: string }[];
  warnings: string[];
  alreadyLinked: boolean;
}
export interface RepositoryApi {
  repositorySnapshot(): Promise<RepositorySnapshot>;
  repositoryChoose(): Promise<Result>;
  repositoryReveal(): Promise<Result>;
  repositoryMembers(ids: AgentId[]): Promise<Result>;
  repositoryMemoryFolder(id: AgentId): Promise<Result>;
  repositoryPreview(): Promise<RepositoryPlan>;
  repositoryCancelPreview(): Promise<Result>;
  repositoryApply(id: string, choices: Record<string, RepositoryResolution>): Promise<Result>;
  repositoryCommit(): Promise<Result>;
  repositoryAutomation(options: RepositoryAutomation): Promise<Result>;
  repositoryCleanup(): Promise<Result>;
  repositoryLinkPreview(id: AgentId): Promise<JunctionView>;
  repositoryLinkApply(id: string, choices: Record<string, "agent" | "repository">): Promise<Result>;
  repositoryUnlink(id: AgentId): Promise<Result>;
}
