import { useEffect, useRef, useState } from "react";
import { AlertCircle, ArrowRight, Check, Clock3, Download, Gift, GitCompareArrows, ListChecks, LoaderCircle, Monitor, Pause, Play, RefreshCw, Search, ShieldCheck, Trash2, Wallet, X } from "lucide-react";
import type { Result } from "./shared";
import type { TaskCenterSnapshot, TaskControlsSnapshot, TaskKind, TaskState, TaskTarget } from "./task-types";
import "./tasks.css";

const api = window.consoleApi;
const kinds = {
  sync: { label: "记忆同步", icon: GitCompareArrows },
  cleanup: { label: "备份清理", icon: Trash2 },
  claim: { label: "积分领取", icon: Gift },
  balance: { label: "余额监控", icon: Wallet },
} as const;
const states: Record<TaskState, { label: string; tone: string }> = {
  unconfigured: { label: "待配置", tone: "muted" },
  unsupported: { label: "未支持自动执行", tone: "muted" },
  disabled: { label: "未启用", tone: "muted" },
  paused: { label: "已暂停", tone: "amber" },
  waiting: { label: "等待条件", tone: "amber" },
  scheduled: { label: "等待调度", tone: "green" },
  running: { label: "执行中", tone: "green" },
  attention: { label: "需要处理", tone: "red" },
};
function formatTime(value?: string) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { hour12: false });
}
function errorText(error: unknown) {
  return String(error).replace(/^Error: Error invoking remote method '[^']+': Error: /, "");
}

