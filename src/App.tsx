import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  Activity,
  ArrowDownToLine,
  ArrowRight,
  ArrowUpRight,
  Boxes,
  Check,
  ChevronRight,
  CircleHelp,
  Clock3,
  Database,
  FileText,
  Fingerprint,
  Folder,
  FolderOpen,
  Gift,
  History,
  Layers3,
  LayoutDashboard,
  Link2,
  ListChecks,
  LoaderCircle,
  LockKeyhole,
  Network,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  Terminal,
  Unplug,
  X,
} from "lucide-react";
import type { AgentId, AgentView, PathKind, Plan, Snapshot, SkillsInfo } from "./shared";
import RepositoryPanel, { RepositoryProgressStatus } from "./RepositoryPanel";
import type { RepositoryProgress } from "./repository-types";
import RewardsPanel from "./RewardsPanel";
import TaskCenterPanel from "./TaskCenterPanel";
import InteropPanel from "./InteropPanel";
import type { TaskControlsSnapshot } from "./task-types";

const api = window.consoleApi;
type Tab = "overview" | "tasks" | "repository" | "rewards" | "interop" | "backups" | "activity" | "integrations";
const nav = [
  { id: "overview", name: "监控总览", icon: LayoutDashboard },
  { id: "tasks", name: "任务中心", icon: ListChecks },
  { id: "repository", name: "统一仓库", icon: Database },
  { id: "rewards", name: "积分福利", icon: Gift },
  { id: "interop", name: "MCP 与互联", icon: Network },
  { id: "backups", name: "备份快照", icon: History },
  { id: "activity", name: "活动台账", icon: Activity },
  { id: "integrations", name: "集成能力", icon: Boxes },
] as const;
const stateNames = {
  ready: "路径完整",
  partial: "部分发现",
  missing: "未配置",
  attention: "需检查",
};
const time = (value?: string) =>
  value ? new Date(value).toLocaleTimeString("zh-CN", { hour12: false }) : "—";
const date = (value: string) =>
  new Date(value).toLocaleString("zh-CN", { hour12: false });
function Badge({
  children,
  tone = "muted",
}: {
  children: ReactNode;
  tone?: string;
}) {
  return (
    <span className={`badge ${tone}`}>
      <i />
      {children}
    </span>
  );
}
function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="empty">
      <FolderOpen size={24} />
      <span>{children}</span>
    </div>
  );
}
function Path({ value }: { value?: string }) {
  return (
    <code className="path" title={value}>
      {value || "尚未选择本地路径"}
    </code>
  );
}

function SkillLinks({ info }: { info?: SkillsInfo }) {
  if (!info) return null;
  return <div className="skill-links">
    {!!info.links?.length && <details>
      <summary>{info.links.length} 个链接 / junction · 查看实际位置</summary>
      <div className="skill-link-list">
        {info.links.map(link => <div key={link.path}>
          <Path value={link.path} />
          <span className="secondary">指向{link.kind === "directory" ? "目录" : "文件"}</span>
          <Path value={link.target} />
        </div>)}
      </div>
      <p className="footnote">同步会写入实际位置，保留原链接；共用该位置的其他 Agent 也会看到变更。</p>
    </details>}
    {info.warnings?.map((warning, index) => <p className="error-text" key={index}>{warning}</p>)}
    {!!info.warnings?.length && <p className="footnote">有效项目仍已计入统计。请修复以上项目后，再授权同步。</p>}
  </div>;
}

