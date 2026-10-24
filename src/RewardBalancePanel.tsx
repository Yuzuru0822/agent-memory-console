import { useEffect, useRef, useState } from "react";
import { AlertCircle, Check, ChevronRight, Clock3, Eye, FolderOpen, History, LoaderCircle, RefreshCw, Settings2, Trash2, Wallet } from "lucide-react";
import type { Result } from "./shared";
import type { RewardId, RewardObservation, RewardView } from "./rewards-types";
import type { BalanceReason, BalanceUnit, BalanceView } from "./rewards-balance-types";

const api = window.consoleApi;
const units: BalanceUnit[] = ["积分", "Credits", "CNY", "USD"];
// Hide visibly unsafe choices; the main process independently validates every step.
const blockedNavigation = /领取|签到|购买|充值|支付|订阅|续费|升级|重置|兑换|删除|移除|邀请|分享|登录|登陆|注册|授权|注销|退出|安全|隐私|权限|密码|验证码|发送|发布|claim|check[ _-]?in|purchase|recharge|payment|checkout|subscribe|upgrade|reset|redeem|delete|remove|invite|share|log[ _-]?in|sign[ _-]?in|sign[ _-]?up|authorize|logout|security|privacy|permission|password|verification|send|publish/i;
const allowedNavigationName = (name: string) => name === "订阅和用量" || !blockedNavigation.test(name);
const reasons: Record<BalanceReason, string> = { manual: "手动读取", scheduled: "定时读取", before_claim: "领取前读取", after_claim: "领取后读取" };
function time(value?: string) {
  if (!value) return "—";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString("zh-CN", { hour12: false });
}
function number(value: number) { return value.toLocaleString("zh-CN", { maximumFractionDigits: 12 }); }
function delta(value?: number) { return value === undefined ? "—" : `${value > 0 ? "+" : ""}${number(value)}`; }

export function BalanceSummary({ balance, unavailable = false }: { balance?: BalanceView; unavailable?: boolean }) {
  const sample = balance?.sample;
  return <div className={`reward-balance-summary ${balance?.low ? "is-low" : ""}`} data-balance-id={balance?.id}>
    <div className="reward-balance-heading"><span><Wallet size={14} />最近余额</span>
      {unavailable ? <span className="badge amber"><i />状态暂不可用</span>
        : balance?.status === "error" ? <span className="badge amber"><i />读取失败</span>
        : balance?.stale && sample ? <span className="badge amber"><i />数据已过期</span>
        : sample ? <span className="badge green"><i />已读取</span> : <span className="badge muted"><i />尚未读取</span>}
    </div>
    <div className="reward-balance-value">{sample ? <><strong>{number(sample.value)}</strong><span>{sample.unit}</span></> : <strong className="is-empty">尚未读取</strong>}</div>
    {balance?.profile?.selector && <p className="reward-balance-field">监控字段：<strong>{balance.profile.selector.label}</strong></p>}
    {sample && <dl className="reward-times reward-balance-times">
      <div><dt>采样时间</dt><dd>{time(sample.at)}</dd></div>
      <div><dt>较上次变化</dt><dd>{delta(sample.delta)}{sample.delta === undefined ? "" : ` ${sample.unit}`}</dd></div>
    </dl>}
    {balance?.low && <p className="reward-balance-alert"><AlertCircle size={13} />余额达到或低于提醒阈值</p>}
    {balance?.error && <p className="reward-balance-error">{balance.error}</p>}
    {unavailable && <p className="reward-balance-error">余额状态暂不可用，请刷新重试。</p>}
    <span className="reward-balance-monitor">余额监控：{balance?.profile?.enabled ? "已开启" : "未开启"}{balance?.profile?.enabled ? ` · 每 ${balance.profile.intervalMinutes} 分钟` : ""}</span>
  </div>;
}

interface Props {
  provider: RewardView;
  balance?: BalanceView;
  busy: boolean;
  nativeAvailable: boolean;
  pendingAction?: string;
  run: (id: RewardId, action: string, task: () => Promise<Result | void>) => Promise<void>;
}

