import { useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  ArrowUpRight,
  Check,
  ChevronRight,
  Clock3,
  Eye,
  FolderOpen,
  Gift,
  History,
  LoaderCircle,
  MousePointer2,
  Play,
  RefreshCw,
  Settings2,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react";
import type { Result } from "./shared";
import type {
  RewardId,
  RewardObservation,
  RewardState,
  RewardsSnapshot,
  RewardView,
} from "./rewards-types";
import type { BalancesSnapshot } from "./rewards-balance-types";
import RewardBalancePanel, { BalanceSummary } from "./RewardBalancePanel";
import "./rewards.css";

const api = window.consoleApi;
const defaultSuccessTexts = [
  "今日已签到",
  "今日已领取",
  "今日已领",
  "签到成功",
  "领取成功",
  "Already claimed",
  "Claim successful",
].join("\n");
const kinds: Record<RewardView["kind"], { title: string; note: string }> = {
  ui: { title: "客户端领取", note: "校准并试领成功后，可开启自动执行。" },
  automatic: { title: "平台自动发放", note: "权益由平台发放，无需控制台点击领取。" },
  manual: { title: "需人工确认", note: "当前仅提供官方规则入口，尚未支持自动领取。" },
  unknown: { title: "奖励未确认", note: "尚无足够证据确认可领取奖励，不执行领取。" },
};
const states: Record<RewardState, { title: string; tone: string }> = {
  idle: { title: "尚未检查", tone: "muted" },
  needs_setup: { title: "待校准", tone: "amber" },
  ready: { title: "流程就绪", tone: "green" },
  claimed: { title: "已领取", tone: "green" },
  already_claimed: { title: "平台显示已领", tone: "green" },
  needs_attention: { title: "需要处理", tone: "amber" },
  unknown: { title: "结果未确认", tone: "amber" },
  unsupported: { title: "未支持自动领取", tone: "muted" },
};
function formatTime(value?: string) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString("zh-CN", { hour12: false });
}
function errorText(error: unknown) {
  return String(error).replace(
    /^Error: Error invoking remote method '[^']+': Error: /,
    "",
  );
}
function StateBadge({ state }: { state: RewardState }) {
  const value = states[state];
  return <span className={`badge ${value.tone}`}><i />{value.title}</span>;
}

