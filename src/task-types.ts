import type { Result } from "./shared";
import type { RewardId, RewardsSnapshot } from "./rewards-types";
import type { BalancesSnapshot } from "./rewards-balance-types";

export type TaskTarget = "repository" | "rewards";
export type TaskKind = "sync" | "cleanup" | "claim" | "balance";
export type TaskState = "unconfigured" | "unsupported" | "disabled" | "paused" | "waiting" | "scheduled" | "running" | "attention";
export interface TaskControls { paused: boolean; pausedAt?: string; pauseUntil?: string; closeToTray: boolean; error?: string }
export interface TaskRuntime { busy: boolean; calibrationUntil?: string; trayAvailable: boolean; windowVisible: boolean }
export interface TaskControlsSnapshot { controls: TaskControls; runtime: TaskRuntime }
export interface TaskItem {
  id: string; kind: TaskKind; name: string; providerId?: RewardId; state: TaskState;
  enabled: boolean; message: string; lastAttempt?: string; nextCheck?: string; target: TaskTarget;
}
export interface TaskIssue { id: string; severity: "warning" | "error"; title: string; detail: string; target: TaskTarget; providerId?: RewardId }
export interface TaskCenterSnapshot extends TaskControlsSnapshot { at: string; tasks: TaskItem[]; issues: TaskIssue[] }
export interface RepositoryTaskStatus {
  configured: boolean; syncEnabled: boolean; cleanupEnabled: boolean; running: boolean;
  intervalSeconds: number; previewUntil?: string; nextCheck?: string; lastRun?: string;
  lastMessage?: string; issue?: "conflict" | "grant" | "error"; error?: string;
}
export interface TaskSources { repository: RepositoryTaskStatus; rewards: RewardsSnapshot; balances: BalancesSnapshot; auditValid: boolean }
export type TaskReportKind = "tasks" | "balances";
export interface TasksApi {
  taskCenterSnapshot(): Promise<TaskCenterSnapshot>;
  taskControlsSnapshot(): Promise<TaskControlsSnapshot>;
  taskPause(minutes: 15 | 60 | null): Promise<Result>;
  taskResume(): Promise<Result>;
  taskTray(enabled: boolean): Promise<Result>;
  taskReport(kind: TaskReportKind): Promise<Result>;
}
