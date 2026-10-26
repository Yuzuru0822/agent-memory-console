import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  ArrowRight,
  Check,
  Database,
  FileText,
  FolderOpen,
  GitBranch,
  GitCommitHorizontal,
  GitCompareArrows,
  History,
  Link2,
  LoaderCircle,
  RefreshCw,
  Settings2,
  ShieldCheck,
  Trash2,
  Unplug,
  X,
} from "lucide-react";
import type { AgentId, Result } from "./shared";
import type {
  JunctionView,
  RepositoryAutomation,
  RepositoryFile,
  RepositoryPlan,
  RepositoryProgress,
  RepositoryResolution,
  RepositorySnapshot,
} from "./repository-types";
import "./repository.css";
import { bulkReviewResolution, indexRepositoryReview, recommendedReviewResolutions, reviewGroup, setReviewResolution, type ReviewBulkAction } from "./repository-review";

const api = window.consoleApi;
const stamp = (value?: string | number) =>
  value
    ? new Date(value).toLocaleString("zh-CN", { hour12: false })
    : "尚未运行";
const sameIds = (a: AgentId[], b: AgentId[]) =>
  [...a].sort().join(",") === [...b].sort().join(",");
const REVIEW_PAGE_SIZE = 100;

function ReviewPager({ label, page, total, onPage }: {
  label: string; page: number; total: number; onPage: (page: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / REVIEW_PAGE_SIZE));
  return <nav className="repo-pagination" aria-label={`${label}分页`}>
    <span>{total ? page * REVIEW_PAGE_SIZE + 1 : 0}–{Math.min((page + 1) * REVIEW_PAGE_SIZE, total)} / {total} 项</span>
    <div>
      <button className="small" aria-label={`${label}上一页`} disabled={page === 0} onClick={() => onPage(page - 1)}>上一页</button>
      <label>第 <select aria-label={`${label}跳转页`} value={page} onChange={event => onPage(Number(event.target.value))}>
        {Array.from({ length: pages }, (_, index) => <option key={index} value={index}>{index + 1}</option>)}
      </select> / {pages} 页</label>
      <button className="small" aria-label={`${label}下一页`} disabled={page >= pages - 1} onClick={() => onPage(page + 1)}>下一页</button>
    </div>
  </nav>;
}

/** This small status component owns its clock so large review lists do not rerender each second. */
export function RepositoryProgressStatus({ progress, onOpen, onDismiss }: {
  progress: RepositoryProgress; onOpen: () => void; onDismiss: () => void;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (progress.state !== "running") return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [progress.id, progress.state]);
  const elapsed = Math.max(0, Math.floor(((progress.state === "running" ? now : Date.parse(progress.updatedAt)) - Date.parse(progress.startedAt)) / 1000));
  const elapsedText = elapsed >= 60 ? `${Math.floor(elapsed / 60)} 分 ${elapsed % 60} 秒` : `${elapsed} 秒`;
  const hasTotal = progress.total !== undefined && progress.total > 0 && progress.completed !== undefined;
  return <aside className={`repo-global-progress ${progress.state}`} aria-label="仓库后台任务状态" role={progress.state === "failed" ? "alert" : "status"}>
    {progress.state === "running" ? <LoaderCircle size={20} className="spin" /> : progress.state === "failed" ? <AlertCircle size={20} /> : <Check size={20} />}
    <div className="repo-progress-body">
      <div className="repo-progress-heading"><strong>{progress.operation} · {progress.phase}</strong><span>{progress.completed !== undefined && `${progress.completed}${hasTotal ? ` / ${progress.total}` : ""} 项 · `}已用时 {elapsedText}</span></div>
      {progress.message && <p>{progress.message}</p>}
      {progress.currentFile && <p className="repo-progress-file" title={progress.currentFile}>{progress.currentFile}</p>}
      {progress.state === "running" && <p className="repo-progress-hint">正在后台执行，可以切换页面；写入过程中请保持应用运行。</p>}
      {progress.state === "running" && hasTotal && <progress aria-label="当前同步阶段进度" max={progress.total} value={Math.min(progress.completed!, progress.total!)} />}
    </div>
    <button className="small" onClick={onOpen}>查看统一仓库<ArrowRight size={13} /></button>
    {progress.state !== "running" && <button className="icon-button" aria-label="关闭仓库后台任务状态" onClick={onDismiss}><X size={15} /></button>}
  </aside>;
}

function RepoPath({ value }: { value?: string }) {
  return (
    <code className="repo-path" title={value}>
      {value || "尚未授权路径"}
    </code>
  );
}

function Warnings({ values }: { values: string[] }) {
  return values.length > 0 ? (
    <div className="repo-warnings" role="note">
      <AlertCircle size={16} />
      <div>
        {values.map((value, index) => (
          <p key={index}>{value}</p>
        ))}
      </div>
    </div>
  ) : null;
}

function FileVersion({
  title,
  value,
  unavailable = "此版本没有该文件",
}: {
  title: string;
  value?: string;
  unavailable?: string;
}) {
  return (
    <div className="repo-version">
      <h4>{title}</h4>
      <pre>{value === undefined ? unavailable : value || "（空文件）"}</pre>
    </div>
  );
}

