import { useEffect, useRef, useState } from 'react';
import { MessageSquare, Plus, Send, Square, Settings2, GitBranch, ShieldCheck, FolderOpen } from 'lucide-react';
import type { AgentInstance, WorkbenchSnapshot, SessionDetail, AgentRun } from './workbench-types';
import './workbench.css';
const api = window.consoleApi!;
const labels: Record<string, string> = { queued: '等待', running: '运行中', approval: '等待审批', completed: '完成', failed: '失败', canceled: '已取消', interrupted: '执行结果未知' };
const live = (run: AgentRun) => ['queued', 'running', 'approval'].includes(run.state);
const newAgent = (): AgentInstance => ({ id: crypto.randomUUID(), name: '新 Agent', provider: 'custom', runtime: 'api', allowLoopback: false, memoryFiles: [], skillFiles: [], mcpServers: [], maxOutputTokens: 4096, maxTurns: 4, tokenBudget: 0 });
export default function WorkbenchPanel() {
  const [snapshot, setSnapshot] = useState<WorkbenchSnapshot>();
  const [selected, setSelected] = useState('');
  const [agentId, setAgentId] = useState('');
  const [detail, setDetail] = useState<SessionDetail>();
  const [draft, setDraft] = useState('');
  const [editor, setEditor] = useState<AgentInstance>();
  const [account, setAccount] = useState<{ id?: string; name: string; endpoint: string; secret: string }>({ name: '', endpoint: '', secret: '' });
  const [showAccounts, setShowAccounts] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [diff, setDiff] = useState<string>();
  const [servers, setServers] = useState<string[]>([]);
  const [tasks, setTasks] = useState<{ id: string; target: string; text: string }[]>([]);
  const selection = useRef(selected); selection.current = selected;
  const refreshing = useRef(false);
  async function refresh() {
    if (refreshing.current) return; refreshing.current = true;
    try {
      const snap = await api.workbenchSnapshot(); setSnapshot(snap); setAgentId(id => id || snap.agents[0]?.id || '');
      const id = selection.current;
      if (id) { const data = await api.workbenchSession(id); if (selection.current === id) setDetail(data); }
      const bridge = await api.bridgeSnapshot();
      setTasks(bridge.tasks.filter(t => t.state === 'submitted' && t.delivery === 'queued').map(t => ({ id: t.id, target: t.target, text: t.messages.at(-1)?.text || '' })));
    } catch (e) { setError(String(e)); } finally { refreshing.current = false; }
  }
  useEffect(() => { void refresh(); const timer = setInterval(() => void refresh(), 1000); void api.mcpSnapshot().then(s => setServers(s.servers.map(x => x.id))).catch(() => {}); return () => clearInterval(timer); }, []);
  useEffect(() => { setDetail(undefined); void refresh(); }, [selected]);
  async function action(fn: () => Promise<unknown>) {
    setBusy(true); setError(''); setNotice('');
    try { await fn(); await refresh(); } catch (e) { setError(String(e)); } finally { setBusy(false); }
  }
  const currentAgent = snapshot?.agents.find(a => a.id === (detail?.session.agentId || agentId));
  const currentRun = detail?.runs.at(-1);
  async function createSession() { const s = await api.workbenchNewSession(agentId); selection.current = s.id; setSelected(s.id); }
  async function choose(kind: 'workspace' | 'memory' | 'skill') {
    const file = await api.workbenchPick(kind); if (!file || !editor) return;
    setEditor(kind === 'workspace' ? { ...editor, workspace: file } : { ...editor, [kind === 'memory' ? 'memoryFiles' : 'skillFiles']: [...new Set([...(kind === 'memory' ? editor.memoryFiles : editor.skillFiles), file])] });
  }
  return <section className="workbench">
    <header className="wb-header"><div><span className="wb-eyebrow">AGENT WORKBENCH · V1.0 RC</span><h2>对话、执行与协作</h2><p>每次运行有独立记录，工具执行由你批准。</p></div><div className="wb-actions"><button onClick={() => { setEditor(newAgent()); setShowAccounts(false); }}><Plus size={16} /> 新建实例</button><button onClick={() => { setShowAccounts(v => !v); setEditor(undefined); }}><ShieldCheck size={16} /> 账号与凭据</button></div></header>
    {(error || snapshot?.error) && <div role="alert" className="wb-error">{error || snapshot?.error}</div>}{notice && <div role="status" className="wb-notice">{notice}</div>}
    {showAccounts && <div className="wb-card"><h3>加密账号凭据</h3><p>填写完整 Chat Completions 地址。凭据只发送到绑定端点，空值可撤销已有凭据。</p><div className="wb-account-list">{snapshot?.accounts.map(a => <button key={a.id} onClick={() => setAccount({ id: a.id, name: a.name, endpoint: a.endpoint, secret: '' })}>{a.name} · {a.configured ? '已配置' : '未配置'}</button>)}</div><div className="wb-form-row"><input aria-label="账号名称" placeholder="账号名称" value={account.name} onChange={e => setAccount({ ...account, name: e.target.value })} /><input aria-label="账号端点" placeholder="https://host/v1/chat/completions" value={account.endpoint} onChange={e => setAccount({ ...account, endpoint: e.target.value })} /><input aria-label="API 密钥" type="password" autoComplete="new-password" placeholder="API Key / Gateway token" value={account.secret} onChange={e => setAccount({ ...account, secret: e.target.value })} /><button disabled={busy} onClick={() => action(async () => { const result = await api.workbenchSaveAccount(account); setAccount({ name: '', endpoint: '', secret: '' }); setNotice(`已保存 ${result.name}`); })}>保存凭据</button></div></div>}
    {editor && <div className="wb-card"><h3>Agent 实例设置</h3><div className="wb-form-grid">
      <label>名称<input value={editor.name} onChange={e => setEditor({ ...editor, name: e.target.value })} /></label>
      <label>运行时<select value={editor.runtime} onChange={e => setEditor({ ...editor, runtime: e.target.value as AgentInstance['runtime'], mcpServers: [], tokenBudget: 0 })}><option value="api">API 原生 Agent</option><option value="claude">Claude CLI（对话模式）</option><option value="openclaw">OpenClaw Gateway</option><option value="desktop">桌面客户端（仅原有管理）</option></select></label>
      <label>厂商 / 桥接身份<input value={editor.provider} placeholder="claude / workbuddy / custom" onChange={e => setEditor({ ...editor, provider: e.target.value })} /></label>
      <label>账号<select value={editor.accountId || ''} onChange={e => { const a = snapshot?.accounts.find(a => a.id === e.target.value); setEditor({ ...editor, accountId: a?.id, endpoint: a?.endpoint || editor.endpoint }); }}><option value="">无 / CLI 自带登录</option>{snapshot?.accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
      <label>完整端点<input value={editor.endpoint || ''} placeholder="https://host/v1/chat/completions" onChange={e => setEditor({ ...editor, endpoint: e.target.value || undefined })} /></label>
      <label>模型 / OpenClaw Agent<input value={editor.model || ''} placeholder="模型 ID 或 openclaw/default" onChange={e => setEditor({ ...editor, model: e.target.value || undefined })} /></label>
      <label>最大输出 tokens<input type="number" min={128} max={32768} value={editor.maxOutputTokens} onChange={e => setEditor({ ...editor, maxOutputTokens: Number(e.target.value) })} /></label>
      <label>最大工具轮次<input type="number" min={1} max={10} value={editor.maxTurns} onChange={e => setEditor({ ...editor, maxTurns: Number(e.target.value) })} /></label>
      <label>累计 token 预算（0 为关闭）<input type="number" min={0} value={editor.tokenBudget} onChange={e => setEditor({ ...editor, tokenBudget: Number(e.target.value) })} /></label>
      <label className="wb-check"><input type="checkbox" checked={editor.allowLoopback} onChange={e => setEditor({ ...editor, allowLoopback: e.target.checked })} /> 授权 127.0.0.1 本地端点</label>
    </div><div className="wb-actions"><button onClick={() => action(() => choose('workspace'))}><FolderOpen size={16} /> 工作区</button><code>{editor.workspace || '尚未选择'}</code><button onClick={() => action(() => choose('memory'))}>添加记忆</button><button onClick={() => action(() => choose('skill'))}>添加 SKILL.md</button></div>
    {(['memoryFiles', 'skillFiles'] as const).map(key => editor[key].map(file => <div className="wb-asset" key={key + file}><code>{file}</code><button onClick={() => setEditor({ ...editor, [key]: editor[key].filter(f => f !== file) })}>移除</button></div>))}
    {editor.runtime === 'api' && <div className="wb-actions">MCP 服务：{servers.map(id => <label className="wb-check" key={id}><input type="checkbox" checked={editor.mcpServers.includes(id)} onChange={e => setEditor({ ...editor, mcpServers: e.target.checked ? [...editor.mcpServers, id] : editor.mcpServers.filter(s => s !== id) })} />{id}</label>)}</div>}
    <p>Claude 使用已授权程序登录，当前为无工具对话模式；OpenClaw 工具与执行授权由 Gateway 管理。API 原生 Agent 支持受审批的文件与 MCP 工具。</p><div className="wb-actions"><button disabled={busy} onClick={() => action(async () => { const a = await api.workbenchSaveAgent(editor); setAgentId(a.id); setEditor(undefined); })}>保存实例与授权</button><button onClick={() => setEditor(undefined)}>关闭</button></div></div>}
    <div className="wb-layout"><aside className="wb-sidebar"><label>Agent 实例<select aria-label="Agent 实例" value={agentId} onChange={e => setAgentId(e.target.value)}>{snapshot?.agents.map(a => <option key={a.id} value={a.id}>{a.name} · {a.runtime}</option>)}</select></label><div className="wb-actions"><button disabled={busy || !agentId} onClick={() => action(createSession)}><Plus size={15} /> 新会话</button><button aria-label="编辑实例" onClick={() => setEditor(snapshot?.agents.find(a => a.id === agentId))}><Settings2 size={15} /></button></div><div className="wb-session-list">{snapshot?.sessions.filter(s => !s.archived).map(s => <button className={selected === s.id ? 'selected' : ''} key={s.id} onClick={() => setSelected(s.id)}><MessageSquare size={15} /><span>{s.title}<small>{snapshot.agents.find(a => a.id === s.agentId)?.name}</small></span></button>)}</div></aside>
    <main className="wb-chat"><div className="wb-chat-title"><strong>{detail?.session.title || '开始一个新会话'}</strong><span>{currentAgent?.name}</span>{detail && <button disabled={busy || !!currentRun && live(currentRun)} onClick={() => action(async () => { await api.workbenchArchive(selected); setSelected(''); setDetail(undefined); })}>归档</button>}</div><div className="wb-messages" aria-live="polite">
      {!detail && <div className="wb-empty"><MessageSquare size={36} /><h3>让 Agent 开始工作</h3><p>选择实例，新建会话。配置 API 或 OpenClaw 账号后即可开始；旧厂商文件与程序管理入口仍在侧栏。</p></div>}
      {detail?.messages.map(m => <article key={m.id} className={'wb-message ' + m.role}><small>{m.role === 'user' ? '你' : currentAgent?.name} · {new Date(m.at).toLocaleTimeString()}</small><pre>{m.text}</pre>{m.role === 'assistant' && <button disabled={busy} onClick={() => action(async () => setNotice('共享记忆已保存：' + await api.workbenchRemember(selected, m.text)))}>审核为共享记忆</button>}</article>)}
      {currentRun && currentRun.state !== 'completed' && <article className="wb-message assistant"><small>{labels[currentRun.state]}</small><pre>{currentRun.output || '等待执行结果…'}</pre>{currentRun.error && <p className="wb-error">{currentRun.error}</p>}</article>}
      {snapshot?.approvals.filter(a => a.runId === currentRun?.id).map(a => <div className="wb-approval" key={a.id}><h4><ShieldCheck size={18} /> {a.tool}</h4><pre>{a.arguments}</pre><div className="wb-actions"><button onClick={() => action(() => api.workbenchApprove(a.id, true))}>批准这一次</button><button onClick={() => action(() => api.workbenchApprove(a.id, false))}>拒绝</button></div></div>)}
    </div><form className="wb-composer" onSubmit={e => { e.preventDefault(); if (!selected || !draft.trim()) return; const text = draft; void action(async () => { await api.workbenchSend(selected, text); setDraft(''); }); }}><textarea aria-label="对话消息" placeholder="描述任务，或继续当前对话…" maxLength={16000} value={draft} onChange={e => setDraft(e.target.value)} /><div className="wb-actions"><span>{currentRun ? `${labels[currentRun.state]} · ${currentRun.usage === 'actual' ? `${currentRun.inputTokens} 输入 / ${currentRun.outputTokens} 输出 tokens` : '用量未知'}` : '工具调用前需要批准'}</span>{currentRun && live(currentRun) ? <button type="button" onClick={() => action(() => api.workbenchCancel(currentRun.id))}><Square size={15} /> 停止</button> : <button disabled={busy || !selected || !draft.trim()} type="submit"><Send size={15} /> 发送</button>}</div></form></main></div>
    {currentAgent?.workspace && <div className="wb-card"><h3><GitBranch size={18} /> 工作区审核</h3><code>{currentAgent.workspace}</code><div className="wb-actions"><button disabled={busy} onClick={() => action(async () => setDiff(await api.workbenchDiff(currentAgent.id)))}>查看 Git 变更</button><button disabled={busy} onClick={() => action(async () => { const a = await api.workbenchWorktree(currentAgent.id, `task-${Date.now()}`); setAgentId(a.id); setNotice('已创建独立工作区与实例'); })}>创建独立 worktree</button></div>{diff !== undefined && <pre className="wb-diff">{diff || '没有变更'}</pre>}</div>}
    {!!tasks.length && <div className="wb-card"><h3>A2A 待执行任务</h3>{tasks.map(t => <div key={t.id} className="wb-bridge-task"><small>{t.target} · {t.id}</small><pre>{t.text}</pre><button disabled={busy || !snapshot?.agents.some(a => a.id === agentId && a.provider === t.target && a.runtime !== 'desktop')} onClick={() => action(async () => { const r = await api.workbenchDispatch(t.id, agentId); setSelected(r.sessionId); })}>批准并派发至所选实例</button></div>)}</div>}
    {detail && <details className="wb-card"><summary>运行追踪与上下文版本</summary>{detail.runs.map(r => <div key={r.id}><p><code>{r.id}</code> · {labels[r.state]}</p>{r.assets.map(a => <div className="wb-asset" key={a.kind + a.path}><code>{a.path}</code><small>{a.hash.slice(0, 16)}</small></div>)}</div>)}<pre className="wb-diff">{detail.events.filter(e => e.type !== 'text').map(e => `${e.at} #${e.seq} ${e.type} ${e.text}`).join('\n')}</pre></details>}
  </section>;
}
