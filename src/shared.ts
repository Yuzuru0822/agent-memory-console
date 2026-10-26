import type { ClaudeNpmInstallation } from "../electron/claude-npm";
import type { SkillLink } from "../electron/skill-paths";
import type { RepositoryApi, RepositoryConfig } from "./repository-types";
import type { RewardsApi } from "./rewards-types";
import type { RewardBalancesApi } from "./rewards-balance-types";
import type { TasksApi } from "./task-types";
import type { McpApi } from "./mcp-types";
import type { BridgeApi } from "./bridge-types";

export interface SkillAccess {
  root: string;
  realRoot: string;
  links: SkillLink[];
}

export type AgentId =
  "claude" | "workbuddy" | "trae" | "deepseek" | "zcode" | "qwen" | "qoder";
export type PathKind = "memory" | "skills" | "executable" | "workspace";
export type PickKind = PathKind | "canonicalMemory" | "canonicalSkills";
export interface AgentConfig {
  memory?: string;
  skills?: string;
  skillsAccess?: SkillAccess;
  executable?: string;
  workspace?: string;
  claudeNpm?: ClaudeNpmInstallation;
}
export interface Config {
  version: 1;
  agents: Partial<Record<AgentId, AgentConfig>>;
  canonicalMemory?: string;
  canonicalSkills?: string;
  canonicalSkillsAccess?: SkillAccess;
  repository?: RepositoryConfig;
}
export interface FileInfo {
  path: string;
  exists: boolean;
  hash?: string;
  chars?: number;
  lines?: number;
  bytes?: number;
  modified?: string;
  error?: string;
}
export interface SkillsInfo {
  path: string;
  exists: boolean;
  count: number;
  files: number;
  linked: boolean;
  links?: SkillLink[];
  warnings?: string[];
  truncated?: boolean;
  error?: string;
}
export interface AgentView {
  id: AgentId;
  name: string;
  subtitle: string;
  accent: string;
  glyph: string;
  integration: "documented" | "candidate";
  note: string;
  memory: FileInfo;
  skills: SkillsInfo;
  executable?: string;
  executableApproved: boolean;
  npmCandidate?: ClaudeNpmInstallation;
  npmInstallation?: ClaudeNpmInstallation;
  memoryApproved: boolean;
  skillsApproved: boolean;
  workspace?: string;
  state: "ready" | "partial" | "missing" | "attention";
  sync: "same" | "different" | "unknown";
  process: {
    running: boolean;
    pid?: number;
    exitCode?: number | null;
    output: string;
    error?: string;
  };
  mode: "cli" | "desktop";
}
export interface AuditRow {
  seq: number;
  at: string;
  action: string;
  detail: string;
  prev: string;
  hash: string;
}
export interface Backup {
  id: string;
  at: string;
  agent: AgentId;
  label: string;
  files: number;
}
export interface Snapshot {
  at: string;
  agents: AgentView[];
  canonicalMemory: FileInfo;
  canonicalSkills: SkillsInfo;
  backups: Backup[];
  logs: AuditRow[];
  auditValid: boolean;
  auditError?: string;
  storagePath: string;
}
export interface PlanItem {
  agent: AgentId;
  kind: "memory" | "skills" | "restore";
  source: string;
  target: string;
  before: string | null;
  after: string;
  bytes: number;
  oldText: string;
  newText: string;
  sourceLogical?: string;
  targetLogical?: string;
}
export interface Plan {
  id: string;
  createdAt: string;
  expiresAt: string;
  items: PlanItem[];
  skipped: string[];
}
export interface Result {
  message: string;
}
export interface ConsoleApi extends RepositoryApi, RewardsApi, RewardBalancesApi, TasksApi, McpApi, BridgeApi {
  snapshot(): Promise<Snapshot>;
  pick(id: AgentId | null, kind: PickKind): Promise<Result>;
  approveNpm(): Promise<Result>;
  approveSkillLinks(id: AgentId | null): Promise<Result>;
  clear(id: AgentId, kind: PathKind): Promise<Result>;
  preview(mode: "memory" | "skills", ids: AgentId[]): Promise<Plan>;
  apply(planId: string): Promise<Result>;
  backup(id: AgentId): Promise<Result>;
  restore(backupId: string): Promise<Plan>;
  launch(id: AgentId, prompt?: string): Promise<Result>;
  stop(id: AgentId): Promise<Result>;
  reveal(
    id: AgentId | null,
    kind: "memory" | "skills" | "storage",
  ): Promise<Result>;
}
declare global {
  interface Window {
    consoleApi?: ConsoleApi;
  }
}