export default function TaskCenterPanel({ onNavigate, onControls }: {
  onNavigate: (target: TaskTarget) => void;
  onControls: (snapshot: TaskControlsSnapshot) => void;
}) {
  const [snapshot, setSnapshot] = useState<TaskCenterSnapshot>();
  const [loading, setLoading] = useState(false);
  const [refreshError, setRefreshError] = useState<string>();
  const [pending, setPending] = useState<string>();
  const [notice, setNotice] = useState<{ text: string; error: boolean }>();
  const [kind, setKind] = useState<TaskKind | "all">("all");
  const [attentionOnly, setAttentionOnly] = useState(false);
  const [query, setQuery] = useState("");
  const mounted = useRef(true);
  const operationRunning = useRef(false);
  const refreshing = useRef<Promise<void> | undefined>(undefined);
  const controlsCallback = useRef(onControls);
  controlsCallback.current = onControls;

  async function refresh(afterMutation = false) {
    if (!api) return;
    if (refreshing.current) {
      await refreshing.current;
      if (!afterMutation) return;
    }
    const operation = (async () => {
      if (mounted.current) setLoading(true);
      try {
        const next = await api.taskCenterSnapshot();
        if (mounted.current) {
          setSnapshot(next);
          setRefreshError(undefined);
          controlsCallback.current(next);
        }
      } catch (error) {
        if (mounted.current) setRefreshError(errorText(error));
      } finally {
        if (mounted.current) setLoading(false);
      }
    })();
    refreshing.current = operation;
    try { await operation; }
    finally { if (refreshing.current === operation) refreshing.current = undefined; }
  }
  useEffect(() => {
    mounted.current = true;
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => { mounted.current = false; clearInterval(timer); };
  }, []);
  async function run(label: string, action: () => Promise<Result>) {
    if (operationRunning.current) return;
    operationRunning.current = true;
    setPending(label);
    setNotice(undefined);
    try {
      const result = await action();
      if (mounted.current) setNotice({ text: result.message, error: false });
    } catch (error) {
      if (mounted.current) setNotice({ text: errorText(error), error: true });
    } finally {
      await refresh(true);
      operationRunning.current = false;
      if (mounted.current) setPending(undefined);
    }
  }
  const tasks = snapshot?.tasks ?? [];
  const enabled = tasks.filter(task => task.enabled).length;
  const running = tasks.filter(task => task.state === "running").length;
  const needsAttention = (state: TaskState) => state === "attention" || state === "waiting";
  const attention = tasks.filter(task => needsAttention(task.state)).length;
  const visible = tasks.filter(task => (kind === "all" || task.kind === kind)
    && (!attentionOnly || needsAttention(task.state))
    && (task.name + " " + task.message).toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const controls = snapshot?.controls;
  const runtime = snapshot?.runtime;

  return <section className="tasks-page" aria-label="自动任务中心">
    <div className="page-heading tasks-heading">
      <div><h2><ListChecks size={23} />任务中心</h2><p>统一查看自动任务、处理异常，并控制下一次执行。</p></div>
      <button disabled={loading} onClick={() => void refresh()}><RefreshCw size={14} className={loading ? "spin" : ""} />刷新任务</button>
    </div>
    {refreshError && <div className="tasks-notice is-error" role="alert"><AlertCircle size={17} /><span>任务状态读取失败，以下信息可能已过期。{refreshError}</span></div>}
    {notice && <div className={`tasks-notice ${notice.error ? "is-error" : ""}`} role={notice.error ? "alert" : "status"}>
      {notice.error ? <AlertCircle size={17} /> : <Check size={17} />}<span>{notice.text}</span>
      <button className="icon-button" aria-label="关闭任务提示" onClick={() => setNotice(undefined)}><X size={15} /></button>
    </div>}
    {pending && <div className="tasks-pending" role="status"><LoaderCircle size={15} className="spin" />{pending}… 页面继续刷新运行状态。</div>}
    {!snapshot ? <div className="tasks-loading"><LoaderCircle className="spin" />正在读取自动任务…</div> : <>
      <div className="tasks-summary" aria-label="任务概览">
        <div><ListChecks size={19} /><span>自动任务<strong>{tasks.length}</strong></span></div>
        <div><Play size={19} /><span>独立开关已启用<strong>{enabled}</strong></span></div>
        <div><ActivityIcon running={!!running} /><span>当前执行中<strong>{running}</strong></span></div>
        <div className={attention ? "has-issues" : ""}><AlertCircle size={19} /><span>需要关注<strong>{attention}</strong></span></div>
      </div>
      <section className={`panel tasks-control ${controls?.paused ? "is-paused" : ""}`} aria-label="自动任务总开关">
        <div className="tasks-control-heading"><div className="tasks-control-title">{controls?.paused ? <Pause size={21} /> : <ShieldCheck size={21} />}<div>
          <h3>{controls?.paused ? "自动任务已统一暂停" : "自动任务按各自设置运行"}</h3>
          <p>{controls?.paused ? controls.pauseUntil ? `暂停至 ${formatTime(controls.pauseUntil)}` : "暂停到你主动恢复" : "只有已配置并启用的任务会进入调度。"}</p>
        </div></div><span className={`badge ${controls?.paused ? "amber" : "green"}`}><i />{controls?.paused ? "总暂停" : "正常调度"}</span></div>
        {controls?.error && <p className="error-text" role="alert">控制设置需要修复：{controls.error}</p>}
        {runtime?.busy && <div className="tasks-runtime" role="status"><LoaderCircle size={15} className="spin" />{controls?.paused ? "已有操作正在收尾，结束后暂停后续自动任务。" : "本地操作正在执行，后续任务会依次处理。"}</div>}
        {runtime?.calibrationUntil && new Date(runtime.calibrationUntil).getTime() > Date.now() && <div className="tasks-runtime"><Clock3 size={15} />客户端校准中，积分与余额自动任务等待至 {formatTime(runtime.calibrationUntil)}。</div>}
        <div className="tasks-control-buttons">
          <button disabled={!!pending} onClick={() => void run("正在暂停 15 分钟", () => api!.taskPause(15))}><Pause size={14} />暂停 15 分钟</button>
          <button disabled={!!pending} onClick={() => void run("正在暂停 1 小时", () => api!.taskPause(60))}><Pause size={14} />暂停 1 小时</button>
          <button disabled={!!pending} onClick={() => void run("正在暂停自动任务", () => api!.taskPause(null))}><Pause size={14} />暂停直到恢复</button>
          <button className="primary" disabled={!!pending || (!controls?.paused && !controls?.error)} onClick={() => void run("正在恢复自动任务", () => api!.taskResume())}><Play size={14} />恢复自动任务</button>
        </div>
        <p className="tasks-note">暂停只阻止后续自动执行，不中断正在进行的操作；手动操作仍可使用。恢复保留各任务的独立开关，不会开启已关闭或结果未确认的任务。</p>
      </section>
      <div className="tasks-options-grid">
        <section className="panel tasks-option" aria-label="后台运行设置">
          <h3><Monitor size={18} />后台运行</h3>
          <label className="tasks-tray-option"><input type="checkbox" aria-label="关闭窗口后留在系统托盘" checked={controls?.closeToTray ?? false} disabled={!!pending} onChange={event => { const enabled = event.target.checked; void run("正在更新托盘设置", () => api!.taskTray(enabled)); }} /><span>关闭窗口后留在系统托盘</span></label>
          <p className="tasks-note">默认关闭。开启后，关闭窗口仍会运行自动任务；从托盘菜单选择“彻底退出”才会结束程序。</p>
          {controls?.closeToTray && !runtime?.trayAvailable && <p className="error-text">系统托盘尚未就绪，关闭窗口前请检查后台运行状态。</p>}
        </section>
        <section className="panel tasks-option" aria-label="导出运行报告">
          <h3><Download size={18} />导出运行报告</h3>
          <div className="tasks-report-buttons"><button disabled={!!pending} onClick={() => void run("正在导出任务报告", () => api!.taskReport("tasks"))}><Download size={14} />任务报告 CSV</button>
            <button disabled={!!pending} onClick={() => void run("正在导出余额记录", () => api!.taskReport("balances"))}><Download size={14} />余额记录 CSV</button></div>
          <p className="tasks-note">选择本地保存位置。余额按平台和单位分别导出，不合计不同平台积分。</p>
        </section>
      </div>
      <section className="panel tasks-issues" aria-label="待处理问题">
        <div className="section-title"><span><AlertCircle size={17} />待处理问题 <small>{snapshot.issues.length} 项</small></span></div>
        {snapshot.issues.length ? <div className="tasks-issue-list">{snapshot.issues.map(issue => <article className={`task-issue ${issue.severity}`} key={issue.id} data-task-issue={issue.id}>
          <AlertCircle size={17} /><div><h4>{issue.title}</h4><p>{issue.detail}</p></div><button className="small" aria-label={`处理问题：${issue.title}`} onClick={() => onNavigate(issue.target)}>前往处理<ArrowRight size={13} /></button>
        </article>)}</div> : <p className="tasks-clear"><Check size={16} />当前没有已报告的问题。待配置或未启用的任务不会自动执行。</p>}
      </section>
      <section className="tasks-inventory" aria-label="自动任务列表">
        <div className="tasks-filter-bar"><div className="tasks-filters" aria-label="按任务类别筛选">
          <button className={kind === "all" ? "selected" : ""} aria-pressed={kind === "all"} onClick={() => setKind("all")}>全部任务 <b>{tasks.length}</b></button>
          {(Object.keys(kinds) as TaskKind[]).map(value => <button key={value} className={kind === value ? "selected" : ""} aria-pressed={kind === value} onClick={() => setKind(value)}>{kinds[value].label} <b>{tasks.filter(task => task.kind === value).length}</b></button>)}
        </div><label className="tasks-search"><Search size={14} /><input aria-label="搜索自动任务" value={query} placeholder="搜索任务或原因…" onChange={event => setQuery(event.target.value)} /></label></div>
        <div className="tasks-list-caption"><label><input type="checkbox" checked={attentionOnly} onChange={event => setAttentionOnly(event.target.checked)} />只看需要关注</label><span>显示 {visible.length} / {tasks.length} 项 · 每 5 秒刷新 · {formatTime(snapshot.at)}</span></div>
        {visible.length ? <div className="tasks-groups">{(Object.entries(kinds) as [TaskKind, typeof kinds[TaskKind]][]).map(([value, meta]) => {
          const group = visible.filter(task => task.kind === value);
          return group.length ? <section className="task-group" key={value} aria-label={`${meta.label}任务`}><h3><meta.icon size={17} />{meta.label}<span>{group.length}</span></h3><div className="task-card-grid">{group.map(task => <article className={`task-card state-${task.state}`} key={task.id} data-task-id={task.id}>
            <div className="task-card-title"><h4>{task.name}</h4><span className={`badge ${states[task.state].tone}`}><i />{states[task.state].label}</span></div>
            <p className="task-message">{task.message}</p>
            <dl><div><dt>独立开关</dt><dd>{task.enabled ? "已启用" : "未启用"}</dd></div><div><dt>最近尝试</dt><dd>{formatTime(task.lastAttempt)}</dd></div><div><dt>下次检查</dt><dd>{formatTime(task.nextCheck)}</dd></div></dl>
            <button className="ghost small" aria-label={`配置任务：${task.name}`} onClick={() => onNavigate(task.target)}>查看与配置<ArrowRight size={13} /></button>
          </article>)}</div></section> : null;
        })}</div> : <div className="tasks-empty"><Search size={23} /><p>没有符合条件的任务。</p><button className="ghost" onClick={() => { setKind("all"); setAttentionOnly(false); setQuery(""); }}>清除筛选</button></div>}
      </section>
    </>}
  </section>;
}

function ActivityIcon({ running }: { running: boolean }) {
  return running ? <LoaderCircle size={19} className="spin" /> : <Clock3 size={19} />;
}
