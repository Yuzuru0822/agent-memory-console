import type { AgentId, Result } from "./shared";

export type BridgeTaskState = "submitted" | "working" | "completed" | "failed" | "canceled" | "input-required" | "rejected" | "auth-required";
export type BridgeDelivery = "queued" | "received" | "replied" | "remote" | "unknown" | "canceled" | "failed";
export interface BridgeAgentPolicy { id: AgentId; enabled: boolean; allowTargets: string[] }
export interface BridgeConfig { port: number; agents: BridgeAgentPolicy[] }
export interface BridgeRemoteInput { id: string; name: string; endpoint: string; allowLoopback: boolean; token?: string }
export interface BridgeRemoteView { id: string; name: string; endpoint: string; allowLoopback: boolean; tokenSet: boolean }
export interface BridgeMessage { id: string; role: "user" | "agent"; text: string; at: string; by: string }
export interface BridgeTask {
  id: string; source: string; target: string; messageId: string; contextId: string;
  state: BridgeTaskState; delivery: BridgeDelivery; createdAt: string; updatedAt: string;
  messages: BridgeMessage[]; remoteTaskId?: string; remoteContextId?: string; error?: string;
}
export interface BridgeSnapshot {
  running: boolean; port: number; config: BridgeConfig;
  agents: (BridgeAgentPolicy & { name: string; tokenSet: boolean; pending: number; lastConnectedAt?: string })[];
  remotes: BridgeRemoteView[]; tasks: BridgeTask[]; error?: string;
  a2aVersion: "1.0"; mcpVersion: "2025-11-25";
}
export interface BridgeSendInput { source: AgentId; target: string; text: string; messageId?: string; contextId?: string }
export interface BridgeReplyInput { taskId: string; text: string; state: "completed" | "input-required" | "failed" }
export interface BridgeConnection { transport: "http"; url: string; headers: { Authorization: string } }
export interface BridgeApi {
  bridgeSnapshot(): Promise<BridgeSnapshot>;
  bridgeConfigure(config: BridgeConfig): Promise<Result>;
  bridgeStart(): Promise<Result>;
  bridgeStop(): Promise<Result>;
  bridgeRotateToken(id: AgentId): Promise<Result>;
  bridgeCopyConnection(id: AgentId): Promise<Result>;
  bridgeSaveRemote(remote: BridgeRemoteInput): Promise<Result>;
  bridgeRemoveRemote(id: string): Promise<Result>;
  bridgeSend(input: BridgeSendInput): Promise<BridgeTask>;
  bridgeReply(input: BridgeReplyInput): Promise<BridgeTask>;
  bridgeCancel(taskId: string): Promise<BridgeTask>;
  bridgeRefreshTask(taskId: string): Promise<BridgeTask>;
}