export default function App() {
  const [data, setData] = useState<Snapshot>();
  const [tab, setTab] = useState<Tab>("overview");
  const [detail, setDetail] = useState<AgentId>();
  const [plan, setPlan] = useState<Plan>();
  const [planIndex, setPlanIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ text: string; error: boolean }>();
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [prompt, setPrompt] = useState("");
  const [auto, setAuto] = useState(true);
  const [taskControls, setTaskControls] = useState<TaskControlsSnapshot>();
  const [taskControlsError, setTaskControlsError] = useState<string>();
  const [repositoryProgress, setRepositoryProgress] = useState<RepositoryProgress>();
  const [dismissedRepositoryProgress, setDismissedRepositoryProgress] = useState<string>();
  const [repositoryOpened, setRepositoryOpened] = useState(false);
  const refreshing = useRef(false);
  useEffect(() => {
    if (tab === "repository") setRepositoryOpened(true);
  }, [tab]);
  useEffect(() => {
    if (!api) return;
    let active = true;
    let pending = false;
    async function pollRepositoryProgress() {
      if (pending) return;
      pending = true;
      try {
        const next = await api!.repositoryProgress();
        if (active) setRepositoryProgress(current =>
          current?.id === next?.id && current?.updatedAt === next?.updatedAt && current?.state === next?.state ? current : next);
      } catch {
        // Existing operation and errors stay visible if a lightweight poll is interrupted.
      } finally { pending = false; }
    }
    void pollRepositoryProgress();
    const timer = window.setInterval(() => void pollRepositoryProgress(), 800);
    return () => { active = false; window.clearInterval(timer); };
  }, []);
  useEffect(() => {
    if (!api) return;
    let active = true;
    let pending = false;
    async function pollControls() {
      if (pending) return;
      pending = true;
      try {
        const next = await api!.taskControlsSnapshot();
        if (active) { setTaskControls(next); setTaskControlsError(undefined); }
      } catch (error) {
        if (active) setTaskControlsError(String(error).replace(/^Error: Error invoking remote method '[^']+': Error: /, ""));
      } finally { pending = false; }
    }
    void pollControls();
    const timer = setInterval(() => void pollControls(), 5000);
    return () => { active = false; clearInterval(timer); };
  }, []);
  async function refresh() {
    if (!api || refreshing.current) return;
    refreshing.current = true;
    try {
      setData(await api.snapshot());
    } catch (e) {
      setNotice({ text: String(e), error: true });
    } finally {
      refreshing.current = false;
    }
  }
  useEffect(() => {
    void refresh();
  }, []);
  const running = data?.agents.some((a) => a.process.running);
  useEffect(() => {
    if (!auto) return;
    const timer = setInterval(() => void refresh(), running ? 2000 : 30000);
    return () => clearInterval(timer);
  }, [auto, running]);
  useEffect(() => {
    if (!notice || notice.error) return;
    const timer = setTimeout(() => setNotice(undefined), 6000);
    return () => clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setDetail(undefined);
        setPlan(undefined);
      }
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);
  async function run(action: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    try {
      const result = await action();
      if (result && typeof result === "object" && "message" in result)
        setNotice({ text: String(result.message), error: false });
      await refresh();
    } catch (e) {
      setNotice({
        text: String(e).replace(
          /^Error: Error invoking remote method '[^']+': Error: /,
          "",
        ),
        error: true,
      });
    } finally {
      setBusy(false);
    }
  }
  const current = data?.agents.find((a) => a.id === detail);
  const ready = data?.agents.filter((a) => a.state === "ready").length || 0;
  const attention =
    data?.agents.filter((a) => a.state === "attention").length || 0;
  const managed = data?.repository?.agentIds.length || 0;
  const filtered =
    data?.agents.filter(
      (a) =>
        (statusFilter === "all" || a.state === statusFilter) &&
        (a.name + " " + a.subtitle).toLowerCase().includes(query.toLowerCase()),
    ) || [];

  function RepositoryEntry() {
    return <div className="repository-entry">
      <Database size={26} />
      <div><strong>统一管理记忆与技能</strong><p>在统一仓库中选择纳管 Agent，预览双向同步、管理 Git 版本与技能连接。</p><Path value={data?.repository?.root} /></div>
      <button className="primary" onClick={() => setTab("repository")}>进入统一仓库<ArrowRight size={14} /></button>
    </div>;
  }
  function Backups({ compact = false }: { compact?: boolean }) {
    const rows = compact ? data?.backups.slice(0, 4) : data?.backups;
    return (
      <section className="panel" id="backups">
        <div className="section-title">
          <span>
            <History size={17} />
            记忆与技能备份 <small>{data?.backups.length || 0} 份快照</small>
          </span>
          <button
            className="ghost small"
            disabled={busy}
            onClick={() => void run(() => api!.reveal(null, "storage"))}
          >
            打开存储目录
            <ArrowUpRight size={13} />
          </button>
        </div>
        <p className="secondary">
          每次替换前自动备份。恢复也会先预览，并备份当前版本；新增文件不会被删除。
        </p>
        {rows?.length ? (
          <div className="backup-list">
            {rows.map((b) => (
              <div className="backup-row" key={b.id}>
                <div className="backup-icon">
                  <Database size={16} />
                </div>
                <div>
                  <strong>
                    {data?.agents.find((a) => a.id === b.agent)?.name}
                  </strong>
                  <p>
                    {b.label} · {b.files} 个文件
                  </p>
                </div>
                <time>{date(b.at)}</time>
                <button
                  className="small"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      setPlan(await api!.restore(b.id));
                      setPlanIndex(0);
                    })
                  }
                >
                  <History size={13} />
                  预览恢复
                </button>
              </div>
            ))}
          </div>
        ) : (
          <Empty>
            还没有快照。进入 Agent 详情授权路径后，即可创建第一份备份。
          </Empty>
        )}
        {compact && (data?.backups.length || 0) > 4 && (
          <button className="ghost" onClick={() => setTab("backups")}>
            查看全部快照
            <ArrowRight size={14} />
          </button>
        )}
      </section>
    );
  }
  function Logs({ compact = false }: { compact?: boolean }) {
    const rows = compact ? data?.logs.slice(0, 7) : data?.logs;
    return (
      <section className="panel" id="activity">
        <div className="section-title">
          <span>
            <Activity size={17} />
            活动时间轴
          </span>
          <Badge tone={data?.auditValid ? "green" : "red"}>
            {data?.auditValid ? "哈希链完整" : "校验异常"}
          </Badge>
        </div>
        <p className="secondary">
          仅记录本机控制台的操作，不采集第三方会话内容。
        </p>
        {rows?.length ? (
          <div className="timeline">
            {rows.map((row) => (
              <div className="event" key={row.seq}>
                <time title={date(row.at)}>{time(row.at)}</time>
                <i />
                <div>
                  <strong>{row.action}</strong>
                  <p title={row.detail}>{row.detail}</p>
                </div>
                <span className="event-seq">#{row.seq}</span>
              </div>
            ))}
          </div>
        ) : (
          <Empty>等待第一条活动。自动检查不会修改 Agent 文件。</Empty>
        )}
        {data?.auditError && <p className="error-text">{data.auditError}</p>}
        {compact && (
          <button className="ghost small" onClick={() => setTab("activity")}>
            查看完整台账
            <ArrowRight size={13} />
          </button>
        )}
      </section>
    );
  }

  if (!api)
    return (
      <div className="unavailable">
        <ShieldCheck size={40} />
        <h1>请在 Windows 桌面应用中打开</h1>
        <p>浏览器页面没有本地文件或进程权限。请按运行说明启动 Electron。</p>
        <code>npm run dev</code>
      </div>
    );
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand-mark">
          <Layers3 size={23} />
        </div>
        <div className="nav-items">
          {nav.map((n) => (
            <button
              key={n.id}
              aria-label={n.name}
              title={n.name}
              className={tab === n.id ? "active" : ""}
              onClick={() => setTab(n.id)}
            >
              <n.icon size={21} />
              <span>{n.id === "interop" ? "互联" : n.name.slice(0, 2)}</span>
            </button>
          ))}
        </div>
        <div className="sidebar-bottom">
          <ShieldCheck size={20} />
          <span>LOCAL</span>
          <span className="online-dot" />
        </div>
      </aside>
      <main>
        <div className="topline">
          <span>
            <span className="topline-brand">AGENT BRAIN</span>
            <span className="slash">/</span>本地工作空间
          </span>
          <span className="local-label">
            <LockKeyhole size={12} />
            本地管理 · 按授权互联
          </span>
        </div>
        <header>
          <div className="hero-icon">
            <Sparkles size={30} />
            <i />
          </div>
          <div className="heading">
            <div className="eyebrow">PERSONAL AGENT CONTROL CENTER</div>
            <h1>
              记忆与技能同步守护<span> / </span>
              <small>{nav.find((n) => n.id === tab)?.name}</small>
            </h1>
            <p>一个控制台，照看你的每一位 AI 搭档。</p>
          </div>
          <div className="header-actions">
            <label className="auto-refresh">
              <input
                type="checkbox"
                checked={auto}
                onChange={(e) => setAuto(e.target.checked)}
              />
              30 秒自动检查
            </label>
            <button
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await refresh();
                  return { message: "本地检查已完成" };
                })
              }
            >
              <RefreshCw size={14} className={busy ? "spin" : ""} />
              刷新
            </button>
          </div>
        </header>
        {repositoryProgress && repositoryProgress.id !== dismissedRepositoryProgress && <RepositoryProgressStatus
          progress={repositoryProgress}
          onOpen={() => setTab("repository")}
          onDismiss={() => setDismissedRepositoryProgress(repositoryProgress.id)}
        />}
        {(taskControls?.controls.paused || taskControls?.controls.error || taskControlsError) && <aside className={`tasks-global-pause ${taskControls?.controls.error || taskControlsError ? "is-error" : ""}`} aria-label="自动任务全局状态" role="status">
          <Pause size={20} /><div>
            <strong>{taskControls?.controls.paused ? "自动任务已统一暂停" : "自动任务状态需要检查"}</strong>
            <p>{taskControls?.controls.paused && (taskControls.controls.pauseUntil ? `暂停至 ${date(taskControls.controls.pauseUntil)}。` : "暂停直到主动恢复。")}{taskControls?.runtime.busy && taskControls?.controls.paused ? "已有操作正在收尾；后续自动任务暂停。" : "手动操作仍可使用。"}{taskControls?.controls.error || taskControlsError ? ` ${taskControls?.controls.error || taskControlsError}` : ""}</p>
          </div><button className="small" onClick={() => setTab("tasks")}>查看任务中心<ArrowRight size={13} /></button>
        </aside>}
        {!data ? (
          <div className="loading">
            <LoaderCircle className="spin" />
            正在检查本地 Agent 路径…
          </div>
        ) : (
          <>
            {tab === "overview" && (
              <>
                <section
                  className={`health-banner ${attention || !data.auditValid ? "warning" : ""}`}
                >
                  <div className="health-symbol">
                    <ShieldCheck size={26} />
                  </div>
                  <div className="health-text">
                    <h2>
                      {attention || !data.auditValid
                        ? "有路径需要检查"
                        : ready
                          ? "本地守护已就绪"
                          : "等待接入你的 Agent"}
                      <Badge tone={attention ? "amber" : "green"}>
                        只读巡检
                      </Badge>
                    </h2>
                    <p>
                      发现{" "}
                      {data.agents.filter((a) => a.state !== "missing").length}{" "}
                      个 Agent 的本地文件或程序 · {managed}{" "}
                      个已纳入统一仓库 · 未授权路径不会被同步
                    </p>
                  </div>
                  <div className="health-metrics">
                    <div>
                      <span>运行进程</span>
                      <strong>
                        {data.agents.filter((a) => a.process.running).length}
                        <small> 个</small>
                      </strong>
                    </div>
                    <div>
                      <span>仓库纳管</span>
                      <strong className="mono">
                        {managed} / {data.agents.length}
                      </strong>
                    </div>
                    <div>
                      <span>上次检查</span>
                      <strong>{time(data.at)}</strong>
                    </div>
                  </div>
                </section>
                <div className="cards-toolbar">
                  <div className="filter-group">
                    {[
                      { id: "all", label: "全部", count: data.agents.length },
                      { id: "ready", label: "路径完整", count: ready },
                      {
                        id: "partial",
                        label: "部分发现",
                        count: data.agents.filter((a) => a.state === "partial")
                          .length,
                      },
                      { id: "attention", label: "需检查", count: attention },
                      {
                        id: "missing",
                        label: "未配置",
                        count: data.agents.filter((a) => a.state === "missing")
                          .length,
                      },
                    ].map((f) => (
                      <button
                        className={`filter ${statusFilter === f.id ? "selected" : ""}`}
                        key={f.id}
                        onClick={() => setStatusFilter(f.id)}
                      >
                        <i className={f.id} />
                        {f.label}
                        <b>{f.count}</b>
                      </button>
                    ))}
                  </div>
                  <div className="search">
                    <Search size={14} />
                    <input
                      aria-label="搜索 Agent"
                      placeholder="搜索 Agent…"
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                    />
                  </div>
                </div>
                <div className="agent-grid">
                  {filtered.map((a) => (
                    <article
                      className={`agent-card ${a.state === "missing" ? "is-missing" : ""}`}
                      key={a.id}
                      style={{ "--accent": a.accent } as CSSProperties}
                    >
                      <div className="card-top">
                        <span>
                          MEMORY UNIT <span>· {a.id.toUpperCase()}</span>
                        </span>
                        <Badge tone={data.repository?.agentIds.includes(a.id) ? "green" : "muted"}>{data.repository?.agentIds.includes(a.id) ? "已纳管" : "未纳管"}</Badge>
                      </div>
                      <div className="agent-identity">
                        <div className="avatar">
                          {a.glyph}
                          <i />
                        </div>
                        <div>
                          <h3>{a.name}</h3>
                          <p>{a.subtitle}</p>
                          <span
                            className={`support-label ${a.integration === "documented" ? "documented" : ""}`}
                          >
                            {a.integration === "documented"
                              ? a.mode === "cli"
                                ? "文档适配 · CLI"
                                : "文档适配 · 文件路径"
                              : "通用适配 · 待验证"}
                          </span>
                        </div>
                      </div>
                      <div className="memory-status">
                        <div>
                          <Badge
                            tone={
                              a.state === "ready"
                                ? "green"
                                : a.state === "attention"
                                  ? "amber"
                                  : "muted"
                            }
                          >
                            {stateNames[a.state]}
                          </Badge>
                          {a.process.running && (
                            <Badge tone="green">运行中</Badge>
                          )}
                        </div>
                        <div className="fingerprint">
                          <Fingerprint size={17} />
                          <strong>
                            {a.memory.hash?.slice(0, 10) || "尚未读取记忆"}
                          </strong>
                        </div>
                        <div className="memory-caption">
                          <span>
                            {data.repository?.agentIds.includes(a.id) ? "到统一仓库预览同步差异" : "可在统一仓库中选择纳管"}
                          </span>
                          <span>
                            {a.memoryApproved ? "已授权" : "只读发现"}
                          </span>
                        </div>
                      </div>
                      <div className="card-path">
                        <span>记忆路径</span>
                        <Path value={a.memory.path} />
                      </div>
                      <div className="agent-stats">
                        <div>
                          <span>总字符</span>
                          <strong>
                            {a.memory.chars?.toLocaleString() ?? "—"}
                          </strong>
                        </div>
                        <div>
                          <span>技能</span>
                          <strong>
                            {a.skills.exists && !a.skills.error
                              ? a.skills.count
                              : "—"}
                          </strong>
                        </div>
                        <div>
                          <span>最后写入</span>
                          <strong className="time-value">
                            {time(a.memory.modified)}
                          </strong>
                        </div>
                      </div>
                      <button
                        className="card-detail"
                        onClick={() => {
                          setDetail(a.id);
                          setPrompt("");
                        }}
                      >
                        <span>
                          <ChevronRight size={14} />
                          查看检查与配置
                        </span>
                        <span>
                          {a.memoryApproved || a.skillsApproved
                            ? "已授权路径"
                            : "待授权"}
                          <Settings2 size={13} />
                        </span>
                      </button>
                    </article>
                  ))}
                </div>
                {!filtered.length && <Empty>没有符合条件的 Agent。</Empty>}
                <div className="notice-strip">
                  <span className="online-dot" />
                  文件状态来自实际检查；积分余额需单独配置监控，登录状态与厂商会话尚未接入。
                  <button onClick={() => setTab("integrations")}>
                    查看支持范围
                    <ArrowRight size={13} />
                  </button>
                </div>
                <RepositoryEntry />
                <div className="lower-grid">
                  <section className="panel fingerprint-panel">
                    <div className="section-title">
                      <span>
                        <Fingerprint size={17} />
                        仓库管理
                      </span>
                      <span className="eyebrow">LOCAL GIT</span>
                    </div>
                    <div className="fingerprint-orbit">
                      <Database size={45} />
                    </div>
                    <div className="key-value">
                      <span>统一仓库</span>
                      <strong>{data.repository ? "已配置" : "待配置"}</strong>
                    </div>
                    <div className="key-value">
                      <span>已纳管 Agent</span>
                      <strong className="green-text">{managed} / {data.agents.length}</strong>
                    </div>
                    <div className="key-value">
                      <span>活动记录</span>
                      <strong>{data.logs[0]?.seq || 0} 条</strong>
                    </div>
                    <div className="key-value">
                      <span>自动同步</span>
                      <strong>{data.repository?.automation.enabled ? "已启用 · 详见任务中心" : "未启用"}</strong>
                    </div>
                    <p className="footnote">
                      纳管表示已选择管理范围；文件差异和冲突以统一仓库的双向同步预览为准。
                    </p>
                  </section>
                  <Logs compact />
                </div>
                <Backups compact />
              </>
            )}
            {(repositoryOpened || tab === "repository") && <div hidden={tab !== "repository"}>
              <RepositoryPanel onChange={refresh} progress={repositoryProgress} />
            </div>}
            {tab === "rewards" && <RewardsPanel />}
            {tab === "interop" && <InteropPanel onRepository={() => setTab("repository")} />}
            {tab === "tasks" && <TaskCenterPanel onNavigate={setTab} onControls={snapshot => { setTaskControls(snapshot); setTaskControlsError(undefined); }} />}
            {tab === "backups" && (
              <>
                <div className="page-heading">
                  <h2>每一次变更，都有来处</h2>
                  <p>只保存在此电脑。先授权 Agent 路径，即可手动创建快照。</p>
                </div>
                <div className="backup-actions">
                  {data.agents.map((a) => (
                    <button
                      disabled={
                        busy || (!a.memoryApproved && !a.skillsApproved)
                      }
                      key={a.id}
                      onClick={() => void run(() => api!.backup(a.id))}
                    >
                      <ArrowDownToLine size={15} />
                      {a.name}
                    </button>
                  ))}
                </div>
                <Backups />
              </>
            )}
            {tab === "activity" && (
              <>
                <div className="page-heading">
                  <h2>本地操作，清晰可查</h2>
                  <p>
                    展示最近 100 条；完整记录保存在本地 JSONL
                    台账。哈希链可检测意外改动，不等同于防篡改审计。
                  </p>
                </div>
                <Logs />
              </>
            )}
            {tab === "integrations" && (
              <>
                <div className="page-heading">
                  <h2>清晰的能力边界</h2>
                  <p>
                    发现文件不代表厂商协议兼容；实际读写能力与厂商集成状态分别呈现。
                  </p>
                </div>
                <section className="panel">
                  <div className="section-title">
                    <span>
                      <Boxes size={17} />
                      Adapter 注册表
                    </span>
                    <Badge>{data.agents.length} 个内置适配器</Badge>
                  </div>
                  <div className="integration-table">
                    <div className="integration-head">
                      <span>Agent</span>
                      <span>适配依据</span>
                      <span>进程能力</span>
                      <span>说明</span>
                    </div>
                    {data.agents.map((a) => (
                      <div className="integration-row" key={a.id}>
                        <strong>{a.name}</strong>
                        <Badge
                          tone={
                            a.integration === "documented" ? "green" : "amber"
                          }
                        >
                          {a.integration === "documented"
                            ? "文档适配"
                            : "候选 / 未验证"}
                        </Badge>
                        <span>
                          {a.mode === "cli"
                            ? "原生 / npm 单次任务"
                            : "用户绑定 EXE 启动"}
                        </span>
                        <p>{a.note}</p>
                      </div>
                    ))}
                  </div>
                </section>
                <div className="source-grid">
                  <section className="panel">
                    <div className="section-title">
                      <span>
                        <ShieldCheck size={17} />
                        已实现
                      </span>
                    </div>
                    <ul className="capabilities">
                      <li>候选路径只读发现、文件 SHA-256 与技能目录检查</li>
                      <li>显式授权路径、同步差异、冲突检查与原子文件替换</li>
                      <li>手动快照、写入前备份、恢复预览与活动哈希链</li>
                      <li>受限 IPC、本地 EXE 启动、所属进程停止与 CLI 输出</li>
                      <li>独立 Git 仓库、多文件记忆分区、双向合并与冲突处理</li>
                      <li>应用运行期间自动同步、备份保留清理与授权技能 junction</li>
                    </ul>
                  </section>
                  <section className="panel">
                    <div className="section-title">
                      <span>
                        <Unplug size={17} />
                        能力边界
                      </span>
                    </div>
                    <ul className="capabilities muted-list">
                      <li>厂商登录、额度、历史会话或后台任务 API</li>
                      <li>接管已在运行的第三方进程与跨厂商会话迁移</li>
                      <li>不自动推送到云端，不将一端的删除传播到另一端</li>
                      <li>自动同步仅在应用运行期间执行；不执行技能脚本或任意命令</li>
                    </ul>
                  </section>
                </div>
              </>
            )}
            <footer>
              <span>
                <LockKeyhole size={12} />
                LOCAL FIRST<span>·</span>所有路径与备份保留在本机
              </span>
              <span>
                AGENT MEMORY CONSOLE <b>v0.7.1</b>
              </span>
            </footer>
          </>
        )}
      </main>
      {notice && (
        <div role="status" className={`toast ${notice.error ? "error" : ""}`}>
          <span>
            {notice.error ? <CircleHelp size={17} /> : <Check size={17} />}
          </span>
          <p>{notice.text}</p>
          <button aria-label="关闭提示" onClick={() => setNotice(undefined)}>
            <X size={15} />
          </button>
        </div>
      )}
      {current && (
        <div className="overlay" onClick={() => setDetail(undefined)}>
          <section
            className="drawer"
            role="dialog"
            aria-modal="true"
            aria-label={`${current.name} 详情`}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="drawer-heading">
              <div>
                <span className="eyebrow">AGENT CONFIGURATION</span>
                <h2>{current.name}</h2>
              </div>
              <button
                className="icon-button"
                aria-label="关闭详情"
                onClick={() => setDetail(undefined)}
              >
                <X size={20} />
              </button>
            </div>
            <p className="adapter-note">{current.note}</p>
            {current.id === "claude" && (
              <div className="config-block npm-installation">
                <div>
                  <h3>npm 安装</h3>
                  <Badge tone={current.npmInstallation ? "green" : "muted"}>
                    {current.npmInstallation ? "已授权 npm" : current.npmCandidate ? "已发现 · 待授权" : "未发现"}
                  </Badge>
                </div>
                {current.npmInstallation && <>
                  <p className="secondary">已授权版本 {current.npmInstallation.packageVersion} · {current.npmInstallation.kind === "native" ? "包内原生程序" : "Node.js CLI"}</p>
                  <Path value={current.npmInstallation.entry} />
                  {current.npmInstallation.node && <Path value={current.npmInstallation.node} />}
                </>}
                {current.npmCandidate ? <>
                  <p className="secondary">检测到版本 {current.npmCandidate.packageVersion} · {current.npmCandidate.kind === "native" ? "包内原生程序" : "Node.js CLI"}</p>
                  <Path value={current.npmCandidate.launcher} />
                  <button className="small" disabled={busy || current.process.running} onClick={() => void run(() => api!.approveNpm())}>
                    <ShieldCheck size={13} />授权检测到的 npm 安装
                  </button>
                </> : <p className="secondary">可在下方程序选择器中手动选择 npm 安装目录中的 claude.cmd。</p>}
                <p className="footnote">自动发现不会授予启动权限。授权时会显示实际 CLI 与 Node.js 路径。</p>
              </div>
            )}
            <div className="config-blocks">
              {(
                [
                  {
                    key: "memory",
                    name: "记忆文件",
                    value: current.memory.path,
                    approved: current.memoryApproved,
                    error: current.memory.error,
                  },
                  {
                    key: "skills",
                    name: "技能目录",
                    value: current.skills.path,
                    approved: current.skillsApproved,
                    error: current.skills.error,
                  },
                  {
                    key: "executable",
                    name: current.id === "claude" ? "Claude 程序（EXE / claude.cmd）" : "原生可执行文件",
                    value: current.executable,
                    approved: current.executableApproved,
                    error: undefined,
                  },
                  {
                    key: "workspace",
                    name: "运行工作目录",
                    value: current.workspace,
                    approved: !!current.workspace,
                    error: undefined,
                  },
                ] as const
              ).map((f) => (
                <div className="config-block" key={f.key}>
                  <div>
                    <h3>{f.name}</h3>
                    <Badge tone={f.approved ? "green" : "muted"}>
                      {f.approved ? "已授权" : "未授权"}
                    </Badge>
                  </div>
                  <Path value={f.value} />
                  {f.error && <p className="error-text">{f.error}</p>}
                  {f.key === "skills" && <>
                    <p className="secondary">{current.skills.count} 个 SKILL.md · {current.skills.files} 个文本候选</p>
                    <SkillLinks info={current.skills} />
                  </>}
                  <div className="inline-actions">
                    <button
                      className="small"
                      disabled={busy}
                      onClick={() =>
                        void run(() => api!.pick(current.id, f.key))
                      }
                    >
                      <Folder size={13} />
                      选择并授权
                    </button>
                    {f.key === "skills" && current.skills.linked && <button className="small" disabled={busy} onClick={() => void run(() => api!.approveSkillLinks(current.id))}>
                      <ShieldCheck size={13} />授权技能链接
                    </button>}
                    {f.approved && (
                      <button
                        className="ghost small"
                        disabled={busy}
                        onClick={() =>
                          void run(() =>
                            api!.clear(current.id, f.key as PathKind),
                          )
                        }
                      >
                        撤销授权
                      </button>
                    )}
                  </div>
                  {f.key === "skills" && current.skills.linked && <p className="footnote">首次使用链接同步，或链接指向变化后，请授权技能链接并确认实际位置。</p>}
                </div>
              ))}
            </div>
            <div className="drawer-section">
              <div className="section-title">
                <span>
                  <Database size={16} />
                  快照
                </span>
              </div>
              <button
                disabled={
                  busy || (!current.memoryApproved && !current.skillsApproved)
                }
                onClick={() => void run(() => api!.backup(current.id))}
              >
                <ArrowDownToLine size={14} />
                备份当前记忆与技能
              </button>
            </div>
            <div className="drawer-section">
              <div className="section-title">
                <span>
                  <Terminal size={16} />
                  本地进程
                </span>
                <Badge tone={current.process.running ? "green" : "muted"}>
                  {current.process.running
                    ? `运行中 · ${current.process.pid}`
                    : "无所属运行进程"}
                </Badge>
              </div>
              {current.mode === "cli" && (
                <>
                  <label className="field-label" htmlFor="task">
                    单次任务（使用现有 Claude 登录与权限）
                  </label>
                  <textarea
                    id="task"
                    placeholder="例如：概述当前工作目录中的项目结构"
                    value={prompt}
                    maxLength={16000}
                    onChange={(e) => setPrompt(e.target.value)}
                  />
                </>
              )}
              <div className="inline-actions">
                <button
                  className="primary"
                  disabled={
                    busy ||
                    current.process.running ||
                    !current.executableApproved ||
                    !current.workspace ||
                    (current.mode === "cli" && !prompt.trim())
                  }
                  onClick={() =>
                    void run(() =>
                      api!.launch(
                        current.id,
                        current.mode === "cli" ? prompt : undefined,
                      ),
                    )
                  }
                >
                  <Play size={14} />
                  {current.mode === "cli" ? "运行任务" : "启动程序"}
                </button>
                <button
                  disabled={busy || !current.process.running}
                  onClick={() => void run(() => api!.stop(current.id))}
                >
                  <Pause size={14} />
                  停止所属进程
                </button>
              </div>
              <p className="footnote">
                需先授权程序
                和工作目录。只追踪直接子进程；外部程序和独立子进程状态未知。
              </p>
              {current.process.exitCode !== undefined && (
                <p className="secondary">
                  最近进程退出码：{current.process.exitCode ?? "被信号终止"}
                </p>
              )}
              {current.process.error && (
                <p className="error-text">{current.process.error}</p>
              )}
              {current.mode === "cli" && (
                <pre className="terminal-output">
                  {current.process.output ||
                    "任务输出将在这里显示。内容仅保留在内存中，最多显示最近 32,000 字符。"}
                </pre>
              )}
            </div>
          </section>
        </div>
      )}
      {plan && (
        <div
          className="overlay plan-overlay"
          onClick={() => !busy && setPlan(undefined)}
        >
          <section
            className="plan-modal"
            role="dialog"
            aria-modal="true"
            aria-label="备份恢复预览"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="drawer-heading">
              <div>
                <span className="eyebrow">REVIEW BEFORE WRITE</span>
                <h2>备份恢复预览</h2>
              </div>
              <button
                className="icon-button"
                disabled={busy}
                aria-label="关闭预览"
                onClick={() => setPlan(undefined)}
              >
                <X size={20} />
              </button>
            </div>
            <div className="plan-summary">
              <Badge tone={plan.items.length ? "amber" : "green"}>
                {plan.items.length
                  ? `${plan.items.length} 个待写入文件`
                  : "无需变更"}
              </Badge>
              <span>
                <Clock3 size={13} />
                预览有效至 {time(plan.expiresAt)}
              </span>
              <span>写入前自动备份 · 不删除文件</span>
            </div>
            {plan.skipped.length > 0 && (
              <div className="plan-skips">
                {plan.skipped.map((s, i) => (
                  <p key={i}>{s}</p>
                ))}
              </div>
            )}
            {plan.items.length > 0 ? (
              <>
                <div className="plan-files">
                  {plan.items.map((item, i) => (
                    <button
                      key={item.target}
                      className={i === planIndex ? "selected" : ""}
                      onClick={() => setPlanIndex(i)}
                    >
                      <span>
                        {item.before ? "替换" : "新增"} ·{" "}
                        {data?.agents.find((a) => a.id === item.agent)?.name}
                      </span>
                      <code>{item.target}</code>
                      <span>{item.bytes.toLocaleString()} B</span>
                    </button>
                  ))}
                </div>
                {plan.items[planIndex] && (
                  <>
                    <div className="diff-paths">
                      <span>
                        实际来源 <code>{plan.items[planIndex].source}</code>
                      </span>
                      <span>
                        实际目标 <code>{plan.items[planIndex].target}</code>
                      </span>
                      {plan.items[planIndex].sourceLogical && plan.items[planIndex].sourceLogical !== plan.items[planIndex].source && <span>来源中的路径 <code>{plan.items[planIndex].sourceLogical}</code></span>}
                      {plan.items[planIndex].targetLogical && plan.items[planIndex].targetLogical !== plan.items[planIndex].target && <span>Agent 中的路径 <code>{plan.items[planIndex].targetLogical}</code></span>}
                    </div>
                    <div className="diff">
                      <div>
                        <h4>
                          当前内容{" "}
                          <span>
                            {plan.items[planIndex].before?.slice(0, 12) ||
                              "文件尚不存在"}
                          </span>
                        </h4>
                        <pre>{plan.items[planIndex].oldText || "（空）"}</pre>
                      </div>
                      <div>
                        <h4>
                          写入后{" "}
                          <span>
                            {plan.items[planIndex].after.slice(0, 12)}
                          </span>
                        </h4>
                        <pre>{plan.items[planIndex].newText || "（空）"}</pre>
                      </div>
                    </div>
                  </>
                )}
              </>
            ) : (
              <Empty>
                当前文件与备份内容一致，或没有可恢复的已授权目标。
              </Empty>
            )}
            <div className="plan-footer">
              <span>
                <ShieldCheck size={15} />
                执行前会再次检查源文件和目标指纹
              </span>
              <button disabled={busy} onClick={() => setPlan(undefined)}>
                取消
              </button>
              <button
                className="primary"
                disabled={!plan.items.length || busy}
                onClick={() =>
                  void run(async () => {
                    const result = await api!.apply(plan.id);
                    setPlan(undefined);
                    return result;
                  })
                }
              >
                {busy ? (
                  <LoaderCircle size={15} className="spin" />
                ) : (
                  <Check size={15} />
                )}
                确认并执行
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