export default function RewardBalancePanel({ provider, balance, busy, nativeAvailable, pendingAction, run }: Props) {
  const [observation, setObservation] = useState<RewardObservation>();
  const [navigationIndex, setNavigationIndex] = useState<number>();
  const [labelIndex, setLabelIndex] = useState<number>();
  const [valueIndex, setValueIndex] = useState<number>();
  const [unit, setUnit] = useState<BalanceUnit>(balance?.profile?.unit || "积分");
  const [interval, setInterval] = useState(String(balance?.profile?.intervalMinutes || 15));
  const [threshold, setThreshold] = useState(balance?.profile?.lowThreshold === undefined ? "" : String(balance.profile.lowThreshold));
  const [query, setQuery] = useState("");
  const panel = useRef<HTMLElement>(null);
  const mounted = useRef(true);
  const loadedProfile = useRef(!!balance?.profile);

  useEffect(() => {
    mounted.current = true;
    panel.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    if (loadedProfile.current || !balance?.profile) return;
    loadedProfile.current = true;
    setUnit(balance.profile.unit);
    setInterval(String(balance.profile.intervalMinutes));
    setThreshold(balance.profile.lowThreshold === undefined ? "" : String(balance.profile.lowThreshold));
  }, [balance?.profile]);

  function clear() {
    setObservation(undefined);
    setNavigationIndex(undefined);
    setLabelIndex(undefined);
    setValueIndex(undefined);
    setQuery("");
  }
  function accept(next: RewardObservation) {
    if (!mounted.current) return;
    clear();
    setObservation(next);
  }
  function inspect() {
    clear();
    void run(provider.id, "检查余额窗口", async () => {
      const next = await api!.rewardBalanceInspect(provider.id);
      accept(next);
      return { message: next.message || "已读取窗口，请选择明确的余额标题与对应数值。" };
    });
  }
  function navigate() {
    if (!observation || navigationIndex === undefined) return;
    const { token } = observation, index = navigationIndex;
    clear();
    void run(provider.id, "记录并打开余额导航", async () => {
      const result = await api!.rewardBalanceNavigate(provider.id, token, index);
      try { accept(await api!.rewardBalanceInspect(provider.id)); }
      catch { throw new Error(`${result.message}；新窗口读取失败，请重新检查余额窗口。`); }
      return result;
    });
  }
  function save() {
    if (!observation || labelIndex === undefined || valueIndex === undefined) return;
    const { token } = observation, label = labelIndex, value = valueIndex;
    clear();
    void run(provider.id, "保存余额监控规则", () => api!.rewardBalanceConfigure(provider.id, token, label, value, unit, Number(interval), threshold.trim() === "" ? undefined : Number(threshold)));
  }
  const canOperate = nativeAvailable && !busy;
  const actionable = observation?.elements.filter(item => item.actionable && item.enabled && allowedNavigationName(item.name) && !blockedNavigation.test(item.automationId)) || [];
  const texts = observation?.elements.filter(item => item.controlType === "Text" && item.name.trim() && item.name.toLocaleLowerCase().includes(query.toLocaleLowerCase())) || [];
  const chosenLabel = observation?.elements.find(item => item.index === labelIndex)?.name;
  const chosenValue = observation?.elements.find(item => item.index === valueIndex)?.name;
  const validInterval = /^\d+$/.test(interval) && Number(interval) >= 5 && Number(interval) <= 1440;
  const validThreshold = threshold.trim() === "" || (Number.isFinite(Number(threshold)) && Number(threshold) >= 0);
  const ready = !!observation && labelIndex !== undefined && valueIndex !== undefined && validInterval && validThreshold;
  const history = [...(balance?.history || [])].reverse().sort((a, b) => b.at.localeCompare(a.at)).slice(0, 20);

  return <section ref={panel} className="panel reward-setup reward-balance-setup" aria-label={`${provider.name} 余额监控配置`}>
    <div className="section-title"><span><Wallet size={18} />{provider.name} · 余额监控</span><span className="badge muted">独立配置</span></div>
    <p className="secondary">在官方客户端中打开余额页面，选择余额标题和对应数值。余额监控适用于所有平台，与是否支持主动领取分开设置；不同单位分别显示。</p>
    <div className="reward-client-row">
      <div><span className="reward-field-label">余额监控客户端</span><code className="reward-path">{balance?.profile?.executable || "尚未绑定 Windows 客户端 EXE"}</code></div>
      <button disabled={!canOperate} onClick={() => {
        clear();
        void run(provider.id, "绑定余额客户端", async () => {
          const result = await api!.rewardBalanceBind(provider.id);
          loadedProfile.current = false;
          return result;
        });
      }}><FolderOpen size={14} />{balance?.profile ? "重新绑定余额客户端" : "绑定余额客户端 EXE"}</button>
      <button disabled={!canOperate || !balance?.profile} onClick={inspect}><Eye size={14} />检查余额窗口</button>
    </div>
    {balance?.profile && <div className="reward-recorded">
      <div className="reward-recorded-title"><Settings2 size={15} /><strong>已保存的读取规则</strong><span>{balance.profile.selector ? "余额字段已配置" : "等待选择余额字段"}</span></div>
      {balance.profile.windowTitle && <p className="secondary">窗口：{balance.profile.windowTitle}</p>}
      {balance.profile.navigation.length ? <ol className="reward-flow">{balance.profile.navigation.map((step, index) => <li key={index}><span>{index + 1}</span>{step.name || "余额导航"}<ChevronRight size={13} /></li>)}</ol> : <p className="reward-placeholder">未记录导航，将直接读取已打开的余额页面。</p>}
      <div className="reward-saved-checks"><span>余额标题：</span><strong>{balance.profile.selector?.label || "尚未保存"}</strong><span>单位：{balance.profile.unit}</span><span>读取周期：{balance.profile.intervalMinutes} 分钟</span><span>低余额提醒：{balance.profile.lowThreshold === undefined ? "未设置" : `${number(balance.profile.lowThreshold)} ${balance.profile.unit}`}</span></div>
    </div>}
    {observation ? <div className="reward-calibration">
      <div className="reward-observation-heading"><Eye size={16} /><strong>余额窗口：{observation.title}</strong><span>{observation.elements.length} 个可见元素</span></div>
      <div className="reward-calibration-columns">
        <div className="reward-controls">
          <h3>1. 导航到余额页面</h3>
          <p className="secondary">只记录打开余额、用量或账户概览的导航。点击后会立即打开该页面并重新检查；不记录领取、充值、购买或消耗权益的按钮。</p>
          <div className="reward-element-list" role="radiogroup" aria-label="余额导航控件">
            {actionable.length ? actionable.map(item => <label className={`reward-element ${navigationIndex === item.index ? "is-selected" : ""}`} key={item.index}>
              <input type="radio" name="balance-navigation" checked={navigationIndex === item.index} disabled={!canOperate} onChange={() => setNavigationIndex(item.index)} />
              <span>{item.name || "（无文字控件）"}</span><small>{item.controlType}</small>
            </label>) : <p className="reward-placeholder">当前页面没有可点击导航。若已显示余额，可直接选择余额字段。</p>}
          </div>
          <div className="inline-actions"><button disabled={!canOperate || navigationIndex === undefined} onClick={navigate}><ChevronRight size={14} />记录并打开余额导航</button></div>
        </div>
        <div className="reward-checks">
          <h3>2. 选择余额标题与数值</h3>
          <p className="secondary">例如“可用积分 1,200”可同时选为标题和数值；分开的“剩余积分”与“1,200”分别选择。不要选择已用量、套餐价格、奖励额度或账户信息。</p>
          <input className="reward-input" aria-label="筛选余额文字" placeholder="搜索余额标签或数值…" value={query} onChange={event => setQuery(event.target.value)} />
          <div className="reward-balance-fields">
            <fieldset><legend>余额标题</legend><div className="reward-context-list" role="radiogroup" aria-label="余额标题">
              {texts.length ? texts.map(item => <label className="reward-element" key={item.index}>
                <input type="radio" name="balance-label" checked={labelIndex === item.index} disabled={!canOperate} onChange={() => setLabelIndex(item.index)} /><span>{item.name}</span>
              </label>) : <p className="reward-placeholder">没有匹配的可见文字。</p>}
            </div></fieldset>
            <fieldset><legend>余额数值</legend><div className="reward-context-list" role="radiogroup" aria-label="余额数值">
              {texts.length ? texts.map(item => <label className="reward-element" key={item.index}>
                <input type="radio" name="balance-value" checked={valueIndex === item.index} disabled={!canOperate} onChange={() => setValueIndex(item.index)} /><span>{item.name}</span>
              </label>) : <p className="reward-placeholder">没有匹配的可见文字。</p>}
            </div></fieldset>
          </div>
          <div className="reward-saved-checks" aria-label="已选余额字段"><span>标题：</span><strong>{chosenLabel || "尚未选择"}</strong><span>数值：</span><strong>{chosenValue || "尚未选择"}</strong></div>
          <div className="reward-balance-options">
            <label className="reward-field"><span>余额单位</span><select aria-label="余额单位" disabled={!canOperate} value={unit} onChange={event => setUnit(event.target.value as BalanceUnit)}>{units.map(item => <option key={item} value={item}>{item}</option>)}</select></label>
            <label className="reward-field"><span>刷新周期（分钟）</span><input aria-label="余额刷新周期" type="number" min={5} max={1440} step={1} disabled={!canOperate} value={interval} onChange={event => setInterval(event.target.value)} /><small>5–1440 分钟，默认 15 分钟。</small></label>
            <label className="reward-field"><span>低余额提醒（可选）</span><input aria-label="低余额提醒阈值" type="number" min={0} step="any" placeholder="留空关闭提醒" disabled={!canOperate} value={threshold} onChange={event => setThreshold(event.target.value)} /><small>使用上方选择的余额单位。</small></label>
          </div>
          {(!validInterval || !validThreshold) && <p className="error-text">刷新周期须为 5–1440 的整数；低余额阈值须为非负数或留空。</p>}
          <button className="primary" disabled={!canOperate || !ready} onClick={save}><Check size={14} />保存余额监控规则</button>
        </div>
      </div>
    </div> : <div className="reward-observation-empty"><Eye size={20} /><span>点击“检查余额窗口”选择余额字段。每次检查、导航或保存后，旧选择都会清空。</span></div>}
    <div className="reward-run-bar">
      <div className="inline-actions">
        <button className="primary" disabled={!canOperate || !balance?.profile?.selector} onClick={() => { clear(); void run(provider.id, "读取最新余额", () => api!.rewardBalanceRefresh(provider.id)); }}><RefreshCw size={14} />读取最新余额</button>
        <button disabled={busy || !balance?.profile} onClick={() => { clear(); void run(provider.id, "重置余额监控", async () => { const result = await api!.rewardBalanceReset(provider.id); loadedProfile.current = false; setUnit("积分"); setInterval("15"); setThreshold(""); return result; }); }}><Trash2 size={14} />重置余额监控</button>
      </div>
      <label className="reward-auto-toggle"><input type="checkbox" aria-label={`${provider.name} 自动监控余额`} checked={!!balance?.profile?.enabled} disabled={busy || (!balance?.profile?.enabled && (!nativeAvailable || !balance?.profile?.selector))} onChange={event => { const enabled = event.target.checked; clear(); void run(provider.id, enabled ? "开启余额监控" : "关闭余额监控", () => api!.rewardBalanceAutomation(provider.id, enabled)); }} /><span>自动监控余额</span><small>{balance?.profile?.enabled ? `每 ${balance.profile.intervalMinutes} 分钟读取` : "配置余额字段后可开启"}</small></label>
    </div>
    {pendingAction && <p className="reward-pending" role="status"><LoaderCircle size={14} className="spin" />正在{pendingAction}…</p>}
    <p className="reward-balance-caption"><Clock3 size={14} />下次读取：{time(balance?.nextCheck)} · 控制台及客户端需保持打开、可见，Windows 保持解锁。</p>
    <div className="reward-balance-history">
      <div className="reward-recorded-title"><History size={15} /><strong>最近余额记录</strong><span>最多显示最近 20 次</span></div>
      <p className="secondary">变化值是两次余额采样的差值，可能包含消耗、过期或其他发放，不代表本次领取收益。</p>
      {history.length ? <div className="reward-balance-table-scroll"><table><thead><tr><th>采样时间</th><th>余额</th><th>较上次变化</th><th>采样时点</th></tr></thead><tbody>{history.map((item, index) => <tr key={`${item.at}-${index}`}><td>{time(item.at)}</td><td>{number(item.value)} {item.unit}</td><td>{delta(item.delta)}{item.delta === undefined ? "" : ` ${item.unit}`}</td><td>{reasons[item.reason]}</td></tr>)}</tbody></table></div> : <p className="reward-placeholder">尚无真实余额记录。读取失败不会以 0 替代余额。</p>}
    </div>
  </section>;
}
