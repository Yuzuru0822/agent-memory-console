export type RuntimeKind = 'claude' | 'api' | 'openclaw' | 'desktop';
export interface AgentInstance {
  id: string; name: string; provider: string; runtime: RuntimeKind; accountId?: string;
  workspace?: string; endpoint?: string; model?: string; allowLoopback: boolean;
  memoryFiles: string[]; skillFiles: string[]; mcpServers: string[];
  maxOutputTokens: number; maxTurns: number; tokenBudget: number;
}
export interface AccountView { id: string; name: string; endpoint: string; configured: boolean }
export interface ChatSession { id: string; agentId: string; title: string; createdAt: string; externalId?: string; archived: boolean }
export interface ChatMessage { id: string; sessionId: string; runId: string; role: 'user' | 'assistant'; text: string; at: string }
export type RunState = 'queued' | 'running' | 'approval' | 'completed' | 'failed' | 'canceled' | 'interrupted';
export interface ContextAsset { path: string; hash: string; kind: 'memory' | 'skill' | 'mcp'; text: string }
export interface AgentRun {
  id: string; sessionId: string; agentId: string; state: RunState; createdAt: string; updatedAt: string;
  output: string; error?: string; inputTokens?: number; outputTokens?: number; usage: 'actual' | 'unknown';
  reservedTokens: number; assets: ContextAsset[]; bridgeTaskId?: string; externalId?: string;
}
export interface RunEvent { id: string; runId: string; seq: number; at: string; type: string; text: string }
export interface RunApproval { id: string; runId: string; tool: string; arguments: string; expiresAt: string }
export interface WorkbenchSnapshot { agents: AgentInstance[]; accounts: AccountView[]; sessions: ChatSession[]; runs: AgentRun[]; approvals: RunApproval[]; error?: string }
export interface SessionDetail { session: ChatSession; messages: ChatMessage[]; runs: AgentRun[]; events: RunEvent[] }
export interface WorkbenchApi {
  workbenchSnapshot(): Promise<WorkbenchSnapshot>;
  workbenchSaveAgent(agent: AgentInstance): Promise<AgentInstance>;
  workbenchSaveAccount(input: { id?: string; name: string; endpoint: string; secret: string }): Promise<AccountView>;
  workbenchNewSession(agentId: string): Promise<ChatSession>;
  workbenchSession(id: string): Promise<SessionDetail>;
  workbenchSend(sessionId: string, text: string): Promise<AgentRun>;
  workbenchCancel(runId: string): Promise<void>;
  workbenchApprove(approvalId: string, allow: boolean): Promise<void>;
  workbenchArchive(sessionId: string): Promise<void>;
  workbenchPick(kind: 'workspace' | 'memory' | 'skill'): Promise<string | undefined>;
  workbenchDispatch(taskId: string, agentId: string): Promise<AgentRun>;
  workbenchDiff(agentId: string): Promise<string>;
  workbenchWorktree(agentId: string, branch: string): Promise<AgentInstance>;
  workbenchRemember(sessionId: string, text: string): Promise<string>;
}
