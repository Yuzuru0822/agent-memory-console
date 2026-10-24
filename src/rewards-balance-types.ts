import type { Result } from "./shared";
import type { RewardId, RewardObservation, RewardSelector } from "./rewards-types";

export type BalanceUnit = "积分" | "Credits" | "CNY" | "USD";
export type BalanceReason = "manual" | "scheduled" | "before_claim" | "after_claim";
export interface BalanceSelector {
  label: string;
  prefix: string;
  suffix: string;
  automationId: string;
  controlType: "Text";
  layout: "inline" | "siblings";
}
export interface BalanceProfile {
  executable: string;
  executableHash: string;
  windowTitle: string;
  navigation: RewardSelector[];
  selector?: BalanceSelector;
  unit: BalanceUnit;
  intervalMinutes: number;
  lowThreshold?: number;
  enabled: boolean;
}
export interface BalanceSample {
  at: string;
  value: number;
  unit: BalanceUnit;
  delta?: number;
  reason: BalanceReason;
}
export interface BalanceView {
  id: RewardId;
  profile?: BalanceProfile;
  status: "unconfigured" | "ready" | "ok" | "error";
  sample?: BalanceSample;
  history: BalanceSample[];
  stale: boolean;
  low: boolean;
  lastAttempt?: string;
  error?: string;
  nextCheck?: string;
}
export interface BalancesSnapshot { providers: BalanceView[]; running?: RewardId; nativeAvailable: boolean }
export interface RewardBalancesApi {
  rewardBalancesSnapshot(): Promise<BalancesSnapshot>;
  rewardBalanceBind(id: RewardId): Promise<Result>;
  rewardBalanceInspect(id: RewardId): Promise<RewardObservation>;
  rewardBalanceNavigate(id: RewardId, token: string, index: number): Promise<Result>;
  rewardBalanceConfigure(id: RewardId, token: string, labelIndex: number, valueIndex: number, unit: BalanceUnit, intervalMinutes: number, lowThreshold?: number): Promise<Result>;
  rewardBalanceRefresh(id: RewardId): Promise<Result>;
  rewardBalanceAutomation(id: RewardId, enabled: boolean): Promise<Result>;
  rewardBalanceReset(id: RewardId): Promise<Result>;
}