export default function RewardsPanel() {
  const [snapshot, setSnapshot] = useState<RewardsSnapshot>();
  const [balances, setBalances] = useState<BalancesSnapshot>();
  const [balanceUnavailable, setBalanceUnavailable] = useState(false);
  const [selectedId, setSelectedId] = useState<RewardId>();
  const [selectedBalanceId, setSelectedBalanceId] = useState<RewardId>();
  const [loading, setLoading] = useState(false);
  const [pending, setPending] = useState<{ id: RewardId; action: string }>();
  const [notice, setNotice] = useState<{ text: string; error: boolean }>();
  const [observation, setObservation] = useState<RewardObservation>();
  const [elementIndex, setElementIndex] = useState<number>();
  const [contextIndices, setContextIndices] = useState<number[]>([]);
  const [successTexts, setSuccessTexts] = useState(defaultSuccessTexts);
  const [resetHour, setResetHour] = useState("0");
  const [elementQuery, setElementQuery] = useState("");
  const mounted = useRef(true);
  const refreshing = useRef<Promise<void> | undefined>(undefined);
  const operationRunning = useRef(false);
  const initializedId = useRef<RewardId | undefined>(undefined);
  const setupPanel = useRef<HTMLElement>(null);

  async function refresh(afterMutation = false) {
    if (!api) return;
    if (refreshing.current) {
      await refreshing.current;
      if (!afterMutation) return;
    }
    const operation = (async () => {
      if (mounted.current) setLoading(true);
      try {
        const [rewardsResult, balanceResult] = await Promise.allSettled([api.rewardsSnapshot(), api.rewardBalancesSnapshot()]);
        if (mounted.current) {
          if (rewardsResult.status === "fulfilled") setSnapshot(rewardsResult.value);
          else setNotice({ text: errorText(rewardsResult.reason), error: true });
          if (balanceResult.status === "fulfilled") { setBalances(balanceResult.value); setBalanceUnavailable(false); }
          else setBalanceUnavailable(true);
        }
      } catch (error) {
        if (mounted.current) setNotice({ text: errorText(error), error: true });
      } finally {
        if (mounted.current) setLoading(false);
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
    const timer = window.setInterval(() => void refresh(), 10000);
    return () => {
      mounted.current = false;
      window.clearInterval(timer);
    };
  }, []);

  const current = snapshot?.providers.find((provider) => provider.id === selectedId);
  useEffect(() => {
    if (!current || initializedId.current === current.id) return;
    initializedId.current = current.id;
    setSuccessTexts(current.profile?.successTexts.join("\n") || defaultSuccessTexts);
    setResetHour(String(current.profile?.resetHour ?? current.resetHour));
  }, [current]);
  useEffect(() => {
    if (selectedId) setupPanel.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [selectedId]);

  function clearObservation() {
    setObservation(undefined);
    setElementIndex(undefined);
    setContextIndices([]);
    setElementQuery("");
  }
  function selectProvider(id: RewardId) {
    if (operationRunning.current) return;
    clearObservation();
    setSelectedId(id);
    setSelectedBalanceId(undefined);
    initializedId.current = undefined;
  }
  function selectBalance(id: RewardId) {
    if (operationRunning.current) return;
    clearObservation();
    setSelectedId(undefined);
    setSelectedBalanceId(id);
  }
  function acceptObservation(value: RewardObservation) {
    setObservation(value);
    setElementIndex(undefined);
    setContextIndices([]);
    setElementQuery("");
  }
  async function run(
    id: RewardId,
    action: string,
    task: () => Promise<Result | void>,
  ) {
    if (operationRunning.current || snapshot?.running || balances?.running || !api) return;
    operationRunning.current = true;
    setPending({ id, action });
    setNotice(undefined);
    try {
      const result = await task();
      if (mounted.current && result) setNotice({ text: result.message, error: false });
    } catch (error) {
      if (mounted.current) setNotice({ text: errorText(error), error: true });
    } finally {
      await refresh(true);
      operationRunning.current = false;
      if (mounted.current) setPending(undefined);
    }
  }
  function inspect(provider: RewardView) {
    clearObservation();
    void run(provider.id, "检查窗口", async () => {
      const value = await api!.rewardsInspect(provider.id);
      if (mounted.current) acceptObservation(value);
      return { message: value.message || "已读取当前窗口。请选择活动标题和免费奖励标签，避免选择账户或会话正文。" };
    });
  }
  function record(kind: "navigate" | "claim") {
    if (!current || !observation || elementIndex === undefined) return;
    const id = current.id;
    const token = observation.token;
    const index = elementIndex;
    clearObservation();
    void run(id, kind === "navigate" ? "记录并打开导航" : "记录领取按钮", async () => {
      const result = await api!.rewardsRecord(id, token, index, kind);
      if (kind === "navigate") {
        try {
          const next = await api!.rewardsInspect(id);
          if (mounted.current) acceptObservation(next);
        } catch (error) {
          throw new Error(`${result.message}；当前窗口读取失败，请重新检查窗口。${errorText(error)}`);
        }
      }
      return result;
    });
  }
  function saveChecks() {
    if (!current || !observation) return;
    const id = current.id;
    const token = observation.token;
    const indices = [...contextIndices];
    const texts = successTexts.split(/\r?\n/).map((text) => text.trim()).filter(Boolean);
    clearObservation();
    void run(id, "保存验证规则", () => api!.rewardsChecks(id, token, indices, texts, Number(resetHour)));
  }

  const unavailable = !snapshot?.nativeAvailable;
  const busy = !!pending || !!snapshot?.running || !!balances?.running;
  const balanceProvider = snapshot?.providers.find(provider => provider.id === selectedBalanceId);
  const canOperate = current?.kind === "ui" && !unavailable && !busy;
  const contextCandidates = observation?.elements.filter((element) => element.controlType === "Text" && element.name.trim()) || [];
  const actionableElements = observation?.elements.filter((element) =>
    element.actionable && element.enabled &&
    element.name.toLocaleLowerCase().includes(elementQuery.toLocaleLowerCase()),
  ) || [];
  const selectedElement = observation?.elements.find((element) => element.index === elementIndex);
  const successEntries = successTexts.split(/\r?\n/).map((text) => text.trim()).filter(Boolean);
  const validResetHour = /^\d{1,2}$/.test(resetHour) && Number(resetHour) >= 0 && Number(resetHour) <= 23;
  const checksReady = !!observation && contextIndices.length >= 1 && contextIndices.length <= 5 && successEntries.length > 0 && validResetHour;

  return <div className="rewards-page">
    <div className="page-heading rewards-heading">
      <div>
        <h2><Gift size={22} />积分福利</h2>
        <p>自动领取已验证的免费权益，持续查看各平台的真实余额。</p>
      </div>
      <button disabled={loading} onClick={() => void refresh()}>
        <RefreshCw size={14} className={loading ? "spin" : ""} />刷新状态
      </button>
    </div>

    {notice && <div className={`rewards-notice ${notice.error ? "is-error" : ""}`} role={notice.error ? "alert" : "status"}>
      {notice.error ? <AlertCircle size={17} /> : <Check size={17} />}
      <span>{notice.text}</span>
      <button className="icon-button" aria-label="关闭福利提示" onClick={() => setNotice(undefined)}><X size={15} /></button>
    </div>}

    <section className="rewards-boundary">
      <ShieldCheck size={24} />
      <div>
        <strong>只有平台明确显示成功，才记为已领取</strong>
        <p>打开客户端或登录页面不等于领取成功。校准时必须包含活动标题与免费奖励上下文，不录入账户、验证码或会话正文；不录制购买、邀请或消耗额度的操作。</p>
        <p>开启自动领取后，控制台按日检查，并在领取成功后读取已配置的余额。余额变化可能包含消耗或过期，不能单独证明奖励到账。</p>
        <p>请保持本控制台及目标客户端打开、窗口可见、Windows 解锁；界面变化、验证码或登录失效时，需要人工处理后重新校准。</p>
      </div>
    </section>

    {!snapshot ? <div className="panel rewards-loading">
      {loading ? <LoaderCircle size={24} className="spin" /> : <AlertCircle size={24} />}
      <p>{loading ? "正在读取福利配置与记录…" : "福利状态暂不可用，请刷新重试。"}</p>
    </div> : <>
      {!snapshot.nativeAvailable && <div className="rewards-warning" role="note">
        <AlertCircle size={17} /><p>当前环境无法使用 Windows 窗口自动化。仍可查看福利说明和记录，客户端校准与领取暂不可用。</p>
      </div>}
      {snapshot.running && <div className="rewards-running" role="status">
        <LoaderCircle size={16} className="spin" />
        正在执行 {snapshot.providers.find((provider) => provider.id === snapshot.running)?.name || snapshot.running} 的已录流程，请勿切换该客户端页面。
      </div>}
      {balances?.running && <div className="rewards-running" role="status"><LoaderCircle size={16} className="spin" />正在读取 {snapshot.providers.find(provider => provider.id === balances.running)?.name || balances.running} 的余额，请勿切换该客户端页面。</div>}
      <div className="rewards-platform-grid">
        {snapshot.providers.map((provider) => <article className={`reward-card ${selectedId === provider.id || selectedBalanceId === provider.id ? "is-selected" : ""}`} key={provider.id} data-reward-id={provider.id}>
          <div className="reward-card-heading"><h3>{provider.name}</h3><StateBadge state={provider.state} /></div>
          <span className={`reward-kind kind-${provider.kind}`}>{kinds[provider.kind].title}</span>
          <p className="reward-description">{provider.description}</p>
          <p className="reward-schedule"><Clock3 size={13} />{provider.scheduleNote}</p>
          <p className="reward-kind-note">{kinds[provider.kind].note}</p>
          {provider.lastMessage && <p className="reward-result">{provider.lastMessage}</p>}
          <dl className="reward-times">
            <div><dt>上次尝试</dt><dd>{formatTime(provider.lastAttempt)}</dd></div>
            <div><dt>成功记录</dt><dd>{formatTime(provider.lastSuccess)}</dd></div>
            {provider.kind === "ui" && <div><dt>下次检查</dt><dd>{formatTime(provider.nextCheck)}</dd></div>}
          </dl>
          <BalanceSummary balance={balances?.providers.find(item => item.id === provider.id)} unavailable={balanceUnavailable} />
          <div className="reward-card-actions">
            <button className="ghost small" disabled={busy} onClick={() => void run(provider.id, "打开官方规则", () => api!.rewardsRule(provider.id))}><ArrowUpRight size={13} />官方规则</button>
            {provider.kind === "ui" && <button className="small" disabled={busy} onClick={() => selectProvider(provider.id)}><Settings2 size={13} />{provider.profile ? "管理领取流程" : "校准领取流程"}</button>}
            <button className="small" disabled={busy} onClick={() => selectBalance(provider.id)}><Settings2 size={13} />配置余额监控</button>
          </div>
          <span className="reward-source" title={provider.sourceUrl}>{provider.sourceUrl}</span>
          {provider.kind === "ui" && <div className="reward-auto-status">自动领取：{provider.profile?.enabled ? "已开启" : "未开启"} · {provider.profile?.validated ? "流程已验证" : "尚未验证"}</div>}
        </article>)}
      </div>

      {current?.kind === "ui" && <section ref={setupPanel} className="panel reward-setup" aria-label={`${current.name} 领取配置`}>
        <div className="section-title"><span><Settings2 size={18} />{current.name} · 领取流程</span><StateBadge state={current.state} /></div>
        <p className="secondary">先在官方客户端中登录并打开福利入口，再检查窗口。每次记录或保存后，旧的窗口检查会失效；请依据新的检查结果选择控件。</p>

        <div className="reward-client-row">
          <div><span className="reward-field-label">已绑定客户端</span><code className="reward-path">{current.profile?.executable || "尚未绑定 Windows 客户端 EXE"}</code></div>
          <button disabled={!canOperate} onClick={() => {
            clearObservation();
            void run(current.id, "绑定客户端", async () => {
              const result = await api!.rewardsBind(current.id);
              initializedId.current = undefined;
              return result;
            });
          }}><FolderOpen size={14} />{current.profile ? "重新绑定客户端 EXE" : "绑定客户端 EXE"}</button>
          <button disabled={!canOperate || !current.profile} onClick={() => inspect(current)}><Eye size={14} />检查窗口</button>
        </div>

        <div className="reward-recorded">
          <div className="reward-recorded-title"><History size={15} /><strong>已录流程</strong><span>{current.profile?.validated ? "试领已通过" : "等待试领验证"}</span></div>
          {current.profile?.windowTitle && <p className="secondary">窗口：{current.profile.windowTitle}</p>}
          {current.profile?.navigation.length ? <ol className="reward-flow">{current.profile.navigation.map((step, index) => <li key={index}><span>{index + 1}</span>{step.name || "已记录的导航控件"}<ChevronRight size={13} /></li>)}</ol> : <p className="reward-placeholder">未记录导航，可在福利页面直接记录领取按钮。</p>}
          <p className="reward-claim-step"><MousePointer2 size={15} />领取按钮：<strong>{current.profile?.claim?.name || "尚未记录"}</strong></p>
          <div className="reward-saved-checks"><span>页面上下文：</span>{current.profile?.context.length ? current.profile.context.map((text, index) => <span className="reward-context-tag" key={index}>{text}</span>) : <span>尚未保存</span>}</div>
          <div className="reward-saved-checks"><span>成功文本：</span>{current.profile?.successTexts.length ? current.profile.successTexts.map((text, index) => <span className="reward-context-tag" key={index}>{text}</span>) : <span>尚未保存</span>}</div>
          {current.profile && <p className="reward-saved-time">已保存的每日检查边界：北京时间 {String(current.profile.resetHour).padStart(2, "0")}:00（{current.agent === "qoder" ? "官方日切时间" : "用户设置"}）</p>}
        </div>

        {observation ? <div className="reward-calibration">
          <div className="reward-observation-heading"><Eye size={16} /><strong>当前检查：{observation.title}</strong><span>{observation.elements.length} 个可见元素</span></div>
          {observation.message && <p className="secondary">{observation.message}</p>}
          <div className="reward-calibration-columns">
            <div className="reward-controls">
              <h3>1. 记录导航或领取按钮</h3>
              <p className="secondary">选择可点击控件。导航会立即执行一次；记录领取按钮只保存选择，稍后由试领或自动领取执行。</p>
              <input className="reward-input" aria-label="筛选可点击控件" placeholder="搜索当前窗口的按钮文字…" value={elementQuery} onChange={(event) => setElementQuery(event.target.value)} />
              <div className="reward-element-list" role="radiogroup" aria-label="可点击控件">
                {actionableElements.length ? actionableElements.map((element) => <label className={`reward-element ${elementIndex === element.index ? "is-selected" : ""}`} key={element.index}>
                  <input type="radio" name="reward-claim-element" checked={elementIndex === element.index} disabled={!canOperate} onChange={() => setElementIndex(element.index)} />
                  <span>{element.name || "（无文字控件）"}</span><small>{element.controlType}</small>
                </label>) : <p className="reward-placeholder">没有匹配的可点击控件。请在客户端打开正确页面后重新检查。</p>}
              </div>
              <div className="inline-actions">
                <button disabled={!canOperate || !selectedElement?.actionable || !selectedElement.enabled} onClick={() => record("navigate")}><ChevronRight size={14} />记录并打开导航</button>
                <button disabled={!canOperate || !selectedElement?.actionable || !selectedElement.enabled} onClick={() => record("claim")}><MousePointer2 size={14} />记录领取按钮</button>
              </div>
            </div>
            <div className="reward-checks">
              <h3>2. 保存页面与成功校验</h3>
              <p className="secondary">仅勾选 1–5 个活动标题或免费奖励短标签，必须能确认是目标活动；不要选择敏感正文。没有合适标题时，请停止校准。</p>
              <div className="reward-context-counter">已选 {contextIndices.length} / 5</div>
              <div className="reward-context-list" aria-label="活动上下文">
                {contextCandidates.length ? contextCandidates.map((element) => <label className="reward-element" key={element.index}>
                  <input type="checkbox" checked={contextIndices.includes(element.index)} disabled={!canOperate || (contextIndices.length >= 5 && !contextIndices.includes(element.index))} onChange={(event) => setContextIndices((indices) => event.target.checked ? [...indices, element.index] : indices.filter((index) => index !== element.index))} />
                  <span>{element.name}</span>
                </label>) : <p className="reward-placeholder">当前窗口没有可选的文字标签，请重新检查。</p>}
              </div>
              <label className="reward-field"><span>平台成功文本 · 每行一项</span><textarea aria-label="平台成功文本" rows={7} disabled={!canOperate} value={successTexts} onChange={(event) => setSuccessTexts(event.target.value)} /><small>填写平台实际显示的明确成功文本，不使用余额、页面标题或“领取”按钮文字代替。</small></label>
              <label className="reward-reset-hour"><span>每日重置时间（北京时间）</span><input type="number" aria-label="每日重置时间（北京时间）" min={0} max={23} step={1} disabled={!canOperate || current.agent === "qoder"} value={resetHour} onChange={(event) => setResetHour(event.target.value)} /><span>点</span></label>
              {!validResetHour && <p className="error-text">请输入 0–23 的整数小时。</p>}
              <p className="reward-reset-note">{current.agent === "qoder" ? "Qoder 每日奖励按官方规则固定在北京时间 10:00 刷新。" : "这是用户设置的每日检查边界。TRAE、WorkBuddy 的官方资料未明确日切时刻，请按客户端当前活动设置。"}</p>
              <button className="primary" disabled={!canOperate || !checksReady} onClick={saveChecks}><Check size={14} />保存验证规则</button>
            </div>
          </div>
        </div> : <div className="reward-observation-empty"><Eye size={20} /><span>在客户端打开目标页面后，点击“检查窗口”开始或继续校准。</span></div>}

        <div className="reward-run-bar">
          <div className="inline-actions">
            <button className="primary" disabled={!canOperate || current.state === "unknown" || !current.profile?.claim || !current.profile.context.length || !current.profile.successTexts.length} onClick={() => {
              clearObservation();
              void run(current.id, "手动试领", () => api!.rewardsRun(current.id));
            }}><Play size={14} />手动试领</button>
            <button className="primary" disabled={!canOperate || current.state === "unknown" || !!current.profile?.enabled || !current.profile?.claim || !current.profile.context.length || !current.profile.successTexts.length} onClick={() => {
              clearObservation();
              void run(current.id, "验证并开启自动领取", () => api!.rewardsStart(current.id));
            }}><ShieldCheck size={14} />验证并开启自动领取</button>
            <button disabled={busy || !current.profile} onClick={() => {
              clearObservation();
              void run(current.id, "清空已录流程", async () => {
                const result = await api!.rewardsReset(current.id);
                initializedId.current = undefined;
                return result;
              });
            }}><Trash2 size={14} />清空已录流程</button>
          </div>
          <label className="reward-auto-toggle"><input type="checkbox" aria-label={`${current.name} 自动领取`} checked={!!current.profile?.enabled} disabled={busy || (!current.profile?.enabled && (unavailable || !current.profile?.validated))} onChange={(event) => {
            const enabled = event.target.checked;
            clearObservation();
            void run(current.id, enabled ? "开启自动领取" : "关闭自动领取", () => api!.rewardsAutomation(current.id, enabled));
          }} /><span>自动领取</span><small>{current.profile?.validated ? `每天 ${String(current.profile.resetHour).padStart(2, "0")}:00 后检查 · 北京时间` : "试领验证通过后可开启"}</small></label>
        </div>
        {pending?.id === current.id && <p className="reward-pending" role="status"><LoaderCircle size={14} className="spin" />正在{pending.action}…</p>}
      </section>}

      {balanceProvider && <RewardBalancePanel key={balanceProvider.id} provider={balanceProvider} balance={balances?.providers.find(item => item.id === balanceProvider.id)} busy={busy} nativeAvailable={!!balances?.nativeAvailable && !balanceUnavailable} pendingAction={pending?.id === balanceProvider.id ? pending.action : undefined} run={run} />}

      <section className="panel rewards-log" aria-label="积分福利活动日志">
        <div className="section-title"><span><History size={18} />福利活动日志</span><small>{snapshot.logs.length} 条记录</small></div>
        <p className="secondary">展示后端记录的实际结果；没有成功凭据的尝试不会计入已领取。</p>
        {snapshot.logs.length ? <div className="reward-log-list">{snapshot.logs.map((entry, index) => <div className="reward-log-row" key={`${entry.at}-${entry.provider}-${index}`}>
          <time>{formatTime(entry.at)}</time>
          <strong>{snapshot.providers.find((provider) => provider.id === entry.provider)?.name || entry.provider}</strong>
          <StateBadge state={entry.state} />
          <p>{entry.message}</p>
        </div>)}</div> : <div className="reward-observation-empty"><History size={20} /><span>暂无福利操作记录。不会将自动发放的权益推断为控制台领取成功。</span></div>}
      </section>
    </>}
  </div>;
}