export default function RepositoryPanel({
  onChange,
  progress,
}: {
  onChange: () => Promise<void>;
  progress?: RepositoryProgress;
}) {
  const [snapshot, setSnapshot] = useState<RepositorySnapshot>();
  const [ids, setIds] = useState<AgentId[]>([]);
  const [automation, setAutomation] = useState<RepositoryAutomation>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ text: string; error: boolean }>();
  const [plan, setPlan] = useState<RepositoryPlan>();
  const [fileKey, setFileKey] = useState<string>();
  const [resolutions, setResolutions] = useState<
    Record<string, RepositoryResolution>
  >({});
  const [reviewSearch, setReviewSearch] = useState("");
  const [reviewFilter, setReviewFilter] = useState("all");
  const [checkedFiles, setCheckedFiles] = useState<Set<string>>(new Set());
  const [batchNotice, setBatchNotice] = useState("");
  const [reviewPage, setReviewPage] = useState(0);
  const [recommendationPage, setRecommendationPage] = useState(0);
  const [junction, setJunction] = useState<JunctionView>();
  const [junctionChoices, setJunctionChoices] = useState<
    Record<string, "agent" | "repository">
  >({});
  const [junctionFile, setJunctionFile] = useState<string>();
  const refreshing = useRef<Promise<void> | undefined>(undefined);
  const lastSnapshot = useRef<RepositorySnapshot | undefined>(undefined);
  const loaded = useRef(false);
  const mounted = useRef(true);
  const backgroundRunning = useRef(false);
  backgroundRunning.current = progress?.state === "running";

  async function refresh(reset = false, afterMutation = false, fresh = true) {
    if (!api) return;
    if (refreshing.current) {
      await refreshing.current;
      if (!reset && !afterMutation) return;
    }
    const operation = (async () => {
      try {
        const next = await api.repositorySnapshot(fresh);
        if (!mounted.current) return;
        const previous = lastSnapshot.current;
        const nextIds = next.members
          .filter((member) => member.selected)
          .map((member) => member.id);
        const previousIds =
          previous?.members
            .filter((member) => member.selected)
            .map((member) => member.id) || [];
        setSnapshot(next);
        setIds((current) =>
          !loaded.current || reset || sameIds(current, previousIds)
            ? nextIds
            : current,
        );
        setAutomation((current) =>
          !loaded.current ||
          reset ||
          JSON.stringify(current) === JSON.stringify(previous?.automation)
            ? next.automation
            : current,
        );
        lastSnapshot.current = next;
        loaded.current = true;
      } catch (error) {
        if (mounted.current) setNotice({ text: String(error), error: true });
      }
    })();
    refreshing.current = operation;
    try {
      await operation;
    } finally {
      if (refreshing.current === operation) refreshing.current = undefined;
    }
  }
  useEffect(() => {
    mounted.current = true;
    void refresh();
    const timer = window.setInterval(() => {
      if (!backgroundRunning.current) void refresh(false, false, false);
    }, 10000);
    return () => {
      mounted.current = false;
      window.clearInterval(timer);
      void api?.repositoryCancelPreview().catch(() => {});
    };
  }, []);

  async function run(action: () => Promise<Result | void>, reset = false) {
    if (busy) return;
    setBusy(true);
    setNotice(undefined);
    try {
      const result = await action();
      if (result) setNotice({ text: result.message, error: false });
      if (reset) {
        setPlan(undefined);
        setJunction(undefined);
      }
      await refresh(reset, true);
      await onChange();
    } catch (error) {
      setNotice({ text: String(error), error: true });
      await refresh(false, true);
    } finally {
      setBusy(false);
    }
  }

  const savedIds =
    snapshot?.members
      .filter((member) => member.selected)
      .map((member) => member.id) || [];
  const memberDirty = !sameIds(ids, savedIds);
  const automationDirty =
    !!snapshot &&
    JSON.stringify(automation) !== JSON.stringify(snapshot.automation);
  const working = busy || !!snapshot?.running || progress?.state === "running";
  const reviewIndex = useMemo(() => indexRepositoryReview(plan?.files || []), [plan]);
  const memberNames = useMemo(() => new Map(snapshot?.members.map(member => [member.id, member.name]) || []), [snapshot?.members]);
  const visibleFiles = useMemo(() => {
    const query = reviewSearch.trim().toLowerCase();
    return (plan?.files || []).filter(file =>
      (!query || `${file.relative} ${memberNames.get(file.agent) || file.agent}`.toLowerCase().includes(query)) &&
      (reviewFilter === "all" ||
       reviewFilter === "conflicts" && file.conflict ||
       reviewFilter === "unresolved" && file.conflict && !resolutions[file.key] ||
       reviewFilter === "recommended" && !!file.recommendation));
  }, [plan, reviewSearch, reviewFilter, resolutions, memberNames]);
  const recommendations = useMemo(() => [...reviewIndex.groups.values()].flatMap(group => {
    const file = group.find(item => item.recommendation);
    const source = file?.recommendation && reviewIndex.files.get(file.recommendation.sourceKey);
    return file && source ? [{ file, source, group }] : [];
  }), [reviewIndex]);
  const currentReviewPage = Math.min(reviewPage, Math.max(0, Math.ceil(visibleFiles.length / REVIEW_PAGE_SIZE) - 1));
  const pageFiles = visibleFiles.slice(currentReviewPage * REVIEW_PAGE_SIZE, (currentReviewPage + 1) * REVIEW_PAGE_SIZE);
  const currentRecommendationPage = Math.min(recommendationPage, Math.max(0, Math.ceil(recommendations.length / REVIEW_PAGE_SIZE) - 1));
  const pageRecommendations = recommendations.slice(currentRecommendationPage * REVIEW_PAGE_SIZE, (currentRecommendationPage + 1) * REVIEW_PAGE_SIZE);
  const unresolved =
    plan?.files.filter((file) => file.conflict && !resolutions[file.key])
      .length || 0;
  const currentFile =
    pageFiles.find((file) => file.key === fileKey) || pageFiles[0];
  const junctionUnresolved =
    junction?.files.filter(
      (file) => file.conflict && !junctionChoices[file.relative],
    ).length || 0;
  const currentJunctionFile =
    junction?.files.find((file) => file.relative === junctionFile) ||
    junction?.files.find((file) => file.conflict);
  const selectedMembers =
    snapshot?.members.filter((member) => ids.includes(member.id)) || [];
  const sharedFiles =
    currentFile?.kind === "skills"
      ? reviewGroup(reviewIndex, currentFile.key)
      : [];
  const selectedSource =
    currentFile && resolutions[currentFile.key]?.sourceKey
      ? reviewIndex.files.get(resolutions[currentFile.key].sourceKey!)
      : undefined;
  async function cancelPreview() {
    await run(async () => {
      const result = await api!.repositoryCancelPreview();
      setPlan(undefined);
      setJunction(undefined);
      setResolutions({});
      setCheckedFiles(new Set());
      setBatchNotice("");
      setJunctionChoices({});
      return result;
    });
  }
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (event.key === "Escape" && (plan || junction) && !working) {
        event.preventDefault();
        void cancelPreview();
      }
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [plan?.id, junction?.id, working]);

  function chooseSharedResolution(choice: RepositoryResolution["choice"]) {
    if (!currentFile) return;
    chooseResolution(currentFile, choice);
  }
  function chooseResolution(
    file: RepositoryFile,
    choice: RepositoryResolution["choice"],
  ) {
    setResolutions((current) => setReviewResolution(reviewIndex, current, file.key, {
        choice,
        ...(choice === "manual"
          ? {
              text:
                current[file.key]?.text ??
                file.mergedText ??
                file.localText ??
                file.repositoryText ??
                "",
            }
          : {}),
      }));
  }
  function toggleChecked(key: string, checked: boolean) {
    setCheckedFiles(current => {
      const next = new Set(current);
      for (const file of reviewGroup(reviewIndex, key)) if (file.conflict) {
        if (checked) next.add(file.key); else next.delete(file.key);
      }
      return next;
    });
  }
  function selectVisible() {
    setCheckedFiles(current => {
      const next = new Set(current);
      for (const file of visibleFiles) if (file.conflict)
        for (const related of reviewGroup(reviewIndex, file.key)) if (related.conflict) next.add(related.key);
      return next;
    });
  }
  function applyBulk(action: ReviewBulkAction) {
    const result = bulkReviewResolution(reviewIndex, resolutions, checkedFiles, action);
    setResolutions(result.resolutions);
    setBatchNotice(`已处理 ${result.changedGroups} 个文件（共享引用同步更新）${result.skippedGroups ? `；跳过 ${result.skippedGroups} 个没有可用版本或推荐的文件，保留原选择` : ""}。`);
  }
  async function preview() {
    await run(async () => {
      const next = await api!.repositoryPreview();
      setPlan(next);
      setFileKey(
        next.files.find((file) => file.conflict)?.key || next.files[0]?.key,
      );
      setResolutions(recommendedReviewResolutions(indexRepositoryReview(next.files)));
      setReviewSearch("");
      setReviewFilter("all");
      setReviewPage(Math.floor(Math.max(0, next.files.findIndex(file => file.conflict)) / REVIEW_PAGE_SIZE));
      setRecommendationPage(0);
      setCheckedFiles(new Set());
      setBatchNotice("");
      setJunction(undefined);
    });
  }

  if (!snapshot)
    return (
      <div className="repo-loading">
        <LoaderCircle className="spin" size={22} />
        <span>正在读取本地 Git 仓库…</span>
        {notice && <p role="alert">{notice.text}</p>}
        <button onClick={() => void refresh()}>
          <RefreshCw size={14} />
          重试
        </button>
      </div>
    );

  return (
    <div className="repository-page">
      <div className="page-heading repo-heading">
        <div>
          <h2>统一记忆与技能仓库</h2>
          <p>
            在独立的 Windows 目录中集中保存资料，用本地 Git 记录版本；Agent
            保留自己的记忆分区，共享同一套技能。
          </p>
        </div>
        <button disabled={working} onClick={() => void refresh()}>
          <RefreshCw size={14} className={working ? "spin" : ""} />
          刷新仓库
        </button>
      </div>
      {notice && (
        <div
          role={notice.error ? "alert" : "status"}
          className={`repo-notice ${notice.error ? "error" : ""}`}
        >
          <span>
            {notice.error ? <AlertCircle size={17} /> : <Check size={17} />}
            {notice.text}
          </span>
          <button
            className="icon-button"
            aria-label="关闭仓库提示"
            onClick={() => setNotice(undefined)}
          >
            <X size={15} />
          </button>
        </div>
      )}
      {snapshot.error && <Warnings values={[snapshot.error]} />}

      <section className="panel repo-home">
        <div className="repo-home-main">
          <div className="section-title">
            <span>
              <Database size={18} />
              仓库位置
            </span>
            <span className={`badge ${snapshot.root ? "green" : "muted"}`}>
              <i />
              {snapshot.root ? "本地 Git 仓库" : "等待创建"}
            </span>
          </div>
          <p className="secondary">
            选择专用目录后初始化 Git。目录选择和写入范围会由 Windows
            确认窗口展示。
          </p>
          <RepoPath value={snapshot.root} />
          <div className="inline-actions">
            <button
              className="primary"
              disabled={working}
              onClick={() => void run(() => api!.repositoryChoose(), true)}
            >
              <FolderOpen size={14} />
              {snapshot.root ? "选择其他仓库目录" : "选择目录并初始化 Git"}
            </button>
            <button
              disabled={working || !snapshot.root}
              onClick={() => void run(() => api!.repositoryReveal())}
            >
              <ArrowRight size={14} />
              打开仓库
            </button>
          </div>
          {snapshot.git && (
            <div className="repo-git-status">
              <span>
                <GitBranch size={14} />
                {snapshot.git.branch || "未创建首个提交"}
              </span>
              <span
                className={snapshot.git.dirty ? "amber-text" : "green-text"}
              >
                {snapshot.git.dirty
                  ? `${snapshot.git.dirty} 项未提交变更`
                  : "工作区干净"}
              </span>
              <button
                className="small"
                disabled={working || !snapshot.git.dirty}
                onClick={() => void run(() => api!.repositoryCommit())}
              >
                <GitCommitHorizontal size={14} />
                提交当前变更
              </button>
            </div>
          )}
        </div>
        <div className="repo-layout">
          <span className="eyebrow">REPOSITORY LAYOUT</span>
          <pre>
            {
              "仓库目录/\n├─ memories/\n│  ├─ claude/       # Claude 记忆\n│  ├─ trae/         # TRAE 记忆\n│  └─ <agentId>/    # 其他 Agent 记忆\n├─ skills/          # 所有 Agent 共享技能\n└─ .git/            # 本地版本记录"
            }
          </pre>
          <p className="footnote">
            同步保留一端独有的内容；不会将删除传播到另一端。不会自动推送到云端。
          </p>
        </div>
      </section>

      <section className="panel">
        <div className="section-title">
          <span>
            <ShieldCheck size={17} />
            纳管 Agent <small>{ids.length} 个已选</small>
          </span>
          <button
            disabled={working || !snapshot.root || !memberDirty}
            onClick={() => void run(() => api!.repositoryMembers(ids), true)}
          >
            保存纳管选择
          </button>
        </div>
        <p className="secondary">
          选择参与双向同步的
          Agent。已有记忆文件可继续使用，也可授权整个记忆目录；目录内文件按相对路径保存。技能连接需单独预览并确认。
        </p>
        <div className="repo-members">
          {snapshot.members.map((member) => (
            <label
              className={`repo-member-option ${ids.includes(member.id) ? "selected" : ""}`}
              key={member.id}
            >
              <input
                type="checkbox"
                disabled={working || !snapshot.root}
                checked={ids.includes(member.id)}
                onChange={(event) =>
                  setIds((current) =>
                    event.target.checked
                      ? [...current, member.id]
                      : current.filter((id) => id !== member.id),
                  )
                }
              />
              <span>{member.name}</span>
              {member.linked && <Link2 size={13} />}
            </label>
          ))}
        </div>
        {memberDirty && (
          <p className="repo-draft-note">
            纳管选择尚未保存。请先保存，再预览同步或连接技能。
          </p>
        )}
        <div className="repo-agent-list">
          {selectedMembers.map((member) => (
            <article className="repo-agent" key={member.id}>
              <div className="repo-agent-heading">
                <h3>{member.name}</h3>
                {member.linked && (
                  <span className="badge green">
                    <i />
                    技能已连接仓库
                  </span>
                )}
              </div>
              <div className="repo-agent-paths">
                <div>
                  <span className="repo-field-label">本地记忆文件 / 目录</span>
                  <RepoPath value={member.memoryPath} />
                  <span className="footnote">
                    仓库分区：memories/{member.id}/
                  </span>
                  <button
                    className="small"
                    disabled={working || !snapshot.root || memberDirty}
                    onClick={() =>
                      void run(() => api!.repositoryMemoryFolder(member.id))
                    }
                  >
                    <FolderOpen size={13} />
                    选择记忆目录
                  </button>
                </div>
                <div>
                  <span className="repo-field-label">Agent 技能目录</span>
                  <RepoPath value={member.skillsPath} />
                  <div className="inline-actions">
                    <button
                      className="small"
                      disabled={
                        working ||
                        !snapshot.root ||
                        memberDirty ||
                        !member.skillsPath
                      }
                      onClick={() =>
                        void run(async () => {
                          const next = await api!.repositoryLinkPreview(
                            member.id,
                          );
                          setJunction(next);
                          setJunctionChoices({});
                          setJunctionFile(
                            next.files.find((file) => file.conflict)?.relative,
                          );
                          setPlan(undefined);
                        })
                      }
                    >
                      <Link2 size={13} />
                      预览连接技能
                    </button>
                    {member.originalBackup && (
                      <button
                        className="small ghost"
                        disabled={working || memberDirty}
                        onClick={() =>
                          void run(() => api!.repositoryUnlink(member.id))
                        }
                      >
                        <Unplug size={13} />
                        解除连接并恢复原目录
                      </button>
                    )}
                  </div>
                  {member.originalBackup && (
                    <details className="repo-backup-detail">
                      <summary>查看原目录保留位置</summary>
                      <RepoPath value={member.originalBackup} />
                    </details>
                  )}
                </div>
              </div>
            </article>
          ))}
        </div>
        {!ids.length && (
          <p className="repo-placeholder">
            选择需要纳管的 Agent 后，在这里配置记忆路径与技能连接。
          </p>
        )}
        <div className="repo-sync-action">
          <div>
            <strong>双向合并记忆与技能</strong>
            <p className="footnote">
              比较上次同步版本、Agent
              与仓库。无冲突内容可合并；冲突需要逐项选择或手动编辑。
            </p>
          </div>
          <button
            className="primary"
            disabled={working || !snapshot.root || !ids.length || memberDirty}
            onClick={() => void preview()}
          >
            <GitCompareArrows size={15} />
            预览双向同步
          </button>
        </div>
      </section>

      {plan && (
        <section className="panel repo-preview" aria-label="双向同步预览">
          <div className="section-title">
            <span>
              <GitCompareArrows size={17} />
              双向同步预览{" "}
              <small>
                {plan.files.length} 个项目 · {unresolved} 个冲突待处理
              </small>
            </span>
            <button
              className="icon-button"
              aria-label="关闭双向同步预览"
              disabled={working}
              onClick={() => void cancelPreview()}
            >
              <X size={17} />
            </button>
          </div>
          <p className="secondary">
            计划有效期至 {stamp(plan.expiresAt)}
            。应用前再次核对文件；文件已改变时，请重新预览。
          </p>
          <Warnings values={plan.warnings} />
          {recommendations.length > 0 && (
            <details className="repo-recommendations" open>
              <summary>默认采用 Agent 清单（{recommendations.length} 个文件）</summary>
              <p className="footnote">
                仓库缺失或 Agent 更新时已预选 Agent 内容，仍需点击应用后才写入。多个 Agent 提供不同版本时采用修改时间最新的一份；时间相同则按 Agent 标识和文件键的固定顺序选择。可以在下方更改选择。
              </p>
              <div className="repo-recommendation-table">
                <table>
                  <thead><tr><th>文件 / 引用方</th><th>推荐来源</th><th>原因</th><th>Agent 修改时间</th><th>仓库修改时间</th><th>当前选择</th></tr></thead>
                  <tbody>{pageRecommendations.map(({ file, source, group }) => {
                    const selected = resolutions[file.key];
                    const selectedAgent = selected?.choice === "agent" ? reviewIndex.files.get(selected.sourceKey || file.key) : undefined;
                    return <tr key={file.key}>
                      <td><button className="repo-manifest-file" onClick={() => { setReviewSearch(""); setReviewFilter("all"); setReviewPage(Math.floor(Math.max(0, plan.files.findIndex(item => item.key === file.key)) / REVIEW_PAGE_SIZE)); setFileKey(file.key); }}>{file.relative}</button><small>{group.map(item => memberNames.get(item.agent) || item.agent).join("、")}</small></td>
                      <td>{memberNames.get(source.agent) || source.agent}</td>
                      <td>{file.recommendation?.reason === "repository-missing" ? "仓库没有该文件" : "Agent 比仓库更新"}{file.recommendation?.tied && <small className="repo-time-tie">多个 Agent 时间相同，已按固定顺序选择</small>}</td>
                      <td>{source.localModifiedMs === undefined ? "未知" : stamp(source.localModifiedMs)}</td>
                      <td>{file.repositoryExists === false ? "没有该文件" : file.repositoryModifiedMs === undefined ? "未知" : stamp(file.repositoryModifiedMs)}</td>
                      <td>{selectedAgent ? `${memberNames.get(selectedAgent.agent) || selectedAgent.agent} 内容` : selected?.choice === "repository" ? "仓库内容" : selected?.choice === "manual" ? "手动合并" : "待选择"}</td>
                    </tr>;
                  })}</tbody>
                </table>
              </div>
              <ReviewPager label="推荐清单" page={currentRecommendationPage} total={recommendations.length} onPage={setRecommendationPage} />
            </details>
          )}
          {plan.files.length > 0 && (
            <div className="repo-review-tools">
              <div className="repo-review-filters">
                <input aria-label="搜索同步文件" placeholder="搜索文件或 Agent…" value={reviewSearch} onChange={event => { setReviewSearch(event.target.value); setReviewPage(0); }} />
                <select aria-label="筛选同步文件" value={reviewFilter} onChange={event => { setReviewFilter(event.target.value); setReviewPage(0); }}>
                  <option value="all">全部项目</option>
                  <option value="conflicts">全部冲突</option>
                  <option value="unresolved">待处理冲突</option>
                  <option value="recommended">有推荐的冲突</option>
                </select>
                <span className="footnote">显示 {visibleFiles.length} / {plan.files.length} 项 · 已勾选 {checkedFiles.size} 项</span>
                <button disabled={working} onClick={() => void run(() => api!.repositoryExportPreview(plan.id, resolutions))}>导出处理清单</button>
              </div>
              <div className="repo-review-bulk" role="group" aria-label="批量处理同步冲突">
                <button className="small" disabled={working || !visibleFiles.some(file => file.conflict)} onClick={selectVisible}>勾选当前筛选冲突</button>
                <button className="small" disabled={working || !checkedFiles.size} onClick={() => setCheckedFiles(new Set())}>取消全部勾选</button>
                <span className="repo-bulk-divider" />
                <button className="small" disabled={working || !checkedFiles.size} onClick={() => applyBulk("agent")}>采用最新 Agent</button>
                <button className="small" disabled={working || !checkedFiles.size} onClick={() => applyBulk("repository")}>采用仓库</button>
                <button className="small" disabled={working || !checkedFiles.size} onClick={() => applyBulk("recommended")}>恢复推荐</button>
                <button className="small" disabled={working || !checkedFiles.size} onClick={() => applyBulk("clear")}>清除处理选择</button>
              </div>
              <p className="footnote">“勾选当前筛选冲突”覆盖所有匹配项，包含其他页；同一技能的所有引用方一起更新。仓库版本不存在时跳过，普通合并结果保持不变。</p>
              {batchNotice && <p className="repo-batch-notice" role="status">{batchNotice}</p>}
            </div>
          )}
          {plan.files.length ? (
            <div className="repo-review-grid">
              <div className="repo-file-browser">
                <ReviewPager label="同步文件" page={currentReviewPage} total={visibleFiles.length} onPage={next => { setReviewPage(next); setFileKey(visibleFiles[next * REVIEW_PAGE_SIZE]?.key); }} />
              <div className="repo-file-list">
                {pageFiles.map((file) => (
                  <div className="repo-review-file-row" key={file.key}>
                  {file.conflict && <input type="checkbox" aria-label={`勾选 ${file.agent} ${file.relative}`} checked={checkedFiles.has(file.key)} disabled={working} onChange={event => toggleChecked(file.key, event.target.checked)} />}
                  <button
                    className={currentFile?.key === file.key ? "active" : ""}
                    onClick={() => setFileKey(file.key)}
                  >
                    <FileText size={14} />
                    <span>
                      <strong>{file.relative}</strong>
                      <small>
                        {memberNames.get(file.agent)}{" "}
                        · {file.kind === "memory" ? "记忆" : "技能"}
                      </small>
                    </span>
                    <i
                      className={
                        file.conflict && !resolutions[file.key]
                          ? "conflict"
                          : "resolved"
                      }
                    >
                      {file.conflict
                        ? resolutions[file.key]
                          ? "已选"
                          : "冲突"
                        : "合并"}
                    </i>
                  </button>
                  </div>
                ))}
                {!visibleFiles.length && <p className="repo-placeholder">当前筛选没有匹配项。</p>}
              </div>
              </div>
              {currentFile && (
                <div className="repo-file-review">
                  <div className="repo-file-description">
                    <strong>{currentFile.relative}</strong>
                    <p>{currentFile.description}</p>
                  </div>
                  <div className="repo-path-pair">
                    <div>
                      <span>Agent 路径</span>
                      <RepoPath value={currentFile.agentPath} />
                    </div>
                    <div>
                      <span>仓库路径</span>
                      <RepoPath value={currentFile.repositoryPath} />
                    </div>
                  </div>
                  {currentFile.previewTruncated && (
                    <p className="repo-draft-note">
                      此批次内容较大，文本预览已受限；请在实际路径核对文件后选择
                      Agent 或仓库版本，不能使用手动合并。
                    </p>
                  )}
                  {currentFile.binary ? (
                    <p className="repo-draft-note">
                      该文件为二进制文件，无法显示文本差异；冲突时请选择保留哪一端。
                    </p>
                  ) : (
                    <>
                      <details className="repo-base-version">
                        <summary>查看上次同步的共同版本</summary>
                        <FileVersion
                          title="共同版本"
                          value={currentFile.baseText}
                          unavailable={
                            currentFile.previewTruncated
                              ? "文本预览受限，请核对实际文件"
                              : "尚无共同版本"
                          }
                        />
                      </details>
                      <div className="repo-two-versions">
                        <FileVersion
                          title="Agent 当前内容"
                          value={currentFile.localText}
                          unavailable={
                            currentFile.previewTruncated
                              ? "文本预览受限，请核对实际文件"
                              : undefined
                          }
                        />
                        <FileVersion
                          title="仓库当前内容"
                          value={currentFile.repositoryText}
                          unavailable={
                            currentFile.previewTruncated
                              ? "文本预览受限，请核对实际文件"
                              : undefined
                          }
                        />
                      </div>
                    </>
                  )}
                  {currentFile.conflict ? (
                    <div className="repo-conflict-resolution">
                      <h4>解决此项冲突</h4>
                      <div className="repo-choice-row">
                        {(
                          [
                            { choice: "agent", label: "采用 Agent 内容" },
                            { choice: "repository", label: "采用仓库内容" },
                            ...(!currentFile.binary &&
                            !currentFile.previewTruncated
                              ? [{ choice: "manual", label: "手动合并" }]
                              : []),
                          ] as {
                            choice: RepositoryResolution["choice"];
                            label: string;
                          }[]
                        ).map((option) => (
                          <label key={option.choice}>
                            <input
                              type="radio"
                              name={`resolution-${currentFile.key}`}
                              checked={
                                resolutions[currentFile.key]?.choice ===
                                  option.choice &&
                                (option.choice !== "agent" ||
                                  (resolutions[currentFile.key]?.sourceKey || currentFile.key) === currentFile.key)
                              }
                              disabled={
                                working ||
                                (option.choice === "agent" &&
                                  currentFile.localExists === false) ||
                                (option.choice === "repository" &&
                                  currentFile.repositoryExists === false) ||
                                (option.choice === "manual" && reviewGroup(reviewIndex, currentFile.key).some(file => file.binary || file.previewTruncated))
                              }
                              onChange={() =>
                                chooseResolution(currentFile, option.choice)
                              }
                            />
                            {option.label}
                          </label>
                        ))}
                      </div>
                      {selectedSource &&
                        selectedSource.key !== currentFile.key && (
                          <p className="repo-draft-note">
                            当前采用{" "}
                            {
                              snapshot.members.find(
                                (member) => member.id === selectedSource.agent,
                              )?.name
                            }{" "}
                            的 Agent 版本作为共享结果。
                          </p>
                        )}
                      {resolutions[currentFile.key]?.choice === "manual" && (
                        <textarea
                          aria-label={`手动合并 ${currentFile.relative}`}
                          spellCheck={false}
                          value={resolutions[currentFile.key].text || ""}
                          disabled={working}
                          onChange={(event) =>
                            setResolutions((current) => setReviewResolution(reviewIndex, current, currentFile.key, {
                                choice: "manual",
                                text: event.target.value,
                              }))
                          }
                        />
                      )}
                      {sharedFiles.length > 1 && (
                        <div className="repo-shared-resolution">
                          <p className="footnote">
                            此技能由 {sharedFiles.length} 个 Agent
                            引用，最终需要选择一致的共享内容。
                          </p>
                          <div className="inline-actions">
                            <button
                              className="small"
                              disabled={
                                working || currentFile.localExists === false
                              }
                              onClick={() => chooseSharedResolution("agent")}
                            >
                              此 Agent 版本用于所有引用方
                            </button>
                            <button
                              className="small"
                              disabled={
                                working ||
                                currentFile.repositoryExists === false
                              }
                              onClick={() =>
                                chooseSharedResolution("repository")
                              }
                            >
                              仓库版本用于所有引用方
                            </button>
                            {resolutions[currentFile.key]?.choice ===
                              "manual" &&
                              sharedFiles.every(
                                (file) =>
                                  !file.binary && !file.previewTruncated,
                              ) && (
                                <button
                                  className="small"
                                  disabled={working}
                                  onClick={() =>
                                    chooseSharedResolution("manual")
                                  }
                                >
                                  手动合并结果用于所有引用方
                                </button>
                              )}
                          </div>
                        </div>
                      )}
                    </div>
                  ) : (
                    !currentFile.binary && (
                      <FileVersion
                        title="合并后内容"
                        value={currentFile.mergedText}
                        unavailable={
                          currentFile.previewTruncated
                            ? "文本预览受限，请核对实际文件"
                            : undefined
                        }
                      />
                    )
                  )}
                </div>
              )}
            </div>
          ) : (
            <p className="repo-placeholder">没有需要同步的文件变更。</p>
          )}
          <div className="repo-preview-footer">
            <span className="footnote">
              不会传播删除。替换前保留备份；冲突未全部解决时不能应用。
            </span>
            <button
              className="primary"
              disabled={
                working || !plan.files.length || unresolved > 0 || memberDirty
              }
              onClick={() =>
                void run(async () => {
                  const result = await api!.repositoryApply(
                    plan.id,
                    resolutions,
                  );
                  setPlan(undefined);
                  return result;
                })
              }
            >
              <Check size={15} />
              确认应用双向同步
              {unresolved > 0 ? `（待处理 ${unresolved} 项）` : ""}
            </button>
          </div>
        </section>
      )}

      {junction && (
        <section className="panel repo-preview" aria-label="技能连接预览">
          <div className="section-title">
            <span>
              <Link2 size={17} />
              技能连接预览 ·{" "}
              {
                snapshot.members.find((member) => member.id === junction.agent)
                  ?.name
              }
            </span>
            <button
              className="icon-button"
              aria-label="关闭技能连接预览"
              disabled={working}
              onClick={() => void cancelPreview()}
            >
              <X size={17} />
            </button>
          </div>
          <p className="secondary">
            先将技能汇入仓库，再将 Agent 技能目录连接到仓库
            skills。连接后，两处访问的是同一份文件，Agent
            的修改或删除会直接作用于仓库及所有已连接
            Agent；双向复制的不传播删除规则不能阻止直接删除共享文件。原目录会完整保留，供解除连接时恢复。
          </p>
          <div className="repo-junction-paths">
            <div>
              <span>Agent 技能入口</span>
              <RepoPath value={junction.source} />
            </div>
            <ArrowRight size={18} />
            <div>
              <span>Junction 实际目标</span>
              <RepoPath value={junction.target} />
            </div>
            <div>
              <span>原目录保留位置</span>
              <RepoPath value={junction.backupPath} />
            </div>
          </div>
          <Warnings values={junction.warnings} />
          {junction.alreadyLinked ? (
            <p className="repo-success">
              <Check size={16} />此 Agent 已连接当前仓库，无需重复操作。
            </p>
          ) : (
            <>
              <div className="repo-import-summary">
                <span>{junction.files.length} 个导入候选文件</span>
                <span>
                  {junction.files.filter((file) => file.conflict).length}{" "}
                  个同名内容冲突
                </span>
                <span>{junctionUnresolved} 项待选择</span>
              </div>
              {junction.files.length > 0 && (
                <div className="repo-link-imports">
                  {junction.files.map((file) => (
                    <div
                      className={`repo-import-row ${file.conflict ? "has-conflict" : ""}`}
                      key={file.relative}
                    >
                      <button
                        className="ghost repo-import-name"
                        onClick={() => setJunctionFile(file.relative)}
                      >
                        <FileText size={13} />
                        {file.relative}
                      </button>
                      <span className="footnote">
                        {file.bytes.toLocaleString()} B
                      </span>
                      {file.conflict ? (
                        <div className="repo-choice-row">
                          <label>
                            <input
                              type="radio"
                              name={`link-${file.relative}`}
                              checked={
                                junctionChoices[file.relative] === "agent"
                              }
                              disabled={working}
                              onChange={() =>
                                setJunctionChoices((current) => ({
                                  ...current,
                                  [file.relative]: "agent",
                                }))
                              }
                            />
                            采用 Agent
                          </label>
                          <label>
                            <input
                              type="radio"
                              name={`link-${file.relative}`}
                              checked={
                                junctionChoices[file.relative] === "repository"
                              }
                              disabled={working}
                              onChange={() =>
                                setJunctionChoices((current) => ({
                                  ...current,
                                  [file.relative]: "repository",
                                }))
                              }
                            />
                            采用仓库
                          </label>
                        </div>
                      ) : (
                        <span className="green-text">可导入</span>
                      )}
                    </div>
                  ))}
                </div>
              )}
              {currentJunctionFile && (
                <div className="repo-junction-diff">
                  <h4>{currentJunctionFile.relative}</h4>
                  <div className="repo-two-versions">
                    <FileVersion
                      title="Agent 文件内容"
                      value={currentJunctionFile.localText}
                      unavailable="无文本预览：文件可能不存在、为二进制或超出预览范围。请按实际路径核对。"
                    />
                    <FileVersion
                      title="仓库文件内容"
                      value={currentJunctionFile.repositoryText}
                      unavailable="无文本预览：文件可能不存在、为二进制或超出预览范围。请按实际路径核对。"
                    />
                  </div>
                </div>
              )}
              <div className="repo-preview-footer">
                <span className="footnote">
                  有缺失、循环链接等项目时会单独提示。请核对保留位置与导入范围。
                </span>
                <button
                  className="primary"
                  disabled={working || junctionUnresolved > 0 || memberDirty}
                  onClick={() =>
                    void run(async () => {
                      const result = await api!.repositoryLinkApply(
                        junction.id,
                        junctionChoices,
                      );
                      setJunction(undefined);
                      return result;
                    })
                  }
                >
                  <Link2 size={15} />
                  确认导入并连接技能
                </button>
              </div>
            </>
          )}
        </section>
      )}

      <div className="repo-bottom-grid">
        <section className="panel">
          <div className="section-title">
            <span>
              <Settings2 size={17} />
              自动同步与清理
            </span>
            <span
              className={`badge ${snapshot.automation.enabled ? "green" : "muted"}`}
            >
              <i />
              {snapshot.running
                ? "正在运行"
                : snapshot.automation.enabled
                  ? "自动同步已启用"
                  : "手动模式"}
            </span>
          </div>
          {automation && (
            <>
              <label className="repo-toggle">
                <input
                  type="checkbox"
                  checked={automation.enabled}
                  disabled={working || !snapshot.root}
                  onChange={(event) =>
                    setAutomation(
                      (current) =>
                        current && {
                          ...current,
                          enabled: event.target.checked,
                        },
                    )
                  }
                />
                <span>
                  <strong>启用自动双向同步</strong>
                  <small>
                    应用运行期间定时检查，遇到冲突保留两端内容，等待手动处理。
                  </small>
                </span>
              </label>
              <label className="repo-number-label">
                检查间隔（秒）
                <input
                  type="number"
                  min={30}
                  max={3600}
                  step={1}
                  aria-label="自动同步间隔秒"
                  value={automation.intervalSeconds}
                  disabled={working || !snapshot.root}
                  onChange={(event) =>
                    setAutomation(
                      (current) =>
                        current && {
                          ...current,
                          intervalSeconds: Number(event.target.value),
                        },
                    )
                  }
                />
              </label>
              <label className="repo-toggle">
                <input
                  type="checkbox"
                  checked={automation.cleanupEnabled}
                  disabled={working || !snapshot.root}
                  onChange={(event) =>
                    setAutomation(
                      (current) =>
                        current && {
                          ...current,
                          cleanupEnabled: event.target.checked,
                        },
                    )
                  }
                />
                <span>
                  <strong>自动清理过期备份与临时文件</strong>
                  <small>
                    不清理记忆、技能、Git 历史，也不删除技能连接所保留的原目录。
                  </small>
                </span>
              </label>
              <div className="repo-retention">
                <label className="repo-number-label">
                  保留天数
                  <input
                    type="number"
                    min={1}
                    max={3650}
                    aria-label="备份保留天数"
                    value={automation.retentionDays}
                    disabled={working || !snapshot.root}
                    onChange={(event) =>
                      setAutomation(
                        (current) =>
                          current && {
                            ...current,
                            retentionDays: Number(event.target.value),
                          },
                      )
                    }
                  />
                </label>
                <label className="repo-number-label">
                  至少保留份数
                  <input
                    type="number"
                    min={1}
                    max={1000}
                    aria-label="备份最少保留份数"
                    value={automation.minBackups}
                    disabled={working || !snapshot.root}
                    onChange={(event) =>
                      setAutomation(
                        (current) =>
                          current && {
                            ...current,
                            minBackups: Number(event.target.value),
                          },
                      )
                    }
                  />
                </label>
              </div>
              <div className="inline-actions">
                <button
                  disabled={
                    working ||
                    !snapshot.root ||
                    !automationDirty ||
                    memberDirty ||
                    !Number.isInteger(automation.intervalSeconds) ||
                    automation.intervalSeconds < 30 ||
                    automation.intervalSeconds > 3600 ||
                    !Number.isInteger(automation.retentionDays) ||
                    automation.retentionDays < 1 ||
                    automation.retentionDays > 3650 ||
                    !Number.isInteger(automation.minBackups) ||
                    automation.minBackups < 1 ||
                    automation.minBackups > 1000
                  }
                  onClick={() =>
                    void run(() => api!.repositoryAutomation(automation), true)
                  }
                >
                  <ShieldCheck size={14} />
                  保存自动化设置
                </button>
                <button
                  className="ghost"
                  disabled={working || !snapshot.root}
                  onClick={() => void run(() => api!.repositoryCleanup())}
                >
                  <Trash2 size={14} />
                  按已保存规则清理
                </button>
              </div>
            </>
          )}
          <div className="repo-run-status">
            <span>最近检查：{stamp(snapshot.lastRun)}</span>
            <p>{snapshot.lastMessage || "尚无自动同步记录。"}</p>
            <span>
              {snapshot.backupCount} 份仓库备份 · 退出应用后自动同步停止
            </span>
          </div>
        </section>
        <section className="panel">
          <div className="section-title">
            <span>
              <History size={17} />
              Git 版本记录
            </span>
            <span className="eyebrow">LOCAL HISTORY</span>
          </div>
          <p className="secondary">
            同步前后自动保存 Git
            版本。直接编辑仓库产生的改动也可点击「提交当前变更」保存。
          </p>
          {snapshot.history.length ? (
            <div className="repo-history">
              {snapshot.history.map((entry) => (
                <div key={entry.oid}>
                  <GitCommitHorizontal size={16} />
                  <div>
                    <strong>{entry.message}</strong>
                    <p>
                      <code>{entry.oid.slice(0, 10)}</code>
                      <time>{stamp(entry.timestamp)}</time>
                    </p>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="repo-placeholder">
              仓库尚无提交记录。同步内容后，可点击「提交当前变更」保存版本。
            </p>
          )}
        </section>
      </div>
    </div>
  );
}
