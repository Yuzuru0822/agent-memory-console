import type { AgentId, Result } from "./shared";

export type McpProfile = "claude" | "workbuddy" | "trae" | "qoder-cli" | "qoder-ide" | "generic";
export interface McpTemplate {
  transport: "stdio" | "http" | "sse";
  description?: string;
  command?: string;
  args?: string[];
  url?: string;
  /** Values must contain private ${VARIABLE} references, never literal credentials. */
  env?: Record<string, string>;
  headers?: Record<string, string>;
}
export interface McpManifest { version: 1; servers: Record<string, McpTemplate> }
export interface McpBinding { agentId: AgentId; profile: McpProfile; file: string }
export interface McpDeployment { id: string; at: string; agentId: AgentId; file: string; serverIds: string[]; rolledBack: boolean }
export interface McpSnapshot {
  root?: string;
  templatePath?: string;
  templatesJson: string;
  servers: { id: string; transport: McpTemplate["transport"]; description?: string; variables: string[] }[];
  variableNames: string[];
  bindings: McpBinding[];
  deployments: McpDeployment[];
  error?: string;
}
export interface McpPlan {
  id: string;
  agentId: AgentId;
  profile: McpProfile;
  file: string;
  expiresAt: string;
  items: { id: string; action: "add" | "same" | "conflict"; transport: McpTemplate["transport"] }[];
  warnings: string[];
}
/** Main-process only input; never saved to the shared manifest or exposed in a preview. */
export interface McpBridgeDefinition { id: string; template: McpTemplate; variables: Record<string, string> }
export interface McpApi {
  mcpSnapshot(): Promise<McpSnapshot>;
  mcpSaveTemplates(json: string): Promise<Result>;
  mcpSetVariable(name: string, value: string): Promise<Result>;
  mcpBind(agentId: AgentId, profile: McpProfile): Promise<Result>;
  mcpPreview(agentId: AgentId, serverIds: string[], includeBridge: boolean): Promise<McpPlan>;
  mcpApply(planId: string, overwriteIds: string[]): Promise<Result>;
  mcpRollback(deploymentId: string): Promise<Result>;
}
