import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { atomicWrite, nativeExecutable, noLinks } from "./safety";
import { rewardDefinitions } from "./rewards-adapters";
import type { ConsoleService } from "./service";
import type { RewardId, RewardSelector, RewardElement, RewardObservation, RewardProfile, RewardState, RewardLog, RewardsSnapshot } from "../src/rewards-types";

export interface RewardsBridge {
  available(): boolean;
  inspect(executable: string, windowTitle?: string): Promise<{ title: string; elements: RewardElement[] }>;
  invoke(executable: string, windowTitle: string, selector: RewardSelector, expectedContext?: string[]): Promise<void>;
}
export type RewardBalanceObserver = (id: RewardId, reason: "before_claim" | "after_claim") => Promise<void>;
interface RecordState { state: RewardState; message: string; attempt?: string; success?: string; window?: string; next?: string }
interface Stored { version: 1; profiles: Partial<Record<RewardId, RewardProfile>>; states: Partial<Record<RewardId, RecordState>>; logs: RewardLog[] }
interface Observed { id: RewardId; profileHash: string; at: number; view: RewardObservation }
const selectorOf = (element: RewardSelector): RewardSelector => ({ name: element.name, automationId: element.automationId, controlType: element.controlType });
const selectorEqual = (a: RewardSelector, b: RewardSelector) => a.name === b.name && a.automationId === b.automationId && a.controlType === b.controlType;
const normalize = (value: string) => value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
const forbidden = /购买|充值|支付|订阅|续费|升级|重置|兑换|核销|消耗|扣除|删除|移除|发送|发布|邀请|分享|授权|注销|退出|安全|权限|密码|验证码|purchase|payment|checkout|subscribe|upgrade|reset|redeem|consume|spend|\bbuy\b|delete|remove|send|publish|invite|share|password|permission|logout/i;
const claimLabel = /签到|领取|\bclaim\b|\bcheck[ -]?in\b/i;
const successLabel = /^(今日已签到|今日已领取|今日已领|已签到|已领取|签到成功|领取成功|Already claimed|Claimed|Claim successful|Successfully claimed|Checked in|Check-in successful)[!！。.]?$/i;
const maxConfig = 2 * 1024 * 1024;

