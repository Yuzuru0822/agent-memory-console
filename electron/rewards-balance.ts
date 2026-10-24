import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { atomicWrite, nativeExecutable, noLinks } from "./safety";
import { rewardDefinitions } from "./rewards-adapters";
import type { ConsoleService } from "./service";
import type { RewardsBridge } from "./rewards-service";
import type { RewardElement, RewardId, RewardObservation, RewardSelector } from "../src/rewards-types";
import type { BalanceProfile, BalanceReason, BalanceSample, BalanceSelector, BalanceUnit, BalancesSnapshot } from "../src/rewards-balance-types";

interface BalanceState { history: BalanceSample[]; lastAttempt?: string; error?: string; nextCheck?: string }
interface Stored { version: 1; profiles: Partial<Record<RewardId, BalanceProfile>>; states: Partial<Record<RewardId, BalanceState>> }
interface Observed { id: RewardId; at: number; profileHash: string; view: RewardObservation }
interface ParsedNumber { value: number; prefix: string; suffix: string }
const maxConfig = 2 * 1024 * 1024;
const units: BalanceUnit[] = ["积分", "Credits", "CNY", "USD"];
const reasons: BalanceReason[] = ["manual", "scheduled", "before_claim", "after_claim"];
const balanceLabel = /余额|剩余|可用|\bbalance\b|\bremaining\b|\bavailable\b/i;
const contradictoryLabel = /不可用|已用|已使用|已消费|已消耗|\bunavailable\b|\bused\b|\bspent\b/i;
const forbiddenNavigation = /领取|签到|购买|充值|支付|订阅|续费|升级|重置|兑换|删除|移除|邀请|分享|登录|登陆|注册|授权|注销|退出|安全|隐私|权限|密码|验证码|发送|发布|claim|check[ _-]?in|purchase|recharge|payment|checkout|subscribe|upgrade|reset|redeem|delete|remove|invite|share|log[ _-]?in|sign[ _-]?in|sign[ _-]?up|authorize|logout|security|privacy|permission|password|verification|send|publish/i;
const readOnlyNavigation = new Set(["订阅和用量"]);
const clean = (value: string) => value.replace(/[\u00a0\u202f\t\r\n]/g, " ").trim();
const finiteAmount = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
const iso = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value));
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const selectorOf = (e: RewardSelector): RewardSelector => ({ name: e.name, automationId: e.automationId, controlType: e.controlType });
const equal = (a: RewardSelector, b: RewardSelector) => a.name === b.name && a.automationId === b.automationId && a.controlType === b.controlType;

/** A displayed amount, never a sum, estimate, percentage, capacity ratio or date. */
export function parseBalanceNumber(raw: string): ParsedNumber | undefined {
  if (typeof raw !== "string" || !raw.trim() || raw.length > 300) return;
  const text = clean(raw);
  if (/[%％/\\−+＋~≈<>≤≥±-]|约|大约|大概|不少于|超过|低于|\b(?:about|approximately|over|under)\b/i.test(text)) return;
  const first = text.search(/\d/), last = text.search(/\d[^\d]*$/);
  if (first < 0 || last < 0) return;
  const prefix = text.slice(0, first), suffix = text.slice(last + 1), number = text.slice(first, last + 1);
  // A separator without its other digit, or a compact unit, must not silently
  // change the meaning (e.g. .5, 100., 1k, 2万 or scientific notation).
  if (/[.,]$/.test(prefix.trim()) || /^[.,]/.test(suffix.trim()) || /^\s*(?:[kmb](?:\b|$)|thousand\b|million\b|billion\b|trillion\b|万|亿|千|百|[eE][+-]?\d)/i.test(suffix)) return;
  if (/有效期|到期|过期|截至|日期|时间|\b(?:date|expiry|expires?|expiring|until)\b/i.test(prefix + suffix) || /^\s*(?:年|个月|月|天|日|小时|分钟|秒|years?\b|months?\b|days?\b|hours?\b|minutes?\b|seconds?\b)/i.test(suffix)) return;
  if (!/^(?:0|[1-9]\d*|[1-9]\d{0,2}(?:,\d{3})+|[1-9]\d{0,2}(?: \d{3})+)(?:\.\d+)?$/.test(number)) return;
  const value = Number(number.replace(/[, ]/g, ""));
  if (!finiteAmount(value)) return;
  return { value, prefix, suffix };
}

