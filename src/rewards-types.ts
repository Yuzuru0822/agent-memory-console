import type { AgentId, Result } from "./shared";

export type RewardId = AgentId | "qoder-cn" | "trae-global";
export type RewardState = "idle" | "needs_setup" | "ready" | "claimed" | "already_claimed" | "needs_attention" | "unknown" | "unsupported";
export interface RewardSelector {
  name: string;
  automationId: string;
  controlType: string;
}
export interface RewardElement extends RewardSelector {
  index: number;
  parentIndex?: number;
  enabled: boolean;
  actionable: boolean;
}
export interface RewardObservation {
  token: string;
  title: string;
  elements: RewardElement[];
  message?: string;
}
export interface RewardProfile {
  executable: string;
  executableHash: string;
  windowTitle: string;
  navigation: RewardSelector[];
  claim?: RewardSelector;
  context: string[];
  successTexts: string[];
  resetHour: number;
  enabled: boolean;
  validated: boolean;
}
export interface RewardDefinition {
  id: RewardId;
  agent: AgentId;
  name: string;
  kind: "ui" | "automatic" | "manual" | "unknown";
  description: string;
  sourceUrl: string;
  resetHour: number;
  scheduleNote: string;
}
export interface RewardView extends RewardDefinition {
  profile?: RewardProfile;
  state: RewardState;
  lastMessage?: string;
  lastAttempt?: string;
  lastSuccess?: string;
  nextCheck?: string;
}
export interface RewardLog {
  at: string;
  provider: RewardId;
  state: RewardState;
  message: string;
}
export interface RewardsSnapshot {
  providers: RewardView[];
  logs: RewardLog[];
  nativeAvailable: boolean;
  running?: RewardId;
}
export interface RewardsApi {
  rewardsSnapshot(): Promise<RewardsSnapshot>;
  rewardsBind(id: RewardId): Promise<Result>;
  rewardsInspect(id: RewardId): Promise<RewardObservation>;
  rewardsRecord(id: RewardId, token: string, index: number, kind: "navigate" | "claim"): Promise<Result>;
  rewardsChecks(id: RewardId, token: string, contextIndices: number[], successTexts: string[], resetHour: number): Promise<Result>;
  rewardsReset(id: RewardId): Promise<Result>;
  rewardsRun(id: RewardId): Promise<Result>;
  rewardsStart(id: RewardId): Promise<Result>;
  rewardsAutomation(id: RewardId, enabled: boolean): Promise<Result>;
  rewardsRule(id: RewardId): Promise<Result>;
}