export function rewardWindow(now: number, resetHour: number): string {
  return new Date(now + (8 - resetHour) * 3600000).toISOString().slice(0, 10);
}
export function nextRewardWindow(now: number, resetHour: number): string {
  const shifted = now + (8 - resetHour) * 3600000;
  return new Date((Math.floor(shifted / 86400000) + 1) * 86400000 - (8 - resetHour) * 3600000).toISOString();
}
export class RewardsService {
  private data: Stored = { version: 1, profiles: {}, states: {}, logs: [] };
  private observations = new Map<string, Observed>();
  private running?: RewardId;
  private calibratingUntil = 0;
  private readonly file: string;
  constructor(private console: ConsoleService, private bridge: RewardsBridge, private now = () => Date.now(), private delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)), private balanceObserver?: RewardBalanceObserver) {
    this.file = path.join(console.storage, "rewards.json"); noLinks(this.file);
    if (fs.existsSync(this.file)) {
      if (fs.statSync(this.file).size > maxConfig) throw new Error("积分设置文件过大");
      const parsed = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (parsed.version !== 1 || !parsed.profiles || typeof parsed.profiles !== "object" || Array.isArray(parsed.profiles) || !parsed.states || typeof parsed.states !== "object" || Array.isArray(parsed.states) || !Array.isArray(parsed.logs)) throw new Error("积分设置文件格式无效");
      this.data = parsed;
      for (const [id, p] of Object.entries(this.data.profiles)) {
        if (this.definition(id).kind !== "ui") throw new Error("积分配置包含不支持的自动操作"); this.checkProfile(p);
        if (this.data.states[id as RewardId]?.state === "unknown") { p.enabled = false; p.validated = false; }
      }
      this.data.logs = this.data.logs.slice(-200);
    }
  }
  definition(id: unknown) {
    const definition = rewardDefinitions.find(item => item.id === id);
    if (!definition) throw new Error("未知积分平台"); return definition;
  }
  private writable() {
    if (!this.console.verifyAudit().valid) throw new Error("活动台账校验失败，已停止积分操作");
  }
  private save() { this.writable(); noLinks(this.file); atomicWrite(this.file, JSON.stringify(this.data, null, 2)); }
  private profile(id: RewardId): RewardProfile {
    if (this.definition(id).kind !== "ui") throw new Error("此平台尚无可执行的免费领取流程");
    const p = this.data.profiles[id]; if (!p) throw new Error("请先绑定领取客户端"); this.checkProfile(p); return p;
  }
  private checkProfile(p: RewardProfile) {
    if (!p || typeof p.executable !== "string" || !/^[a-f0-9]{64}$/.test(p.executableHash) || typeof p.windowTitle !== "string" || p.windowTitle.length > 500 || !Array.isArray(p.navigation) || p.navigation.length > 8 || !Array.isArray(p.context) || p.context.length > 5 || !p.context.every(v => typeof v === "string" && v.length > 0 && v.length <= 300) || !Array.isArray(p.successTexts) || p.successTexts.length > 12 || !p.successTexts.every(v => typeof v === "string" && successLabel.test(v)) || !Number.isInteger(p.resetHour) || p.resetHour < 0 || p.resetHour > 23 || typeof p.enabled !== "boolean" || typeof p.validated !== "boolean") throw new Error("积分流程配置无效，请重新校准");
    for (const step of p.navigation) this.checkSelector(step, false);
    if (p.claim) this.checkSelector(p.claim, true);
  }
  private checkSelector(s: RewardSelector, claim: boolean) {
    if (!s || typeof s.name !== "string" || !s.name.trim() || s.name.length > 300 || typeof s.automationId !== "string" || s.automationId.length > 500 || !["Button", "MenuItem", "Hyperlink", "TabItem"].includes(s.controlType) || forbidden.test(s.name)) throw new Error("该控件不适合积分流程：仅允许免费领取与必要导航");
    if (claim !== claimLabel.test(s.name)) throw new Error(claim ? "请选择明确的签到或领取按钮" : "领取按钮必须单独记录，不能作为导航执行");
  }
  private hashProfile(p: RewardProfile) { return crypto.createHash("sha256").update(JSON.stringify(p)).digest("hex"); }
  private executableHash(executable: string) {
    nativeExecutable(executable); if (fs.statSync(executable).size > 1024 * 1024 * 1024) throw new Error("程序文件过大");
    return crypto.createHash("sha256").update(fs.readFileSync(executable)).digest("hex");
  }
  private validateExecutable(p: RewardProfile) {
    if (!this.bridge.available()) throw new Error("Windows 领取组件不可用，请使用完整桌面版本");
    if (this.executableHash(p.executable) !== p.executableHash) throw new Error("客户端程序已更新或变化，请重新绑定并验证流程");
  }
  private invalidate(id: RewardId) {
    const p = this.profile(id); p.enabled = false; p.validated = false;
    delete this.data.states[id]; this.observations.clear();
  }
  bind(id: RewardId, executable: string) {
    this.writable(); if (this.running) throw new Error("领取操作尚未完成");
    const d = this.definition(id); if (d.kind !== "ui") throw new Error("此平台不支持自动点击领取");
    const hash = this.executableHash(executable);
    this.data.profiles[id] = { executable: path.resolve(executable), executableHash: hash, windowTitle: "", navigation: [], context: [], successTexts: ["今日已签到", "今日已领取", "今日已领", "签到成功", "领取成功", "Already claimed", "Claim successful"], resetHour: d.resetHour, enabled: false, validated: false };
    delete this.data.states[id]; this.observations.clear(); this.save(); this.console.audit("rewards.bind", `${id} · ${executable}`);
  }
  snapshot(): RewardsSnapshot {
    return { nativeAvailable: this.bridge.available(), running: this.running, logs: this.data.logs.slice(-100).reverse(), providers: rewardDefinitions.map(d => {
      const p = this.data.profiles[d.id], s = this.data.states[d.id];
      return { ...d, profile: p ? structuredClone(p) : undefined, state: s?.state || (d.kind !== "ui" ? "unsupported" : p?.validated ? "ready" : "needs_setup"), lastMessage: s?.message, lastAttempt: s?.attempt, lastSuccess: s?.success, nextCheck: p?.enabled ? s?.next : undefined };
    }) };
  }
  async inspect(id: RewardId): Promise<RewardObservation> {
    this.writable(); if (this.running) throw new Error("领取操作尚未完成");
    const p = this.profile(id); this.validateExecutable(p);
    this.running = id;
    try {
    this.calibratingUntil = this.now() + 5 * 60000;
    if (p.enabled) { p.enabled = false; this.save(); }
    const view = await this.bridge.inspect(p.executable, p.windowTitle || undefined);
    const observation = { ...view, token: crypto.randomUUID() };
    // One live observation prevents old windows or changed layouts from being replayed.
    this.observations.clear(); this.observations.set(observation.token, { id, at: this.now(), profileHash: this.hashProfile(p), view: observation });
    return observation;
    } finally { this.running = undefined; }
  }
  private observed(id: RewardId, token: string) {
    const o = this.observations.get(token);
    if (!o || o.id !== id || this.now() - o.at > 60000 || o.profileHash !== this.hashProfile(this.profile(id))) throw new Error("窗口检查已过期，请重新检查");
    return o;
  }
  async record(id: RewardId, token: string, index: number, kind: "navigate" | "claim") {
    this.writable(); if (this.running) throw new Error("领取操作尚未完成");
    if (!Number.isInteger(index) || !["navigate", "claim"].includes(kind)) throw new Error("控件参数无效");
    const o = this.observed(id, token), element = o.view.elements.find(e => e.index === index);
    if (!element?.enabled || !element.actionable) throw new Error("请选择当前可用的可点击控件");
    const selector = selectorOf(element); this.checkSelector(selector, kind === "claim");
    const p = this.profile(id); this.validateExecutable(p);
    if (kind === "navigate" && p.navigation.length >= 8) throw new Error("导航最多 8 步，请重置后精简流程");
    this.running = id;
    try {
    this.invalidate(id); p.windowTitle = o.view.title;
    // Persist invalidation before invoking any recorded navigation.
    this.save();
    if (kind === "navigate") {
      const fresh = await this.bridge.inspect(p.executable, p.windowTitle);
      this.requireUnique(fresh.elements, selector);
      await this.bridge.invoke(p.executable, p.windowTitle, selector); p.navigation.push(selector);
    } else p.claim = selector;
    this.save(); this.console.audit("rewards.record", `${id} · ${kind}`);
    } finally { this.running = undefined; }
  }
  checks(id: RewardId, token: string, indices: number[], successTexts: string[], resetHour: number) {
    this.writable(); if (this.running) throw new Error("领取操作尚未完成");
    const o = this.observed(id, token), p = this.profile(id);
    if (!Array.isArray(indices) || indices.length < 1 || indices.length > 5 || new Set(indices).size !== indices.length || !indices.every(Number.isInteger)) throw new Error("请选择 1–5 项活动标题或免费奖励说明");
    const context = indices.map(index => o.view.elements.find(e => e.index === index)).map(e => {
      if (!e || e.controlType !== "Text" || !e.name.trim() || e.name.length > 300 || forbidden.test(e.name) || successLabel.test(e.name) || (p.claim && normalize(e.name) === normalize(p.claim.name))) throw new Error("上下文必须是活动标题或免费奖励说明，不能是领取按钮、成功状态或付费/消费内容"); return e.name;
    });
    if (!context.some(text => /签到|福利|奖励|免费|每日.{0,30}(积分|领取)|daily.{0,30}(credits|reward)|free.{0,30}(credits|reward)|check[ -]?in/i.test(text))) throw new Error("上下文需要包含免费奖励或签到活动说明，单独的积分余额不能确认活动");
    if (!Array.isArray(successTexts) || successTexts.length < 1 || successTexts.length > 12 || !successTexts.every(text => typeof text === "string" && successLabel.test(text.trim()))) throw new Error("成功状态仅支持明确的领取/签到成功或已领取文案");
    if (!Number.isInteger(resetHour) || resetHour < 0 || resetHour > 23) throw new Error("刷新小时须为 0–23");
    if ((id === "qoder" || id === "qoder-cn") && resetHour !== 10) throw new Error("Qoder 官方窗口固定为北京时间 10:00");
    this.invalidate(id); p.windowTitle = o.view.title; p.context = context; p.successTexts = [...new Set(successTexts.map(text => text.trim()))]; p.resetHour = resetHour; this.save();
  }
  reset(id: RewardId) {
    this.writable(); if (this.running) throw new Error("领取操作尚未完成");
    const p = this.profile(id); this.invalidate(id); p.windowTitle = ""; p.navigation = []; delete p.claim; p.context = []; this.save();
  }
  automation(id: RewardId, enabled: boolean) {
    this.writable(); if (this.running || typeof enabled !== "boolean") throw new Error("自动领取设置无效或操作尚未完成");
    const p = this.profile(id); if (enabled && !p.validated) throw new Error("请先完成一次成功的试领验证");
    if (enabled) this.validateExecutable(p); p.enabled = enabled; this.save(); this.console.audit("rewards.automation", `${id} · ${enabled}`);
  }
  private requireUnique(elements: RewardElement[], selector: RewardSelector) {
    const matches = elements.filter(e => selectorEqual(e, selector));
    if (matches.length !== 1 || !matches[0].enabled || !matches[0].actionable) throw new Error("目标控件不唯一、不可用或界面已变化，请重新校准");
  }
  private hasContext(elements: RewardElement[], p: RewardProfile) {
    return p.context.every(text => elements.some(e => e.controlType === "Text" && normalize(e.name) === normalize(text)));
  }
  private hasSuccess(elements: RewardElement[], p: RewardProfile) {
    return elements.some(e => ["Text", "Button"].includes(e.controlType) && p.successTexts.some(text => normalize(e.name) === normalize(text)));
  }
  private recordResult(id: RewardId, state: RewardState, message: string, completed = false, started = this.now()) {
    const at = new Date(this.now()).toISOString(), p = this.profile(id), old = this.data.states[id];
    this.data.states[id] = { state, message, attempt: at, success: completed ? at : old?.success, window: completed ? rewardWindow(started, p.resetHour) : old?.window, next: completed ? nextRewardWindow(started, p.resetHour) : new Date(this.now() + 10 * 60000).toISOString() };
    this.data.logs.push({ at, provider: id, state, message }); this.data.logs = this.data.logs.slice(-200); this.save();
    this.console.audit("rewards.result", `${id} · ${state} · ${message}`);
  }
  private async observeBalance(id: RewardId, reason: "before_claim" | "after_claim") {
    // A failed balance read cannot turn a verified claim into a retryable failure.
    try { await this.balanceObserver?.(id, reason); } catch { /* Balance service retains its own stale/error state. */ }
  }
  async start(id: RewardId): Promise<{message: string}> {
    const result = await this.run(id);
    if (!this.profile(id).validated || !["claimed", "already_claimed"].includes(this.data.states[id]?.state || ""))
      return {message: `${result.message}；尚未开启自动领取，请按提示处理后重新验证。`};
    this.automation(id, true);
    return {message: "领取流程已验证，自动领取已开启；以后按平台周期执行并刷新已配置的余额。"};
  }
  async run(id: RewardId): Promise<{ message: string }> {
    this.writable(); if (this.running) throw new Error("已有领取流程正在执行");
    if (this.data.states[id]?.state === "unknown") throw new Error("上次领取结果未知，请在客户端核对后重新校准活动，再进行试领");
    const p = this.profile(id); if (!p.claim || !p.context.length || !p.successTexts.length || !p.windowTitle) throw new Error("请先记录领取按钮、活动上下文与成功状态");
    this.running = id; this.observations.clear(); this.calibratingUntil = 0; let submitted = false, observedCompletion = false;
    try {
      this.validateExecutable(p);
      await this.observeBalance(id, "before_claim");
      let view = await this.bridge.inspect(p.executable, p.windowTitle);
      // If already on the reward panel, do not toggle navigation menus closed.
      let navigationStart = 0;
      for (let i = p.navigation.length - 1; i >= 0; i--) {
        const matches = view.elements.filter(e => selectorEqual(e, p.navigation[i]));
        if (matches.length === 1 && matches[0].enabled && matches[0].actionable) { navigationStart = i; break; }
      }
      if (!this.hasContext(view.elements, p)) for (const step of p.navigation.slice(navigationStart)) {
        this.requireUnique(view.elements, step); await this.bridge.invoke(p.executable, p.windowTitle, step); await this.delay(350);
        view = await this.bridge.inspect(p.executable, p.windowTitle);
        if (this.hasContext(view.elements, p)) break;
      }
      if (!this.hasContext(view.elements, p)) throw new Error("未找到已校准的活动上下文，请打开正确活动或重新校准");
      if (this.hasSuccess(view.elements, p)) { this.recordResult(id, "already_claimed", "平台显示本活动已领取；本次未点击领取", true); observedCompletion = true; return { message: "平台显示已领取" }; }
      this.requireUnique(view.elements, p.claim);
      this.writable(); this.validateExecutable(p);
      // Persist an uncertain marker BEFORE the external effect. A crash/restart
      // must never silently retry a potentially submitted claim.
      this.data.states[id] = { state: "unknown", message: "领取请求待核验；中断后需人工检查", attempt: new Date(this.now()).toISOString() }; this.save();
      const submittedAt = this.now();
      submitted = true; await this.bridge.invoke(p.executable, p.windowTitle, p.claim, p.context);
      for (let attempt = 0; attempt < 4; attempt++) {
        await this.delay(650); view = await this.bridge.inspect(p.executable, p.windowTitle);
        if (this.hasContext(view.elements, p) && this.hasSuccess(view.elements, p)) {
          if (rewardWindow(submittedAt, p.resetHour) !== rewardWindow(this.now(), p.resetHour)) throw new Error("领取核验跨越活动刷新时间，请在客户端确认所属领取窗口");
          p.validated = true; this.recordResult(id, "claimed", "平台活动上下文中出现明确领取成功状态", true, submittedAt); observedCompletion = true; return { message: "领取已核验成功，可启用自动领取" };
        }
      }
      throw new Error("未观察到明确成功状态；请在客户端核对后再操作");
    } catch (error) {
      const message = submitted ? "领取结果未知，自动领取已暂停，请在客户端核对后重新校准。" : `领取未执行：${String(error instanceof Error ? error.message : error).slice(0, 300)}`;
      if (submitted) { p.enabled = false; p.validated = false; }
      this.recordResult(id, submitted ? "unknown" : "needs_attention", message);
      return { message };
    } finally {
      if (submitted || observedCompletion) await this.observeBalance(id, "after_claim");
      this.running = undefined;
    }
  }
  async tick() {
    if (this.running || this.now() < this.calibratingUntil) return;
    for (const definition of rewardDefinitions) {
      const id = definition.id, p = this.data.profiles[id], s = this.data.states[id];
      if (!p?.enabled || !p.validated || s?.state === "unknown") continue;
      if (s?.window === rewardWindow(this.now(), p.resetHour) || (s?.next && Date.parse(s.next) > this.now())) continue;
      await this.run(id); break; // One provider per tick, no concurrent UI actions.
    }
  }
}