function numericAffix(value: string) { return /^\s*(?:￥|¥|\$|Credits?|CNY|USD|积分|点|元|人民币|美元)?\s*$/i.test(value); }
function validLabel(value: string) { return value.length > 0 && value.length <= 300 && balanceLabel.test(value) && !contradictoryLabel.test(value); }

export class RewardsBalanceService {
  private data: Stored = { version: 1, profiles: {}, states: {} };
  private observations = new Map<string, Observed>();
  private running?: RewardId;
  private calibratingUntil = 0;
  private cursor = 0;
  private readonly file: string;

  constructor(private console: ConsoleService, private bridge: RewardsBridge, private now = () => Date.now(), private delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))) {
    this.file = path.join(console.storage, "balances.json"); noLinks(this.file);
    if (!fs.existsSync(this.file)) return;
    if (!fs.statSync(this.file).isFile() || fs.statSync(this.file).size > maxConfig) throw new Error("余额设置文件过大或不是普通文件");
    const parsed: unknown = JSON.parse(fs.readFileSync(this.file, "utf8"));
    if (!object(parsed) || parsed.version !== 1 || !object(parsed.profiles) || !object(parsed.states)) throw new Error("余额设置文件格式无效");
    for (const [id, profile] of Object.entries(parsed.profiles)) { this.definition(id); this.checkProfile(profile as BalanceProfile); }
    for (const [id, state] of Object.entries(parsed.states)) {
      this.definition(id);
      if (!parsed.profiles[id] || !object(state) || !Array.isArray(state.history) || state.history.length > 100 || state.lastAttempt !== undefined && !iso(state.lastAttempt) || state.nextCheck !== undefined && !iso(state.nextCheck) || state.error !== undefined && (typeof state.error !== "string" || state.error.length > 300)) throw new Error("余额记录格式无效");
      const profile = parsed.profiles[id] as BalanceProfile;
      let previous: BalanceSample | undefined;
      for (const sample of state.history) {
        if (!object(sample) || !iso(sample.at) || !finiteAmount(sample.value) || sample.unit !== profile.unit || !reasons.includes(sample.reason as BalanceReason) || sample.delta !== undefined && (typeof sample.delta !== "number" || !Number.isFinite(sample.delta) || Math.abs(sample.delta) > Number.MAX_SAFE_INTEGER) || previous && Date.parse(sample.at) < Date.parse(previous.at)) throw new Error("余额样本格式无效");
        previous = sample as unknown as BalanceSample;
      }
    }
    for (const [id, profile] of Object.entries(parsed.profiles)) if ((profile as BalanceProfile).enabled && !(parsed.states[id] as BalanceState | undefined)?.history.length) throw new Error("自动余额监控缺少成功读取记录");
    this.data = parsed as unknown as Stored;
  }

  private definition(id: unknown) { const d = rewardDefinitions.find(item => item.id === id); if (!d) throw new Error("未知积分平台"); return d; }
  private writable() { if (!this.console.verifyAudit().valid) throw new Error("活动台账校验失败，已停止余额操作"); }
  private idle() { if (this.running) throw new Error("余额操作尚未完成，请稍后再试"); }
  private save() { this.writable(); noLinks(this.file); const body = JSON.stringify(this.data, null, 2); if (Buffer.byteLength(body) > maxConfig) throw new Error("余额设置超出大小限制"); atomicWrite(this.file, body); }
  private profile(id: RewardId): BalanceProfile { this.definition(id); const p = this.data.profiles[id]; if (!p) throw new Error("请先绑定余额客户端"); this.checkProfile(p); return p; }
  private checkNavigation(s: RewardSelector) {
    if (!s || typeof s.name !== "string" || !s.name.trim() || s.name.length > 300 || typeof s.automationId !== "string" || s.automationId.length > 500 || !["Button", "MenuItem", "Hyperlink", "TabItem"].includes(s.controlType) || (forbiddenNavigation.test(s.name) && !readOnlyNavigation.has(s.name)) || forbiddenNavigation.test(s.automationId)) throw new Error("余额流程仅允许查看页面的导航，不允许领取、消费、登录或设置操作");
  }
  private checkBalanceSelector(s: BalanceSelector) {
    if (!s || !["inline", "siblings"].includes(s.layout) || s.controlType !== "Text" || typeof s.label !== "string" || !validLabel(s.label) || typeof s.prefix !== "string" || s.prefix.length > 300 || typeof s.suffix !== "string" || s.suffix.length > 300 || typeof s.automationId !== "string" || s.automationId.length > 500 || (s.layout === "inline" && s.label !== s.prefix + s.suffix) || (s.layout === "siblings" && (!numericAffix(s.prefix) || !numericAffix(s.suffix)))) throw new Error("余额识别规则无效，请重新校准");
    const parsed = parseBalanceNumber(s.prefix + "0" + s.suffix);
    if (!parsed || parsed.prefix !== s.prefix || parsed.suffix !== s.suffix) throw new Error("余额数值规则无效，请重新校准");
  }
  private checkProfile(p: BalanceProfile) {
    if (!p || typeof p.executable !== "string" || p.executable.length > 2000 || !/^[a-f0-9]{64}$/.test(p.executableHash) || typeof p.windowTitle !== "string" || p.windowTitle.length > 500 || !Array.isArray(p.navigation) || p.navigation.length > 8 || !units.includes(p.unit) || !Number.isInteger(p.intervalMinutes) || p.intervalMinutes < 5 || p.intervalMinutes > 1440 || p.lowThreshold !== undefined && !finiteAmount(p.lowThreshold) || typeof p.enabled !== "boolean") throw new Error("余额配置无效，请重新绑定");
    for (const step of p.navigation) this.checkNavigation(step);
    if (p.selector) this.checkBalanceSelector(p.selector);
    if (p.enabled && (!p.selector || !p.windowTitle)) throw new Error("自动余额监控缺少识别规则");
  }
  private hashProfile(p: BalanceProfile) { return crypto.createHash("sha256").update(JSON.stringify(p)).digest("hex"); }
  private executableHash(executable: string) { nativeExecutable(executable); if (fs.statSync(executable).size > 1024 * 1024 * 1024) throw new Error("程序文件过大"); return crypto.createHash("sha256").update(fs.readFileSync(executable)).digest("hex"); }
  private validateExecutable(p: BalanceProfile) { if (!this.bridge.available()) throw new Error("Windows 余额读取组件不可用"); if (this.executableHash(p.executable) !== p.executableHash) throw new Error("客户端程序已更新或变化，请重新绑定余额"); }
  private observed(id: RewardId, token: string) { const o = this.observations.get(token); if (!o || o.id !== id || this.now() - o.at > 60000 || this.now() < o.at || o.profileHash !== this.hashProfile(this.profile(id))) throw new Error("窗口检查已过期，请重新检查"); return o; }
  private validateView(view: { title: string; elements: RewardElement[] }) {
    if (!view || typeof view.title !== "string" || !view.title || view.title.length > 500 || !Array.isArray(view.elements) || view.elements.length > 500) throw new Error("客户端窗口观察无效");
    const indices = new Set<number>();
    for (const e of view.elements) {
      if (!Number.isInteger(e.index) || e.index < 0 || indices.has(e.index) || typeof e.name !== "string" || e.name.length > 300 || typeof e.automationId !== "string" || e.automationId.length > 500 || typeof e.controlType !== "string" || typeof e.enabled !== "boolean" || typeof e.actionable !== "boolean" || e.parentIndex !== undefined && (!Number.isInteger(e.parentIndex) || e.parentIndex < 0 || e.parentIndex === e.index)) throw new Error("客户端窗口观察结构无效");
      indices.add(e.index);
    }
    return view;
  }
  private async read(p: BalanceProfile) { const view = this.validateView(await this.bridge.inspect(p.executable, p.windowTitle || undefined)); if (p.windowTitle && view.title !== p.windowTitle) throw new Error("客户端窗口标题已变化，请重新校准"); return view; }
  private siblings(elements: RewardElement[], label: RewardElement, value: RewardElement) {
    if (label.index === value.index || label.parentIndex === undefined || label.parentIndex !== value.parentIndex) return false;
    const parent = elements.find(e => e.index === label.parentIndex);
    return !!parent && !["Window", "Document"].includes(parent.controlType) && elements.filter(e => e.parentIndex === parent.index).length <= 12;
  }
  private locate(elements: RewardElement[], s: BalanceSelector): number | undefined {
    const matches: number[] = [];
    const labels = s.layout === "siblings" ? elements.filter(e => e.controlType === "Text" && clean(e.name) === s.label) : [];
    for (const e of elements) {
      if (e.controlType !== "Text" || e.automationId !== s.automationId) continue;
      const parsed = parseBalanceNumber(e.name);
      if (!parsed || parsed.prefix !== s.prefix || parsed.suffix !== s.suffix) continue;
      if (s.layout === "inline") matches.push(parsed.value);
      else for (const label of labels) if (this.siblings(elements, label, e)) matches.push(parsed.value);
    }
    if (matches.length > 1) throw new Error("页面中存在多个匹配余额，已停止读取，请重新校准更明确的字段");
    return matches[0];
  }
  private requireUnique(elements: RewardElement[], selector: RewardSelector) { const matches = elements.filter(e => equal(e, selector)); if (matches.length !== 1 || !matches[0].enabled || !matches[0].actionable) throw new Error("余额导航控件不唯一、不可用或界面已变化"); }
  private fresh(state: BalanceState | undefined, p: BalanceProfile) { const at = state?.history.at(-1)?.at; return !!at && !state?.error && this.now() >= Date.parse(at) && this.now() - Date.parse(at) <= p.intervalMinutes * 60000; }
  private record(id: RewardId, value: number, reason: BalanceReason) {
    const p = this.profile(id), old = this.data.states[id], previous = old?.history.at(-1), at = new Date(this.now()).toISOString();
    const sample: BalanceSample = { at, value, unit: p.unit, reason };
    if (previous && previous.unit === p.unit) sample.delta = Number((value - previous.value).toPrecision(15));
    this.data.states[id] = { history: [...(old?.history || []), sample].slice(-100), lastAttempt: at, nextCheck: new Date(this.now() + p.intervalMinutes * 60000).toISOString() };
    this.save(); this.console.audit("rewards.balance", `${id} · ${reason} · ${value} ${p.unit}`);
  }

  isConfigured(id: RewardId) { this.definition(id); return !!this.data.profiles[id]?.selector; }
  snapshot(): BalancesSnapshot {
    const auditValid = this.console.verifyAudit().valid;
    return { nativeAvailable: this.bridge.available(), running: this.running, providers: rewardDefinitions.map(d => {
      const p = this.data.profiles[d.id], s = this.data.states[d.id], sample = s?.history.at(-1), stale = !p || !auditValid || !this.bridge.available() || !this.fresh(s, p);
      return { id: d.id, profile: p && structuredClone(p), status: !p?.selector ? "unconfigured" : s?.error || !auditValid ? "error" : sample ? "ok" : "ready", sample: sample && structuredClone(sample), history: structuredClone(s?.history || []), stale, low: !!p && !stale && p.lowThreshold !== undefined && sample !== undefined && sample.value <= p.lowThreshold, lastAttempt: s?.lastAttempt, error: !auditValid ? "活动台账校验失败，已停止余额操作" : s?.error, nextCheck: p?.enabled ? s?.nextCheck : undefined };
    }) };
  }
  bind(id: RewardId, executable: string) {
    this.writable(); this.idle(); this.definition(id);
    const hash = this.executableHash(executable);
    this.data.profiles[id] = { executable: path.resolve(executable), executableHash: hash, windowTitle: "", navigation: [], unit: "积分", intervalMinutes: 15, enabled: false };
    delete this.data.states[id]; this.observations.clear(); this.save(); this.console.audit("rewards.balance.bind", `${id} · ${executable}`);
  }
  async inspect(id: RewardId): Promise<RewardObservation> {
    this.writable(); this.idle(); const p = this.profile(id); this.validateExecutable(p); this.running = id;
    try {
      this.calibratingUntil = this.now() + 5 * 60000;
      if (p.enabled) { p.enabled = false; this.save(); }
      const view = await this.read(p), observation: RewardObservation = { ...view, token: crypto.randomUUID() };
      this.observations.clear(); this.observations.set(observation.token, { id, at: this.now(), profileHash: this.hashProfile(p), view: observation }); return observation;
    } finally { this.running = undefined; }
  }
  async navigate(id: RewardId, token: string, index: number) {
    this.writable(); this.idle(); if (!Number.isInteger(index)) throw new Error("余额导航参数无效");
    const o = this.observed(id, token), e = o.view.elements.find(item => item.index === index);
    if (!e?.enabled || !e.actionable) throw new Error("请选择当前可用的导航控件");
    const selector = selectorOf(e); this.checkNavigation(selector); const p = this.profile(id); this.validateExecutable(p);
    if (p.navigation.length >= 8) throw new Error("余额导航最多 8 步，请重置后精简流程");
    this.running = id;
    try {
      p.enabled = false; p.windowTitle = o.view.title; delete p.selector; delete this.data.states[id]; this.observations.clear(); this.save();
      const fresh = await this.read(p); this.requireUnique(fresh.elements, selector); this.writable(); this.validateExecutable(p);
      await this.bridge.invoke(p.executable, p.windowTitle, selector); p.navigation.push(selector); this.save(); this.console.audit("rewards.balance.navigation", id);
      return { message: "余额导航已记录，请重新检查当前窗口" };
    } finally { this.running = undefined; }
  }
  configure(id: RewardId, token: string, labelIndex: number, valueIndex: number, unit: BalanceUnit, intervalMinutes: number, lowThreshold?: number) {
    this.writable(); this.idle();
    if (!Number.isInteger(labelIndex) || !Number.isInteger(valueIndex) || !units.includes(unit) || !Number.isInteger(intervalMinutes) || intervalMinutes < 5 || intervalMinutes > 1440 || lowThreshold !== undefined && !finiteAmount(lowThreshold)) throw new Error("余额配置参数无效：检查单位、5–1440 分钟间隔和非负阈值");
    const o = this.observed(id, token), p = this.profile(id), label = o.view.elements.find(e => e.index === labelIndex), element = o.view.elements.find(e => e.index === valueIndex);
    this.validateExecutable(p);
    if (label?.controlType !== "Text" || element?.controlType !== "Text" || !validLabel(clean(label.name))) throw new Error("请选择明确包含余额、剩余或可用含义的文字标签和对应数值");
    const parsed = parseBalanceNumber(element.name); if (!parsed) throw new Error("余额数值不是唯一明确的非负数字，无法读取");
    const inline = labelIndex === valueIndex;
    if (!inline && (!this.siblings(o.view.elements, label, element) || !numericAffix(parsed.prefix) || !numericAffix(parsed.suffix))) throw new Error("分开的余额标签和数值必须是同一小容器内的相邻同级文字，不能使用页面上的任意数字");
    const selector: BalanceSelector = { label: inline ? parsed.prefix + parsed.suffix : clean(label.name), prefix: parsed.prefix, suffix: parsed.suffix, automationId: element.automationId, controlType: "Text", layout: inline ? "inline" : "siblings" };
    this.checkBalanceSelector(selector);
    const value = this.locate(o.view.elements, selector); if (value === undefined) throw new Error("未找到唯一明确的余额");
    p.selector = selector; p.windowTitle = o.view.title; p.unit = unit; p.intervalMinutes = intervalMinutes; p.lowThreshold = lowThreshold; p.enabled = false;
    delete this.data.states[id]; this.observations.clear(); this.record(id, value, "manual"); this.console.audit("rewards.balance.configure", `${id} · ${unit} · ${intervalMinutes} 分钟`);
    return { message: `余额已读取：${value} ${unit}，可启用自动监控` };
  }
  async refresh(id: RewardId, reason: BalanceReason = "manual"): Promise<{ message: string }> {
    this.writable(); this.idle(); if (!reasons.includes(reason)) throw new Error("余额读取来源无效");
    const p = this.profile(id); if (!p.selector || !p.windowTitle) throw new Error("请先校准余额字段");
    this.running = id; this.observations.clear();
    try {
      this.validateExecutable(p); let view = await this.read(p), value = this.locate(view.elements, p.selector);
      // A pre-claim observation must not navigate away from the calibrated
      // reward panel. After a claim or on a monitor tick, resume at the latest
      // uniquely visible step, rather than toggling an already-open menu shut.
      let start = 0;
      if (value === undefined && reason !== "before_claim") for (let index = p.navigation.length - 1; index >= 0; index--) {
        const matches = view.elements.filter(e => equal(e, p.navigation[index]));
        if (matches.length === 1 && matches[0].enabled && matches[0].actionable) { start = index; break; }
      }
      if (value === undefined && reason !== "before_claim") for (const step of p.navigation.slice(start)) {
        this.checkNavigation(step); this.requireUnique(view.elements, step); this.writable(); this.validateExecutable(p);
        await this.bridge.invoke(p.executable, p.windowTitle, step); await this.delay(350); view = await this.read(p); value = this.locate(view.elements, p.selector); if (value !== undefined) break;
      }
      if (value === undefined) throw new Error("未找到已校准的唯一余额字段，请打开余额页或重新校准");
      this.writable(); this.validateExecutable(p); this.record(id, value, reason); return { message: `余额已更新：${value} ${p.unit}` };
    } catch (error) {
      const message = `余额读取失败：${String(error instanceof Error ? error.message : error).slice(0, 280)}`;
      this.data.states[id] = { history: this.data.states[id]?.history || [], lastAttempt: new Date(this.now()).toISOString(), error: message, nextCheck: new Date(this.now() + p.intervalMinutes * 60000).toISOString() };
      this.save(); this.console.audit("rewards.balance.error", `${id} · ${message}`); return { message };
    } finally { this.running = undefined; }
  }
  automation(id: RewardId, enabled: boolean) {
    this.writable(); this.idle(); if (typeof enabled !== "boolean") throw new Error("余额监控设置无效"); const p = this.profile(id);
    if (enabled && (!p.selector || !this.fresh(this.data.states[id], p))) throw new Error("请先成功读取一次当前余额，再启用监控");
    if (enabled) this.validateExecutable(p); p.enabled = enabled; this.calibratingUntil = 0; this.save(); this.console.audit("rewards.balance.automation", `${id} · ${enabled}`);
  }
  reset(id: RewardId) {
    this.writable(); this.idle(); const p = this.profile(id); p.enabled = false; p.navigation = []; p.windowTitle = ""; delete p.selector; delete this.data.states[id]; this.observations.clear(); this.save(); this.console.audit("rewards.balance.reset", id);
  }
  async tick() {
    if (this.running || this.now() < this.calibratingUntil) return;
    for (let count = 0; count < rewardDefinitions.length; count++) {
      const index = (this.cursor + count) % rewardDefinitions.length, id = rewardDefinitions[index].id, p = this.data.profiles[id], s = this.data.states[id];
      if (!p?.enabled || !p.selector || s?.nextCheck && Date.parse(s.nextCheck) > this.now()) continue;
      this.cursor = (index + 1) % rewardDefinitions.length; await this.refresh(id, "scheduled"); break;
    }
  }
}
