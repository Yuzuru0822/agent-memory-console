import fs from "node:fs";
import path from "node:path";
import type { TaskCenterSnapshot, TaskControls, TaskItem, TaskIssue, TaskReportKind, TaskRuntime, TaskSources, TaskState } from "../src/task-types";
import { ConsoleService } from "./service";
import { atomicWrite, noLinks } from "./safety";
import { rewardDefinitions } from "./rewards-adapters";
import { nextRewardWindow, rewardWindow } from "./rewards-service";

interface StoredControls { version: 1; paused: boolean; pausedAt?: string; pauseUntil?: string; closeToTray: boolean }
const defaults = (): StoredControls => ({ version: 1, paused: false, closeToTray: false });
const validTime = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const at = (value: number) => new Date(value).toISOString();
const safeTime = (value?: string) => validTime(value) ? value : undefined;
const future = (value: string | undefined, now: number) => !!value && validTime(value) && Date.parse(value) > now;

function validate(value: unknown): StoredControls {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("任务控制配置格式无效");
  const s = value as StoredControls;
  if (Object.keys(s).some(key => !["version", "paused", "pausedAt", "pauseUntil", "closeToTray"].includes(key)) ||
      s.version !== 1 || typeof s.paused !== "boolean" || typeof s.closeToTray !== "boolean" ||
      s.pausedAt !== undefined && !validTime(s.pausedAt) || s.pauseUntil !== undefined && !validTime(s.pauseUntil) ||
      s.paused && !s.pausedAt || !s.paused && (s.pausedAt !== undefined || s.pauseUntil !== undefined) ||
      s.pauseUntil !== undefined && ![15 * 60000, 60 * 60000].includes(Date.parse(s.pauseUntil) - Date.parse(s.pausedAt!)))
    throw new Error("任务控制配置格式无效");
  return { version: 1, paused: s.paused, closeToTray: s.closeToTray,
    ...(s.pausedAt ? { pausedAt: s.pausedAt } : {}), ...(s.pauseUntil ? { pauseUntil: s.pauseUntil } : {}) };
}

