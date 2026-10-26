import { useEffect, useRef, useState } from "react";
import { AlertCircle, ArrowRight, Check, ClipboardCopy, FileJson, FolderOpen, History, KeyRound, Link2, LoaderCircle, MessageSquare, Network, Play, RefreshCw, RotateCcw, Save, Send, Server, ShieldCheck, Square, Trash2, X } from "lucide-react";
import type { AgentId } from "./shared";
import type { BridgeConfig, BridgeRemoteInput, BridgeReplyInput, BridgeSnapshot, BridgeTask } from "./bridge-types";
import type { McpPlan, McpProfile, McpSnapshot } from "./mcp-types";
import "./interop.css";

const api = window.consoleApi;
const agents: { id: AgentId; name: string }[] = [
  { id: "claude", name: "Claude Code CLI" }, { id: "workbuddy", name: "WorkBuddy" },
  { id: "trae", name: "TRAE" }, { id: "qoder", name: "Qoder" },
  { id: "deepseek", name: "DeepSeek Harness" }, { id: "zcode", name: "智谱 Zcode" }, { id: "qwen", name: "千问 Work" },
];
const profiles: { id: McpProfile; name: string }[] = [
  { id: "claude", name: "Claude Code" }, { id: "workbuddy", name: "WorkBuddy" }, { id: "trae", name: "TRAE" },
  { id: "qoder-cli", name: "Qoder CLI" }, { id: "qoder-ide", name: "Qoder IDE" }, { id: "generic", name: "通用 mcpServers（需自行确认兼容性）" },
];
const initialRemote: BridgeRemoteInput = { id: "", name: "", endpoint: "", allowLoopback: false, token: "" };
const example = JSON.stringify({ version: 1, servers: { "shared-example": { transport: "http", url: "https://mcp.example.com/mcp", headers: { Authorization: "Bearer ${API_TOKEN}" }, description: "替换为实际 MCP 服务地址" } } }, null, 2);
const deliveryLabels: Record<BridgeTask["delivery"], string> = {
  queued: "待接收", received: "对端已收取", replied: "已有回复", remote: "已交给远端", unknown: "发送结果未确认", canceled: "已取消", failed: "投递失败",
};
const taskStates: Record<BridgeTask["state"], string> = {
  submitted: "已提交", working: "处理中", completed: "已完成", failed: "失败", canceled: "已取消", "input-required": "等待补充输入", rejected: "已拒绝", "auth-required": "需要认证",
};
function stamp(value?: string) {
  if (!value) return "—";
  const time = new Date(value);
  return Number.isNaN(time.getTime()) ? value : time.toLocaleString("zh-CN", { hour12: false });
}
function errorText(error: unknown) { return String(error).replace(/^Error: Error invoking remote method '[^']+': Error: /, ""); }
function profileFor(id: AgentId): McpProfile { return id === "claude" || id === "workbuddy" || id === "trae" ? id : id === "qoder" ? "qoder-ide" : "generic"; }
function validJson(value: string) {
  try { const parsed = JSON.parse(value); return parsed && parsed.version === 1 && parsed.servers && typeof parsed.servers === "object" && !Array.isArray(parsed.servers); }
  catch { return false; }
}

export default function InteropPanel({ onRepository }: { onRepository: () => void }) {
  const [tab, setTab] = useState<"mcp" | "bridge" | "messages">("mcp");
  const [mcp, setMcp] = useState<McpSnapshot>();
  const [bridge, setBridge] = useState<BridgeSnapshot>();
  const [refreshErrors, setRefreshErrors] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [pending, setPending] = useState<string>();
  const [notice, setNotice] = useState<{ text: string; error: boolean }>();
  const [templates, setTemplates] = useState<string>();
  const [variableName, setVariableName] = useState("");
  const [variableValue, setVariableValue] = useState("");
  const [agentId, setAgentId] = useState<AgentId>("claude");
  const [profile, setProfile] = useState<McpProfile>("claude");
  const [serverIds, setServerIds] = useState<string[]>([]);
  const [includeBridge, setIncludeBridge] = useState(false);
  const [plan, setPlan] = useState<McpPlan>();
  const [overwrite, setOverwrite] = useState<string[]>([]);
  const [draft, setDraft] = useState<BridgeConfig>();
  const [remote, setRemote] = useState<BridgeRemoteInput>({ ...initialRemote });
  const [editingRemote, setEditingRemote] = useState<string>();
  const [source, setSource] = useState<AgentId>("claude");
  const [target, setTarget] = useState("");
  const [message, setMessage] = useState("");
  const [selectedTask, setSelectedTask] = useState<string>();
  const [reply, setReply] = useState("");
  const [replyState, setReplyState] = useState<BridgeReplyInput["state"]>("completed");
  const [messageFilter, setMessageFilter] = useState<"all" | "waiting" | "working" | "attention">("all");
  const mounted = useRef(true);
  const operationRunning = useRef(false);
  const refreshing = useRef<Promise<void> | undefined>(undefined);
  const mcpLoaded = useRef(false);

  async function refresh(afterMutation = false, replaceDraft = false) {
    if (!api) return;
    if (refreshing.current) { await refreshing.current; if (!afterMutation) return; }
    const operation = (async () => {
      if (mounted.current) setLoading(true);
      const values = await Promise.allSettled([api.mcpSnapshot(), api.bridgeSnapshot()]);
      if (!mounted.current) return;
      const failures: string[] = [];
      if (values[0].status === "fulfilled") {
        const next = values[0].value; setMcp(next); setTemplates(previous => previous ?? next.templatesJson);
        setServerIds(previous => previous.filter(id => next.servers.some(server => server.id === id)));
        if (!mcpLoaded.current) { mcpLoaded.current = true; setProfile(next.bindings.find(item => item.agentId === "claude")?.profile ?? "claude"); }
      } else failures.push(`MCP：${errorText(values[0].reason)}`);
      if (values[1].status === "fulfilled") {
        const next = values[1].value; setBridge(next); setDraft(previous => !previous || replaceDraft ? structuredClone(next.config) : previous);
      } else failures.push(`通信桥：${errorText(values[1].reason)}`);
      setRefreshErrors(failures); setLoading(false);
    })();
    refreshing.current = operation;
    try { await operation; }
    finally { if (refreshing.current === operation) refreshing.current = undefined; }
  }
  useEffect(() => {
    mounted.current = true; void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => { mounted.current = false; clearInterval(timer); };
  }, []);
  async function run(label: string, action: () => Promise<unknown>, replaceDraft = false) {
    if (operationRunning.current) return;
    operationRunning.current = true; setPending(label); setNotice(undefined);
    try {
      const result = await action();
      if (mounted.current) setNotice({ text: result && typeof result === "object" && "message" in result ? String(result.message) : `${label}已完成`, error: false });
    } catch (error) { if (mounted.current) setNotice({ text: errorText(error), error: true }); }
    finally { await refresh(true, replaceDraft); operationRunning.current = false; if (mounted.current) setPending(undefined); }
  }
  const binding = mcp?.bindings.find(item => item.agentId === agentId);
  const currentTask = bridge?.tasks.find(task => task.id === selectedTask);
  const destinations = [...agents, ...(bridge?.remotes ?? [])].filter(item => item.id !== source);
  const allowed = bridge?.agents.find(agent => agent.id === source)?.allowTargets ?? [];
  const availableTargets = destinations.filter(item => allowed.includes(item.id));
  const configuredSource = bridge?.agents.find(agent => agent.id === source);
  const draftChanged = !!draft && JSON.stringify(draft) !== JSON.stringify(bridge?.config);
  const validPort = !!draft && Number.isInteger(draft.port) && draft.port >= 1024 && draft.port <= 65535;
  const visibleTasks = (bridge?.tasks ?? []).filter(task => messageFilter === "all"
    || messageFilter === "waiting" && task.delivery === "queued"
    || messageFilter === "working" && task.state === "working"
    || messageFilter === "attention" && (task.delivery === "unknown" || ["failed", "input-required", "rejected", "auth-required"].includes(task.state)));
  function changeAgent(id: AgentId) { setAgentId(id); setProfile(mcp?.bindings.find(item => item.agentId === id)?.profile ?? profileFor(id)); setPlan(undefined); setOverwrite([]); }
  function updatePolicy(id: AgentId, changes: Partial<BridgeConfig["agents"][number]>) {
    setDraft(previous => previous ? { ...previous, agents: previous.agents.map(item => item.id === id ? { ...item, ...changes } : item) } : previous);
  }
  function invalidatePlan() { setPlan(undefined); setOverwrite([]); }
  function nameFor(id: string) { return agents.find(agent => agent.id === id)?.name ?? bridge?.remotes.find(item => item.id === id)?.name ?? id; }
  function pickTask(id: string) { setSelectedTask(id); setReply(""); setReplyState("completed"); }

  return <section className="interop-page" aria-label="MCP 与互联管理">
    <div className="page-heading interop-heading"><div><h2><Network size={23} />MCP 与互联</h2><p>共享服务配置，用本机通信桥传递消息，保留每个 Agent 的独立授权。</p></div><button disabled={loading} onClick={() => void refresh()}><RefreshCw size={14} className={loading ? "spin" : ""} />刷新互联状态</button></div>
    <div className="interop-boundary"><ShieldCheck size={20} /><div><strong>配置部署和消息投递均有独立状态</strong><p>配置写入不代表客户端已加载；消息进入收件箱后，需要接收方调用桥接工具收取和回复。控制台不会自动唤醒或驱动厂商模型。</p></div></div>
    {!!refreshErrors.length && <div className="interop-notice is-error" role="alert"><AlertCircle size={17} /><span>状态读取失败，保留的信息可能已过期。{refreshErrors.join("；")}</span></div>}
    {notice && <div className={`interop-notice ${notice.error ? "is-error" : ""}`} role={notice.error ? "alert" : "status"}>{notice.error ? <AlertCircle size={17} /> : <Check size={17} />}<span>{notice.text}</span><button className="icon-button" aria-label="关闭互联提示" onClick={() => setNotice(undefined)}><X size={15} /></button></div>}
    {pending && <div className="interop-pending" role="status"><LoaderCircle size={15} className="spin" />{pending}…</div>}
    <div className="interop-tabs" role="tablist" aria-label="互联功能">
      <button role="tab" aria-selected={tab === "mcp"} onClick={() => setTab("mcp")}><FileJson size={16} />共享 MCP</button>
      <button role="tab" aria-selected={tab === "bridge"} onClick={() => setTab("bridge")}><Network size={16} />本机通信桥</button>
      <button role="tab" aria-selected={tab === "messages"} onClick={() => setTab("messages")}><MessageSquare size={16} />消息与任务 <b>{bridge?.tasks.length ?? 0}</b></button>
    </div>

    {tab === "mcp" && <div className="interop-tab-body" role="tabpanel" aria-label="共享 MCP">
      {!mcp ? <div className="interop-empty">正在读取共享配置…</div> : <>
        {!mcp.root && <div className="interop-warning"><FolderOpen size={19} /><div><strong>共享模板需要统一 Git 仓库</strong><p>MCP 模板保存在统一仓库中，私有变量留在本机。本机通信桥可直接部署，无需共享模板。</p></div><button onClick={onRepository}>前往统一仓库<ArrowRight size={13} /></button></div>}
        {mcp.error && <p className="error-text" role="alert">{mcp.error}</p>}
        <section className="panel interop-template" aria-label="MCP 模板编辑">
          <div className="section-title"><span><FileJson size={18} />共享 MCP 模板</span><span className="eyebrow">GIT MANAGED</span></div>
          <p className="interop-note">只保存服务定义。密钥请写成 <code>{"${API_TOKEN}"}</code> 或 <code>{"Bearer ${API_TOKEN}"}</code>，不要把真实凭证填进共享 JSON、URL 或命令参数。</p>
          {mcp.templatePath && <code className="interop-path">{mcp.templatePath}</code>}
          <textarea className="interop-json" aria-label="MCP 模板 JSON" spellCheck={false} value={templates ?? ""} disabled={!!pending} onChange={event => { setTemplates(event.target.value); invalidatePlan(); }} />
          {!!templates && !validJson(templates) && <p className="error-text">请输入有效 JSON，包含 version: 1 和 servers 对象；其他字段会在保存时校验。</p>}
          <div className="interop-actions"><button className="primary" disabled={!!pending || !mcp.root || !validJson(templates ?? "")} onClick={() => void run("保存 MCP 模板", async () => { invalidatePlan(); return api!.mcpSaveTemplates(templates!); })}><Save size={14} />保存模板</button><button disabled={!!pending} onClick={() => { setTemplates(example); invalidatePlan(); }}>填入 HTTP 模板示例</button><button className="ghost" disabled={!!pending} onClick={() => { setTemplates(mcp.templatesJson); invalidatePlan(); }}>还原编辑内容</button><span className="interop-note">{templates !== mcp.templatesJson ? "有未保存的编辑" : "与仓库模板一致"}</span></div>
        </section>
        <section className="panel" aria-label="本机私有变量"><div className="section-title"><span><KeyRound size={18} />本机私有变量</span><span className="badge muted"><i />值不回显</span></div>
          <p className="interop-note">凭证不写入共享 Git 模板。部署时会解析到所选客户端配置文件；请保护该文件及本机备份。</p>
          <div className="interop-variable-form"><label>变量名<input aria-label="私有变量名" value={variableName} placeholder="API_TOKEN" disabled={!!pending} onChange={event => setVariableName(event.target.value)} autoComplete="off" /></label><label>新值<input type="password" aria-label="私有变量值" value={variableValue} placeholder="输入后保存，不展示已有值" disabled={!!pending} onChange={event => setVariableValue(event.target.value)} autoComplete="new-password" /></label><button disabled={!!pending || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(variableName) || !variableValue} onClick={() => { const value = variableValue; setVariableValue(""); void run("保存私有变量", async () => { invalidatePlan(); return api!.mcpSetVariable(variableName, value); }); }}><Save size={14} />保存变量</button></div>
          <div className="interop-variable-list">{mcp.variableNames.length ? mcp.variableNames.map(name => <div key={name}><code>{name}</code><span>已设置</span><button className="ghost small" disabled={!!pending} aria-label={`移除私有变量 ${name}`} onClick={() => void run("移除私有变量", async () => { invalidatePlan(); return api!.mcpSetVariable(name, ""); })}><Trash2 size={13} />移除</button></div>) : <p className="interop-note">尚未保存私有变量。</p>}</div>
        </section>
        <section className="panel" aria-label="部署 MCP 配置"><div className="section-title"><span><Server size={18} />选择客户端与服务</span></div>
          <div className="interop-form-grid"><label>目标 Agent<select aria-label="MCP 目标 Agent" value={agentId} disabled={!!pending} onChange={event => changeAgent(event.target.value as AgentId)}>{agents.map(agent => <option value={agent.id} key={agent.id}>{agent.name}</option>)}</select></label><label>客户端格式<select aria-label="MCP 客户端格式" value={profile} disabled={!!pending} onChange={event => { setProfile(event.target.value as McpProfile); invalidatePlan(); }}>{profiles.map(item => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label></div>
          <div className="interop-binding"><code className="interop-path">{binding?.file ?? "尚未绑定本机配置文件"}</code><button disabled={!!pending} onClick={() => void run("选择 MCP 配置文件", async () => { invalidatePlan(); return api!.mcpBind(agentId, profile); })}><FolderOpen size={14} />选择并绑定配置文件</button></div>
          {binding && <p className="interop-note">已绑定格式：{profiles.find(item => item.id === binding.profile)?.name}。变更格式后需重新绑定文件。通用格式只执行 JSON 合并，不代表厂商已验证支持。</p>}
          <div className="interop-server-list" aria-label="选择共享 MCP 服务">{mcp.servers.map(server => <label key={server.id} className="interop-server"><input type="checkbox" aria-label={`选择 MCP 服务 ${server.id}`} checked={serverIds.includes(server.id)} disabled={!!pending} onChange={event => { setServerIds(previous => event.target.checked ? [...previous, server.id] : previous.filter(id => id !== server.id)); invalidatePlan(); }} /><div><strong>{server.id}</strong><p>{server.description || "未填写说明"}</p>{!!server.variables.length && <small>私有变量：{server.variables.join("、")}</small>}</div><span>{server.transport}</span></label>)}{!mcp.servers.length && <p className="interop-note">尚无共享服务。可以先保存模板，也可以单独部署本机通信桥。</p>}</div>
          <label className="interop-check"><input type="checkbox" aria-label="包含本机通信桥" checked={includeBridge} disabled={!!pending} onChange={event => { setIncludeBridge(event.target.checked); invalidatePlan(); }} /><span>包含本机通信桥，为该 Agent 写入独立接入凭证</span></label>
          <p className="interop-note">本机桥需要先在“本机通信桥”中启用目标 Agent。部署后请在对应客户端重新加载 MCP 配置。</p>
          <button className="primary" disabled={!!pending || !binding || binding.profile !== profile || (!serverIds.length && !includeBridge) || templates !== mcp.templatesJson} onClick={() => void run("预览 MCP 部署", async () => { const next = await api!.mcpPreview(agentId, serverIds, includeBridge); setPlan(next); setOverwrite([]); return { message: "预览已生成，请检查新增项和同名冲突" }; })}><FileJson size={14} />预览部署</button>
        </section>
        {plan && <section className="panel interop-plan" aria-label="MCP 部署预览"><div className="section-title"><span><FileJson size={18} />部署预览</span><button className="icon-button" aria-label="关闭 MCP 部署预览" disabled={!!pending} onClick={invalidatePlan}><X size={17} /></button></div><code className="interop-path">{plan.file}</code><p className="interop-note">有效至 {stamp(plan.expiresAt)}。未勾选覆盖的同名冲突会跳过；其他新增项仍会部署。已有其他配置保留。</p>
          {plan.warnings.map((warning, index) => <p className="interop-warning-text" key={index}>{warning}</p>)}
          <div className="interop-plan-items">{plan.items.map(item => <div key={item.id}><div><strong>{item.id}</strong><span>{item.transport}</span></div>{item.action === "conflict" ? <label><input type="checkbox" aria-label={`确认覆盖 MCP 服务 ${item.id}`} checked={overwrite.includes(item.id)} disabled={!!pending} onChange={event => setOverwrite(previous => event.target.checked ? [...previous, item.id] : previous.filter(id => id !== item.id))} />确认覆盖同名配置</label> : <span className={`badge ${item.action === "add" ? "green" : "muted"}`}><i />{item.action === "add" ? "新增" : "无需变更"}</span>}</div>)}</div>
          <button className="primary" disabled={!!pending || Date.parse(plan.expiresAt) <= Date.now() || !plan.items.some(item => item.action === "add" || item.action === "conflict" && overwrite.includes(item.id))} onClick={() => void run("部署 MCP 配置", async () => { const result = await api!.mcpApply(plan.id, overwrite); invalidatePlan(); return result; })}><Save size={14} />备份并部署所选变更</button>
        </section>}
        <section className="panel" aria-label="MCP 部署记录"><div className="section-title"><span><History size={18} />部署记录与回滚</span><small>{mcp.deployments.length} 份</small></div><p className="interop-note">“配置已部署”仅表示文件写入成功。回滚会检查部署后的文件是否变化，防止覆盖客户端后续修改。</p><div className="interop-deployments">{mcp.deployments.map(deployment => <article key={deployment.id}><div><strong>{nameFor(deployment.agentId)}</strong><span className={`badge ${deployment.rolledBack ? "muted" : "green"}`}><i />{deployment.rolledBack ? "已回滚" : "配置已部署"}</span><p>{stamp(deployment.at)} · {deployment.serverIds.join("、")}</p><code className="interop-path">{deployment.file}</code></div><button disabled={!!pending || deployment.rolledBack} onClick={() => void run("回滚 MCP 部署", () => api!.mcpRollback(deployment.id))}><RotateCcw size={14} />回滚此部署</button></article>)}{!mcp.deployments.length && <p className="interop-note">尚无部署记录。</p>}</div></section>
      </>}
    </div>}

    {tab === "bridge" && <div className="interop-tab-body" role="tabpanel" aria-label="本机通信桥">
      {!bridge || !draft ? <div className="interop-empty">正在读取通信桥…</div> : <>
        {bridge.error && <p className="error-text" role="alert">{bridge.error}</p>}
        <section className="panel" aria-label="通信桥运行控制"><div className="section-title"><span><Network size={18} />本机通信桥</span><span className={`badge ${bridge.running ? "green" : "muted"}`}><i />{bridge.running ? "正在监听本机回环地址" : "已停止"}</span></div>
          <div className="interop-bridge-control"><label>本机端口<input type="number" aria-label="通信桥端口" min={1024} max={65535} value={Number.isNaN(draft.port) ? "" : draft.port} disabled={!!pending || bridge.running} onChange={event => setDraft({ ...draft, port: event.target.valueAsNumber })} /></label><code>127.0.0.1:{bridge.port}</code><button className="primary" disabled={!!pending || bridge.running || draftChanged} onClick={() => void run("启动通信桥", () => api!.bridgeStart())}><Play size={14} />启动通信桥</button><button disabled={!!pending || !bridge.running} onClick={() => void run("停止通信桥", () => api!.bridgeStop())}><Square size={14} />停止通信桥</button></div>
          <p className="interop-note">默认关闭，仅监听本机。修改端口前请先停止。启动只提供通信通道，不会启动 Agent、执行命令或处理消息内容。</p><p className="interop-note">协议：MCP {bridge.mcpVersion} · A2A {bridge.a2aVersion}。原生 A2A 远端需主动登记。</p>
        </section>
        <section className="panel" aria-label="Agent 互联授权"><div className="section-title"><span><ShieldCheck size={18} />Agent 身份与可发送目标</span></div><p className="interop-note">每个 Agent 独立凭证和发送范围。请启用所需身份并勾选允许发送的目标，然后保存；目标也需要启用才可接收。</p>
          <div className="interop-agent-grid">{bridge.agents.map(agent => {
            const policy = draft.agents.find(item => item.id === agent.id) ?? agent;
            const choices = [...agents, ...bridge.remotes].filter(item => item.id !== agent.id);
            return <article className="interop-agent" key={agent.id} data-bridge-agent={agent.id}><div className="interop-agent-heading"><h3>{agent.name}</h3><label><input type="checkbox" aria-label={`启用 ${agent.name} 互联身份`} checked={policy.enabled} disabled={!!pending} onChange={event => updatePolicy(agent.id, { enabled: event.target.checked })} />启用</label></div><p className="interop-note">{agent.enabled ? "身份已启用" : "身份未启用"} · {agent.tokenSet ? "凭证已生成" : "尚无凭证"} · 待接收 {agent.pending}</p><p className="interop-note interop-last-connected">MCP 最近请求：{agent.lastConnectedAt ? stamp(agent.lastConnectedAt) : "尚未观察到连接"}</p><p className="interop-note">请求记录不代表模型已执行；配置部署也不代表已连接。</p>
              <details><summary>可发送目标（{policy.allowTargets.length}）</summary><div className="interop-acl">{choices.map(choice => <label key={choice.id}><input type="checkbox" aria-label={`${agent.name} 允许发送至 ${choice.name}`} checked={policy.allowTargets.includes(choice.id)} disabled={!!pending} onChange={event => updatePolicy(agent.id, { allowTargets: event.target.checked ? [...policy.allowTargets, choice.id] : policy.allowTargets.filter(id => id !== choice.id) })} />{choice.name}</label>)}</div></details>
              <div className="interop-actions"><button className="small" disabled={!!pending || !agent.enabled || !agent.tokenSet} aria-label={`复制 ${agent.name} 接入配置`} onClick={() => void run("复制接入配置", () => api!.bridgeCopyConnection(agent.id))}><ClipboardCopy size={13} />复制接入配置</button><button className="ghost small" disabled={!!pending || !agent.enabled} aria-label={`轮换 ${agent.name} 接入令牌`} onClick={() => void run("轮换接入令牌", () => api!.bridgeRotateToken(agent.id))}><KeyRound size={13} />轮换令牌</button></div>
            </article>;
          })}</div><div className="interop-actions"><button className="primary" disabled={!!pending || !validPort || !draftChanged} onClick={() => void run("保存互联授权", () => api!.bridgeConfigure(draft), true)}><Save size={14} />保存端口与互联授权</button><button className="ghost" disabled={!!pending || !draftChanged} onClick={() => setDraft(structuredClone(bridge.config))}>放弃未保存修改</button><span className="interop-note">{draftChanged ? "有未保存的授权修改" : "授权与当前配置一致"}</span></div><p className="interop-note">复制的配置包含当前身份令牌，请只交给对应客户端。轮换后旧凭证立即失效，需要重新部署或复制配置。</p>
        </section>
        <section className="panel" aria-label="登记原生 A2A 远端"><div className="section-title"><span><Link2 size={18} />原生 A2A 远端</span></div><p className="interop-note">填写实际 A2A JSON-RPC 地址。登记不会发送测试消息，也不代表远端已验证；保存后在上方为发送方授权该目标。</p>
          <div className="interop-form-grid"><label>远端标识<input aria-label="A2A 远端标识" value={remote.id} placeholder="remote.reviewer" disabled={!!pending || !!editingRemote} onChange={event => setRemote({ ...remote, id: event.target.value })} /></label><label>显示名称<input aria-label="A2A 远端名称" value={remote.name} placeholder="独立审查 Agent" disabled={!!pending} onChange={event => setRemote({ ...remote, name: event.target.value })} /></label><label className="interop-full">JSON-RPC 地址<input aria-label="A2A 远端地址" value={remote.endpoint} placeholder="https://agent.example.com/a2a" disabled={!!pending} onChange={event => setRemote({ ...remote, endpoint: event.target.value })} /></label><label className="interop-full">Bearer 令牌（可选）<input type="password" aria-label="A2A 远端令牌" autoComplete="new-password" value={remote.token ?? ""} placeholder={editingRemote ? "留空保留已有凭证，不回显" : "按远端要求填写，值不回显"} disabled={!!pending} onChange={event => setRemote({ ...remote, token: event.target.value })} /></label></div>
          <label className="interop-check"><input type="checkbox" aria-label="允许本机 HTTP A2A 测试地址" checked={remote.allowLoopback} disabled={!!pending} onChange={event => setRemote({ ...remote, allowLoopback: event.target.checked })} />允许 127.0.0.1 的 HTTP 测试地址</label><div className="interop-actions"><button disabled={!!pending || !/^remote\.[a-z0-9][a-z0-9-]{0,39}$/.test(remote.id) || !remote.name.trim() || !remote.endpoint.trim()} onClick={() => { const input = { ...remote }; setRemote({ ...remote, token: "" }); void run("登记 A2A 远端", async () => { const result = await api!.bridgeSaveRemote(input); setRemote({ ...initialRemote }); setEditingRemote(undefined); return result; }); }}><Save size={14} />{editingRemote ? "保存远端修改" : "登记远端"}</button>{editingRemote && <button className="ghost" disabled={!!pending} onClick={() => { setRemote({ ...initialRemote }); setEditingRemote(undefined); }}>取消编辑远端</button>}</div>
          <div className="interop-remotes">{bridge.remotes.map(item => <article key={item.id}><div><strong>{item.name}</strong><code>{item.id}</code><code className="interop-path">{item.endpoint}</code><span className="interop-note">已登记 · {item.tokenSet ? "凭证已设置" : "未设置凭证"}{item.allowLoopback ? " · 允许本机 HTTP" : ""}</span></div><div className="interop-actions"><button className="small" disabled={!!pending} aria-label={`编辑远端 ${item.name}`} onClick={() => { setEditingRemote(item.id); setRemote({ id: item.id, name: item.name, endpoint: item.endpoint, allowLoopback: item.allowLoopback, token: "" }); }}>编辑</button><button className="ghost small" disabled={!!pending} aria-label={`移除远端 ${item.name}`} onClick={() => void run("移除 A2A 远端", async () => { const result = await api!.bridgeRemoveRemote(item.id); setDraft(previous => previous ? { ...previous, agents: previous.agents.map(policy => ({ ...policy, allowTargets: policy.allowTargets.filter(id => id !== item.id) })) } : previous); if (editingRemote === item.id) { setRemote({ ...initialRemote }); setEditingRemote(undefined); } return result; })}><Trash2 size={13} />移除</button></div></article>)}{!bridge.remotes.length && <p className="interop-note">尚未登记原生 A2A 远端。</p>}</div>
        </section>
        <section className="panel interop-example" aria-label="通信桥使用示例"><h3>让 Agent 通过桥接工具通信</h3><ol><li>保存身份和目标授权，启动通信桥，再为对应客户端部署或复制 MCP 接入配置。</li><li>发送方调用 <code>bridge_message_send</code>，例如 <code>{'{"target":"qoder","text":"请审查这个方案"}'}</code>。</li><li>接收方调用 <code>bridge_inbox_list</code> 查看收件箱，再调用 <code>bridge_task_claim</code> 收取指定 <code>taskId</code>。</li><li>处理后调用 <code>bridge_task_reply</code> 回答；发送方用 <code>bridge_task_get</code> 查看结果。</li></ol><p className="interop-note">源身份由独立令牌确定，不能在 MCP 参数中冒用其他 Agent。以上需要实际客户端调用工具；列表刷新不会驱动模型执行。</p></section>
      </>}
    </div>}

    {tab === "messages" && <div className="interop-tab-body" role="tabpanel" aria-label="消息与任务">
      {!bridge ? <div className="interop-empty">正在读取消息…</div> : <>
        <section className="panel" aria-label="发送互联测试消息"><div className="section-title"><span><Send size={18} />发送测试消息</span><span className={`badge ${bridge.running ? "green" : "muted"}`}><i />{bridge.running ? "通信桥运行中" : "通信桥已停止"}</span></div><p className="interop-note">以已授权的身份发送一条消息。目标为外部 A2A 服务时会发送到所登记地址；本机 Agent 需要主动收取。</p>
          <div className="interop-form-grid"><label>发送身份<select aria-label="消息发送身份" value={source} disabled={!!pending} onChange={event => { setSource(event.target.value as AgentId); setTarget(""); }}>{agents.map(agent => <option value={agent.id} key={agent.id}>{agent.name}{bridge.agents.find(item => item.id === agent.id)?.enabled ? "" : "（未启用）"}</option>)}</select></label><label>已授权目标<select aria-label="消息接收目标" value={target} disabled={!!pending} onChange={event => setTarget(event.target.value)}><option value="">选择已授权的目标</option>{availableTargets.map(item => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label></div>
          <textarea aria-label="测试消息内容" rows={4} maxLength={16000} value={message} disabled={!!pending} placeholder="输入要交给目标 Agent 的消息…" onChange={event => setMessage(event.target.value)} />
          <div className="interop-actions"><button className="primary" disabled={!!pending || !bridge.running || !configuredSource?.enabled || !target || !allowed.includes(target) || !message.trim()} onClick={() => void run("发送测试消息", async () => { const task = await api!.bridgeSend({ source, target, text: message }); pickTask(task.id); setMessage(""); return { message: `消息已登记：${deliveryLabels[task.delivery]}。请查看投递与处理状态。` }; })}><Send size={14} />发送测试消息</button>{!availableTargets.length && <span className="interop-note">此身份尚未授权发送目标，请先在通信桥页配置。</span>}</div>
        </section>
        <div className="interop-message-toolbar"><h3>消息与处理状态</h3><label>筛选<select aria-label="消息状态筛选" value={messageFilter} onChange={event => setMessageFilter(event.target.value as typeof messageFilter)}><option value="all">全部消息</option><option value="waiting">待接收</option><option value="working">处理中</option><option value="attention">需要关注</option></select></label><span className="interop-note">{visibleTasks.length} 条 · 每 5 秒刷新本机记录</span></div>
        <div className="interop-message-layout"><div className="interop-message-list">{visibleTasks.map(task => <button key={task.id} className={selectedTask === task.id ? "selected" : ""} data-bridge-task={task.id} onClick={() => pickTask(task.id)}><strong>{nameFor(task.source)} <ArrowRight size={12} /> {nameFor(task.target)}</strong><span className="interop-message-status">{deliveryLabels[task.delivery]} · {taskStates[task.state]}</span><p>{task.messages[0]?.text ?? "无消息正文"}</p><time>{stamp(task.updatedAt)}</time></button>)}{!visibleTasks.length && <div className="interop-empty"><MessageSquare size={24} />暂无符合条件的消息。</div>}</div>
          <section className="panel interop-message-detail" aria-label="消息详情">{!currentTask ? <div className="interop-empty">选择一条消息查看详情与回复。</div> : <><div className="section-title"><span>{nameFor(currentTask.source)}<ArrowRight size={14} />{nameFor(currentTask.target)}</span></div><div className="interop-task-tags"><span className={`badge ${currentTask.delivery === "unknown" || currentTask.state === "failed" ? "amber" : "muted"}`}><i />{deliveryLabels[currentTask.delivery]}</span><span className="badge muted"><i />{taskStates[currentTask.state]}</span></div><code className="interop-path">{currentTask.id}</code><p className="interop-note">更新于 {stamp(currentTask.updatedAt)}{currentTask.remoteTaskId ? ` · 远端任务 ${currentTask.remoteTaskId}` : ""}</p>
            {currentTask.delivery === "unknown" && <p className="interop-warning-text">发送结果未确认，不会自动重试。请先核对远端状态，避免重复派发。</p>}{currentTask.error && <p className="error-text">{currentTask.error}</p>}
            <div className="interop-conversation">{currentTask.messages.map(item => <article key={item.id}><div><strong>{item.by === "console-user" ? "控制台人工回复" : nameFor(item.by)}</strong><span>{item.role === "user" ? "请求" : "回复"} · {stamp(item.at)}</span></div><pre>{item.text}</pre></article>)}</div>
            <div className="interop-actions">{currentTask.remoteTaskId && <button disabled={!!pending} onClick={() => void run("读取远端任务进度", () => api!.bridgeRefreshTask(currentTask.id))}><RefreshCw size={14} />读取远端进度</button>}<button disabled={!!pending || ["completed", "failed", "canceled", "rejected"].includes(currentTask.state) || currentTask.delivery === "unknown"} onClick={() => void run("取消消息任务", () => api!.bridgeCancel(currentTask.id))}><X size={14} />取消任务</button></div>
            {!currentTask.target.startsWith("remote.") && !["completed", "failed", "canceled", "rejected"].includes(currentTask.state) && <div className="interop-human-reply"><h4>控制台人工回复</h4><p className="interop-note">这条回复由你提供，记录中会标记为人工回复，不代表目标厂商模型已执行。</p><textarea aria-label="人工回复内容" rows={4} maxLength={16000} value={reply} disabled={!!pending} onChange={event => setReply(event.target.value)} /><div className="interop-actions"><label>回复后状态<select aria-label="人工回复后状态" value={replyState} disabled={!!pending} onChange={event => setReplyState(event.target.value as BridgeReplyInput["state"])}><option value="completed">已完成</option><option value="input-required">等待补充输入</option><option value="failed">失败</option></select></label><button disabled={!!pending || !reply.trim()} onClick={() => void run("提交人工回复", async () => { const result = await api!.bridgeReply({ taskId: currentTask.id, text: reply, state: replyState }); setReply(""); return result; })}><Send size={14} />提交人工回复</button></div></div>}
          </>}</section></div>
      </>}
    </div>}
  </section>;
}
