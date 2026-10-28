import type { BrowserWindow } from 'electron';
import { dialog } from 'electron';
import type { WorkbenchService } from './service';
import type { AgentInstance } from '../../src/workbench-types';
type Register = (channel: string, fn: (...args: any[]) => unknown, mutation?: boolean) => void;
export function registerWorkbench(register: Register, service: WorkbenchService, window: BrowserWindow, confirm: (title: string, detail: string) => Promise<boolean>) {
  register('workbenchSnapshot', () => service.snapshot(), false);
  register('workbenchSession', (id: string) => service.detail(id), false);
  register('workbenchSaveAgent', async (agent: AgentInstance) => {
    if (!(await confirm('保存 Agent 实例与授权范围', JSON.stringify(agent, null, 2)))) throw new Error('已取消');
    return service.saveAgent(agent);
  });
  register('workbenchSaveAccount', async input => {
    if (!(await confirm('保存或轮换加密凭据', `名称：${String(input?.name)}\n仅发送到：${String(input?.endpoint)}\n凭据不会回显。空值撤销已保存凭据。`))) throw new Error('已取消');
    return service.saveAccount(input);
  });
  register('workbenchNewSession', (id: string) => service.newSession(id));
  register('workbenchSend', async (id: string, text: string) => {
    const session = service.detail(id).session, agent = service.snapshot().agents.find(a => a.id === session.agentId)!;
    if (!(await confirm('启动 Agent 对话', `${agent.name}\n端点：${agent.endpoint || '已授权 Claude CLI'}\n工作区：${agent.workspace || '无'}\n将发送本会话历史与选中的记忆/技能；可能产生费用。OpenClaw 的工具策略由其 Gateway 管理。\n\n${String(text).slice(0, 1000)}`))) throw new Error('已取消');
    return service.send(id, text);
  });
  // Cancellation/approval must remain available while other UI operations are in flight.
  register('workbenchCancel', (id: string) => service.cancel(id), false);
  register('workbenchApprove', (id: string, allow: boolean) => service.approve(id, allow), false);
  register('workbenchArchive', (id: string) => service.archive(id));
  register('workbenchPick', async (kind: string) => {
    if (!['workspace', 'memory', 'skill'].includes(kind)) throw new Error('选择类型无效');
    const result = await dialog.showOpenDialog(window, { title: kind === 'workspace' ? '选择工作区' : '选择授权注入的记忆 / SKILL.md', properties: [kind === 'workspace' ? 'openDirectory' : 'openFile'] });
    return result.canceled ? undefined : result.filePaths[0];
  });
  register('workbenchDispatch', async (taskId: string, agentId: string) => {
    if (!(await confirm('批准执行收到的 Agent 任务', `任务：${taskId}\n实例：${agentId}\n会话将把外部任务作为输入；可能产生费用。MCP 和本地文件工具仍逐次审批。请先在互联面板检查完整任务正文。`))) throw new Error('已取消');
    return service.dispatch(taskId, agentId);
  });
  register('workbenchDiff', (id: string) => service.diff(id), false);
  register('workbenchWorktree', async (id: string, branch: string) => {
    if (!(await confirm('创建独立开发工作区', `为此 Agent 创建相邻目录与 agent/${branch} 分支，并复制实例设置。`))) throw new Error('已取消');
    return service.worktree(id, branch);
  });
  register('workbenchRemember', async (id: string, text: string) => {
    if (!(await confirm('审核并保存共享记忆', text))) throw new Error('已取消'); return service.remember(id, text);
  });
}