/** Escape spreadsheet formulas even after leading whitespace, tabs and control characters. */
function csvCell(value: string | number | boolean | undefined): string {
  if (value === undefined) return '""';
  let text = String(value);
  if (typeof value === "string" && /^[\s\u0000-\u001f]*[=+\-@]/u.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}
function csv(rows: (string | number | boolean | undefined)[][]): string {
  return rows.map(row => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

export class TaskCenterService {
  private data = defaults();
  private error?: string;
  private readonly file: string;
  constructor(readonly console: ConsoleService, readonly now: () => number = Date.now) {
    this.file = path.join(console.storage, "task-controls.json");
    try {
      noLinks(this.file);
      if (!fs.existsSync(this.file)) return;
      const stat = fs.statSync(this.file);
      if (!stat.isFile() || stat.size > 8192) throw new Error("任务控制配置文件超出限制");
      const bytes = fs.readFileSync(this.file);
      if (bytes.length > 8192) throw new Error("任务控制配置文件超出限制");
      this.data = validate(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
    } catch {
      this.failClosed("任务控制配置无法读取，自动任务已暂停；确认恢复后将重建默认控制设置。");
    }
  }
  private failClosed(message: string) {
    this.data = { version: 1, paused: true, pausedAt: at(this.now()), closeToTray: false };
    this.error = message;
  }
  private validAudit() { try { return this.console.verifyAudit().valid; } catch { return false; } }
  private writable() { if (!this.validAudit()) throw new Error("活动台账校验失败，不能恢复自动任务或开启托盘常驻"); }
  private save(next: StoredControls) {
    try { atomicWrite(this.file, JSON.stringify(validate(next), null, 2)); }
    catch {
      this.failClosed("任务控制配置保存失败，自动任务保持暂停；请检查控制台数据目录后重新恢复。");
      throw new Error(this.error);
    }
    this.data = next; this.error = undefined;
  }
  private log(action: string, detail: string) {
    // Safety stops must still work when the audit chain is damaged or unwritable.
    try { if (this.validAudit()) this.console.audit(`tasks.${action}`, detail); } catch { /* Preserve the safer control state. */ }
  }
  controls(): TaskControls {
    const paused = !!this.error || this.data.paused && (!this.data.pauseUntil || Date.parse(this.data.pauseUntil) > this.now());
    return { paused, closeToTray: this.data.closeToTray,
      ...(paused ? { pausedAt: this.data.pausedAt, pauseUntil: this.data.pauseUntil } : {}),
      ...(this.error ? { error: this.error } : {}) };
  }
  pause(minutes: 15 | 60 | null): void {
    if (minutes !== null && minutes !== 15 && minutes !== 60) throw new Error("暂停时间只能为 15、60 分钟或直到手动恢复");
    const now = this.now();
    // A corrupt configuration remains stopped until an explicit recovery.
    if (this.error) return;
    this.save({ version: 1, paused: true, pausedAt: at(now), ...(minutes === null ? {} : { pauseUntil: at(now + minutes * 60000) }), closeToTray: this.data.closeToTray });
    this.log("pause", minutes === null ? "已暂停自动任务，等待手动恢复" : `已暂停自动任务 ${minutes} 分钟`);
  }
  resume(): void {
    this.writable();
    this.save({ version: 1, paused: false, closeToTray: this.error ? false : this.data.closeToTray });
    this.log("resume", "已恢复自动任务调度；各任务原有开关和授权保持不变");
  }
  setCloseToTray(enabled: boolean): void {
    if (typeof enabled !== "boolean") throw new Error("托盘设置无效");
    if (enabled) { this.writable(); if (this.error) throw new Error("请先恢复损坏的任务控制配置"); }
    if (this.error && !enabled) return;
    this.save({ ...this.data, closeToTray: enabled });
    this.log("tray", enabled ? "关闭窗口时保留托盘运行" : "关闭窗口时正常退出");
  }
  canRunAutomatic(): boolean { return !this.controls().paused; }

  snapshot(sources: TaskSources, runtime: TaskRuntime): TaskCenterSnapshot {
    const now = this.now(), controls = this.controls(), tasks: TaskItem[] = [], issues: TaskIssue[] = [];
    const addIssue = (issue: TaskIssue) => { if (!issues.some(entry => entry.id === issue.id)) issues.push(issue); };
    const common = (ui: boolean, next?: string): { state: TaskState; message: string } | undefined => {
      if (controls.paused) return { state: "paused", message: controls.error || (controls.pauseUntil ? `全部自动任务暂停至 ${controls.pauseUntil}` : "全部自动任务已暂停，等待手动恢复") };
      if (!sources.auditValid) return { state: "attention", message: "活动台账校验失败，自动操作已阻止" };
      if (ui && future(runtime.calibrationUntil, now)) return { state: "waiting", message: "正在校准客户端，暂缓后台界面操作" };
      if (runtime.busy) return { state: "waiting", message: "另一项本地操作进行中，等待串行执行" };
      if (future(next, now)) return { state: "scheduled", message: "等待下次计划检查" };
      return undefined;
    };
    if (controls.error) addIssue({ id: "task-controls", severity: "error", title: "自动任务控制配置需要恢复", detail: controls.error, target: "repository" });
    if (!sources.auditValid) addIssue({ id: "audit", severity: "error", title: "活动台账校验失败", detail: "保留本地数据并检查台账；自动写入与客户端操作已受阻。", target: "repository" });
    const repo = sources.repository;
    if (repo.issue || repo.error) {
      const issue = repo.issue || "error";
      addIssue({ id: `repository:${issue}`, severity: issue === "error" ? "error" : "warning", title: issue === "conflict" ? "同步冲突需要处理" : issue === "grant" ? "同步授权范围已变化" : "仓库自动任务异常",
        detail: issue === "conflict" ? "请打开统一仓库预览并解决冲突；双方内容已保留。" : issue === "grant" ? "请核对纳管目录后重新启用自动同步。" : repo.error || repo.lastMessage || "请打开统一仓库检查最近任务结果。", target: "repository" });
    }
    for (const kind of ["sync", "cleanup"] as const) {
      const enabled = kind === "sync" ? repo.syncEnabled : repo.cleanupEnabled;
      let result: { state: TaskState; message: string };
      // RepositoryService shares one in-flight lock; cleanup itself is synchronous.
      if (repo.running && kind === "sync") result = { state: "running", message: "仓库操作正在执行；暂停不会中断已开始的操作" };
      else if (!repo.configured) result = { state: "unconfigured", message: "请先配置独立记忆与技能仓库" };
      else if (!enabled) result = { state: "disabled", message: "此自动任务未开启" };
      else if (controls.paused || !sources.auditValid) result = common(false)!;
      else if (repo.issue || repo.error) result = { state: "attention", message: kind === "cleanup" ? "请先处理仓库任务异常，清理与同步共用调度" : repo.lastMessage || repo.error || "仓库任务需要处理" };
      else if (future(repo.previewUntil, now)) result = { state: "waiting", message: "预览仍在有效期内，等待完成或关闭预览" };
      else result = common(false, repo.nextCheck) || { state: "waiting", message: "已到检查时间，等待下一轮调度" };
      tasks.push({ id: `repository:${kind}`, kind, name: kind === "sync" ? "仓库双向同步" : "过期备份与临时文件清理", enabled, ...result, lastAttempt: safeTime(repo.lastRun), nextCheck: enabled ? safeTime(repo.nextCheck) : undefined, target: "repository" });
    }
    for (const definition of rewardDefinitions) {
      const reward = sources.rewards.providers.find(p => p.id === definition.id), profile = reward?.profile;
      const enabled = !!profile?.enabled, configured = !!profile?.claim && !!profile.windowTitle && !!profile.context.length && !!profile.successTexts.length;
      const resetHour = profile?.resetHour ?? definition.resetHour;
      const completed = !!reward && ["claimed", "already_claimed"].includes(reward.state) && !!reward.lastSuccess && validTime(reward.lastSuccess) && Date.parse(reward.lastSuccess) <= now && rewardWindow(Date.parse(reward.lastSuccess), resetHour) === rewardWindow(now, resetHour);
      const next = completed ? nextRewardWindow(now, resetHour) : safeTime(reward?.nextCheck);
      let result: { state: TaskState; message: string };
      if (sources.rewards.running === definition.id) result = { state: "running", message: "领取流程正在执行；暂停不会中断结果核验" };
      else if (definition.kind !== "ui") result = { state: "unsupported", message: definition.kind === "automatic" ? "由平台按规则发放，控制台不自动点击" : "尚未支持自动领取" };
      else if (reward?.state === "unknown") result = { state: "attention", message: "上次领取结果未知；请到客户端核对后重新校准，不能直接重试" };
      else if (!configured || !profile?.validated) result = { state: "unconfigured", message: "请完成领取流程校准与成功试领" };
      else if (!enabled) result = { state: "disabled", message: "此平台自动领取未开启" };
      else if (controls.paused || !sources.auditValid || future(runtime.calibrationUntil, now) || runtime.busy) result = common(true)!;
      else if (!sources.rewards.nativeAvailable) result = { state: "attention", message: "Windows 客户端自动化组件不可用" };
      else if (reward?.state === "needs_attention") result = { state: "attention", message: reward.lastMessage || "领取执行前遇到问题，请检查客户端" };
      else if (completed) result = { state: "scheduled", message: "本领取周期已完成，等待下个周期" };
      else result = common(true, next) || { state: "waiting", message: "已到检查时间，等待下一轮调度" };
      tasks.push({ id: `claim:${definition.id}`, kind: "claim", name: `${definition.name} 自动领取`, providerId: definition.id, enabled, ...result, lastAttempt: safeTime(reward?.lastAttempt), nextCheck: enabled ? next : undefined, target: "rewards" });
      if (reward && ["unknown", "needs_attention"].includes(reward.state)) addIssue({ id: `claim:${definition.id}:${reward.state}`, severity: reward.state === "unknown" ? "error" : "warning", title: `${definition.name} ${reward.state === "unknown" ? "领取结果未知" : "领取需要检查"}`,
        detail: reward.state === "unknown" ? "自动领取已暂停。先在客户端核对本次结果，再重新校准；恢复总开关不会重试此领取。" : reward.lastMessage || "请打开积分福利检查客户端与已保存流程。", target: "rewards", providerId: definition.id });
    }
    for (const definition of rewardDefinitions) {
      const balance = sources.balances.providers.find(p => p.id === definition.id), profile = balance?.profile;
      const configured = !!profile?.selector && !!profile.windowTitle, enabled = !!profile?.enabled;
      let result: { state: TaskState; message: string };
      if (sources.balances.running === definition.id) result = { state: "running", message: "正在读取余额；暂停不丢弃本次读取结果" };
      else if (!configured) result = { state: "unconfigured", message: "请绑定客户端并选择明确的余额字段" };
      else if (!enabled) result = { state: "disabled", message: "此平台定时余额监控未开启" };
      else if (controls.paused || !sources.auditValid || future(runtime.calibrationUntil, now) || runtime.busy) result = common(true)!;
      else if (!sources.balances.nativeAvailable) result = { state: "attention", message: "Windows 客户端自动化组件不可用" };
      else if (balance?.status === "error") result = { state: "attention", message: balance.error || "余额读取失败，保留上次数值等待后续检查" };
      else result = common(true, balance?.nextCheck) || { state: "waiting", message: "已到读取时间，等待下一轮调度" };
      tasks.push({ id: `balance:${definition.id}`, kind: "balance", name: `${definition.name} 余额监控`, providerId: definition.id, enabled, ...result, lastAttempt: safeTime(balance?.lastAttempt), nextCheck: enabled ? safeTime(balance?.nextCheck) : undefined, target: "rewards" });
      if (!configured || !balance) continue;
      if (balance.status === "error") addIssue({ id: `balance:${definition.id}:error`, severity: "warning", title: `${definition.name} 余额读取失败`, detail: balance.error || "旧数值不代表当前余额，请检查客户端后重新读取。", target: "rewards", providerId: definition.id });
      else if (balance.stale && balance.sample) addIssue({ id: `balance:${definition.id}:stale`, severity: "warning", title: `${definition.name} 余额已过期`, detail: "上次采样已超过读取周期，旧数值不代表当前余额。", target: "rewards", providerId: definition.id });
      else if (balance.low && !balance.stale && balance.sample) addIssue({ id: `balance:${definition.id}:low`, severity: "warning", title: `${definition.name} 余额偏低`, detail: "最新余额已达到或低于你设置的提醒阈值。", target: "rewards", providerId: definition.id });
    }
    return { at: at(now), controls, runtime: { ...runtime }, tasks, issues };
  }

  report(kind: TaskReportKind, sources: TaskSources, runtime: TaskRuntime): string {
    if (kind === "tasks") {
      const snapshot = this.snapshot(sources, runtime);
      return csv([["task_id", "kind", "name", "state", "enabled", "last_attempt", "next_check", "exported_at"],
        ...snapshot.tasks.map(task => [task.id, task.kind, task.name, task.state, task.enabled, task.lastAttempt, task.nextCheck, snapshot.at])]);
    }
    if (kind === "balances") {
      const rows: (string | number | boolean | undefined)[][] = [["provider_id", "provider", "unit", "value", "delta", "reason", "sampled_at"]];
      for (const definition of rewardDefinitions) {
        const balance = sources.balances.providers.find(p => p.id === definition.id);
        for (const sample of balance?.history || []) rows.push([definition.id, definition.name, sample.unit, sample.value, sample.delta, sample.reason, sample.at]);
      }
      return csv(rows);
    }
    throw new Error("不支持的报表类型");
  }
}
