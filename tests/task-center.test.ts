import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { TaskCenterService } from "../electron/task-center";
import { rewardDefinitions } from "../electron/rewards-adapters";
import type { TaskSources, TaskRuntime } from "../src/task-types";
import type { RewardProfile, RewardView } from "../src/rewards-types";
import type { BalanceProfile } from "../src/rewards-balance-types";
import { fixture } from "./helpers";

const initial = Date.parse("2026-10-24T02:01:00.000Z");
const runtime: TaskRuntime = { busy: false, trayAvailable: true, windowVisible: true };
const iso = (ms: number) => new Date(ms).toISOString();
function setup(t: TestContext) {
  const f = fixture(t); let now = initial;
  const tasks = new TaskCenterService(f.service, () => now);
  return { ...f, tasks, now: () => now, advance: (ms: number) => { now += ms; }, restart: () => new TaskCenterService(f.service, () => now) };
}
const claim = (overrides: Partial<RewardProfile> = {}): RewardProfile => ({ executable: "C:\\private\\Client.exe", executableHash: "a".repeat(64), windowTitle: "private account", navigation: [], claim: { name: "private claim selector", automationId: "claim", controlType: "Button" }, context: ["private activity"], successTexts: ["already claimed"], resetHour: 10, enabled: true, validated: true, ...overrides });
const balanceProfile = (overrides: Partial<BalanceProfile> = {}): BalanceProfile => ({ executable: "C:\\private\\Client.exe", executableHash: "a".repeat(64), windowTitle: "private account", navigation: [], selector: { label: "private balance selector", prefix: "余额 ", suffix: "", automationId: "balance", controlType: "Text", layout: "inline" }, unit: "Credits", intervalMinutes: 15, enabled: true, ...overrides });
function sources(): TaskSources {
  return { auditValid: true, repository: { configured: false, syncEnabled: false, cleanupEnabled: false, running: false, intervalSeconds: 60 },
    rewards: { providers: rewardDefinitions.map(d => ({ ...d, state: d.kind === "ui" ? "needs_setup" : "unsupported" })), logs: [], nativeAvailable: true },
    balances: { providers: rewardDefinitions.map(d => ({ id: d.id, status: "unconfigured", history: [], stale: true, low: false })), nativeAvailable: true } };
}
function configuredSources(): TaskSources {
  const source = sources(); source.repository = { configured: true, syncEnabled: true, cleanupEnabled: true, running: false, intervalSeconds: 60, nextCheck: iso(initial + 60000), lastMessage: "private repository message" };
  source.rewards.providers[0] = { ...source.rewards.providers[0], state: "ready", profile: claim(), nextCheck: iso(initial + 60000), lastMessage: "private reward message" };
  source.balances.providers[0] = { id: "qoder", profile: balanceProfile(), status: "ok", sample: { at: iso(initial), value: 50, unit: "Credits", reason: "manual" }, history: [{ at: iso(initial), value: 50, unit: "Credits", reason: "manual" }], stale: false, low: false, nextCheck: iso(initial + 900000) };
  return source;
}
const item = (tasks: TaskCenterService, source: TaskSources, id: string, r = runtime) => tasks.snapshot(source, r).tasks.find(t => t.id === id)!;

test("controls default to foreground behavior without creating a configuration file", t => {
  const f = setup(t); assert.deepEqual(f.tasks.controls(), { paused: false, closeToTray: false }); assert.equal(f.tasks.canRunAutomatic(), true);
  assert.equal(fs.existsSync(path.join(f.service.storage, "task-controls.json")), false);
  assert.equal(f.tasks.snapshot(sources(), runtime).tasks.length, 20);
  assert.equal(f.tasks.snapshot(sources(), runtime).issues.length, 0);
});

test("timed pause persists across restarts and expires exactly at its deadline", t => {
  const f = setup(t); f.tasks.pause(15); assert.equal(f.tasks.controls().pauseUntil, iso(initial + 900000));
  let restarted = f.restart(); assert.equal(restarted.canRunAutomatic(), false);
  f.advance(899999); assert.equal(restarted.canRunAutomatic(), false);
  f.advance(1); assert.deepEqual(restarted.controls(), { paused: false, closeToTray: false }); assert.equal(f.restart().canRunAutomatic(), true);
  f.tasks.pause(60); assert.equal(f.tasks.controls().pauseUntil, iso(f.now() + 3600000));
});

test("indefinite pause persists, resume preserves individual configuration and tray choice", t => {
  const f = setup(t), before = JSON.stringify(f.service.config); f.tasks.setCloseToTray(true); f.tasks.pause(null);
  f.advance(10 * 86400000); const restarted = f.restart(); assert.equal(restarted.canRunAutomatic(), false); assert.equal(restarted.controls().pauseUntil, undefined);
  restarted.resume(); assert.deepEqual(f.restart().controls(), { paused: false, closeToTray: true }); assert.equal(JSON.stringify(f.service.config), before);
});

test("invalid pause arguments and tray settings do not change existing controls", t => {
  const f = setup(t); for (const input of [0, 1, 14, 16, 59, 61, -15, NaN, Infinity, "15", undefined]) assert.throws(() => f.tasks.pause(input as 15), /暂停时间/);
  assert.throws(() => f.tasks.setCloseToTray(1 as unknown as boolean), /无效/); assert.equal(f.tasks.canRunAutomatic(), true);
});

test("malformed, oversized, noncanonical and unexpected fields fail closed until explicit resume", t => {
  const f = setup(t), valid = { version: 1, paused: false, closeToTray: true };
  const cases = ["{", "[]", "null", "x".repeat(8193), JSON.stringify({ ...valid, surprise: true }), JSON.stringify({ ...valid, version: 2 }), JSON.stringify({ ...valid, closeToTray: 1 }), JSON.stringify({ ...valid, paused: true }), JSON.stringify({ ...valid, pausedAt: iso(initial) }), JSON.stringify({ ...valid, paused: true, pausedAt: "2026-10-24" }), JSON.stringify({ ...valid, paused: true, pausedAt: iso(initial), pauseUntil: iso(initial + 1000) })];
  for (const content of cases) {
    f.file("storage/task-controls.json", content); const service = f.restart(); assert.equal(service.canRunAutomatic(), false); assert.equal(service.controls().closeToTray, false); assert.ok(service.controls().error);
    service.pause(15); f.advance(16 * 60000); assert.equal(service.canRunAutomatic(), false, "corrupt controls cannot become a timed auto-resume");
    service.resume(); assert.deepEqual(f.restart().controls(), { paused: false, closeToTray: false });
  }
});

test("audit failure allows safe pause and tray disabling, but blocks resume and tray enabling", t => {
  const f = setup(t); f.tasks.setCloseToTray(true); f.file("storage/activity.jsonl", "not-json\n");
  f.tasks.pause(null); f.tasks.setCloseToTray(false); assert.equal(f.tasks.canRunAutomatic(), false); assert.equal(f.tasks.controls().closeToTray, false);
  assert.throws(() => f.tasks.resume(), /台账/); assert.throws(() => f.tasks.setCloseToTray(true), /台账/);
  assert.equal(f.restart().canRunAutomatic(), false);
});

test("control paths containing junctions are rejected and never overwrite their target", t => {
  const f = setup(t), target = f.dir("external-control"), sentinel = f.file("external-control/keep.txt", "keep");
  fs.symlinkSync(target, path.join(f.service.storage, "task-controls.json"), "junction"); const blocked = f.restart();
  assert.equal(blocked.canRunAutomatic(), false); assert.throws(() => blocked.resume(), /保存失败/); assert.equal(fs.readFileSync(sentinel, "utf8"), "keep");
});

test("a failed control write enters a safe in-memory pause", t => {
  const f = setup(t); fs.mkdirSync(path.join(f.service.storage, "task-controls.json"));
  assert.throws(() => f.tasks.pause(15), /保存失败/); assert.equal(f.tasks.canRunAutomatic(), false); assert.equal(f.tasks.controls().closeToTray, false);
});

test("aggregation always has two repository, nine claim and nine balance rows", t => {
  const f = setup(t), source = sources(), snapshot = f.tasks.snapshot(source, runtime);
  assert.equal(snapshot.tasks.filter(t => t.kind === "sync").length, 1); assert.equal(snapshot.tasks.filter(t => t.kind === "cleanup").length, 1);
  assert.equal(snapshot.tasks.filter(t => t.kind === "claim").length, 9); assert.equal(snapshot.tasks.filter(t => t.kind === "balance").length, 9);
  assert.equal(item(f.tasks, source, "claim:qwen").state, "unsupported"); assert.equal(item(f.tasks, source, "balance:qwen").state, "unconfigured");
  source.balances.providers.find(p => p.id === "qwen")!.profile = balanceProfile();
  assert.equal(item(f.tasks, source, "balance:qwen").state, "waiting", "unsupported claims do not disable a separately configured balance");
});

test("global pause preserves unsupported, unconfigured, disabled and already running states", t => {
  const f = setup(t), source = configuredSources(); source.balances.providers[0].profile!.enabled = false; f.tasks.pause(null);
  assert.equal(item(f.tasks, source, "repository:sync").state, "paused"); assert.equal(item(f.tasks, source, "claim:qoder").state, "paused");
  assert.equal(item(f.tasks, source, "balance:qoder").state, "disabled"); assert.equal(item(f.tasks, source, "claim:qwen").state, "unsupported"); assert.equal(item(f.tasks, source, "balance:qwen").state, "unconfigured");
  source.rewards.running = "qoder"; source.repository.running = true; source.balances.running = "qwen";
  assert.equal(item(f.tasks, source, "claim:qoder").state, "running"); assert.equal(item(f.tasks, source, "repository:sync").state, "running"); assert.equal(item(f.tasks, source, "balance:qwen").state, "running");
});

test("calibration pauses only client UI tasks and active repository previews postpone both repository tasks", t => {
  const f = setup(t), source = configuredSources(), calibrating = { ...runtime, calibrationUntil: iso(initial + 60000) };
  assert.equal(item(f.tasks, source, "claim:qoder", calibrating).state, "waiting"); assert.match(item(f.tasks, source, "balance:qoder", calibrating).message, /校准/);
  assert.equal(item(f.tasks, source, "repository:sync", calibrating).state, "scheduled"); source.repository.previewUntil = iso(initial + 300000);
  assert.match(item(f.tasks, source, "repository:sync").message, /预览/); assert.match(item(f.tasks, source, "repository:cleanup").message, /预览/);
  assert.equal(item(f.tasks, source, "claim:qoder", { ...runtime, calibrationUntil: iso(initial) }).state, "scheduled");
});

test("busy, due and future scheduled work are distinguished without changing source data", t => {
  const f = setup(t), source = configuredSources(), before = structuredClone(source);
  assert.equal(item(f.tasks, source, "claim:qoder").state, "scheduled"); assert.equal(item(f.tasks, source, "claim:qoder", { ...runtime, busy: true }).state, "waiting");
  f.advance(60000); assert.equal(item(f.tasks, source, "claim:qoder").state, "waiting"); assert.equal(item(f.tasks, source, "repository:sync").state, "waiting");
  assert.deepEqual(source, before);
});

test("a successful claim is complete only in the matching UTC+8 reward window", t => {
  const f = setup(t), source = configuredSources(), p = source.rewards.providers[0]; p.state = "claimed"; p.lastSuccess = iso(initial - 30000); p.nextCheck = undefined;
  assert.match(item(f.tasks, source, "claim:qoder").message, /本领取周期已完成/); assert.equal(item(f.tasks, source, "claim:qoder").nextCheck, "2026-10-25T02:00:00.000Z");
  p.lastSuccess = "2026-10-24T01:59:59.999Z"; assert.equal(item(f.tasks, source, "claim:qoder").state, "waiting");
  p.lastSuccess = "2026-10-24T02:00:00.000Z"; assert.equal(item(f.tasks, source, "claim:qoder").state, "scheduled");
  f.advance(86400000); assert.equal(item(f.tasks, source, "claim:qoder").state, "waiting", "yesterday claimed must not suppress today's task");
});

test("unknown claims remain attention after total pause and resume without re-enabling the platform", t => {
  const f = setup(t), source = configuredSources(), reward = source.rewards.providers[0]; reward.state = "unknown"; reward.profile!.enabled = false; reward.profile!.validated = false;
  f.tasks.pause(null); assert.equal(item(f.tasks, source, "claim:qoder").state, "attention"); f.tasks.resume();
  assert.equal(item(f.tasks, source, "claim:qoder").state, "attention"); assert.equal(reward.profile!.enabled, false);
  const issue = f.tasks.snapshot(source, runtime).issues.find(i => i.id === "claim:qoder:unknown")!; assert.equal(issue.severity, "error"); assert.match(issue.detail, /不会重试/);
});

test("stable issues distinguish audit, repository, failed claims, low balance and stale values", t => {
  const f = setup(t), source = configuredSources(); source.auditValid = false; source.repository.issue = "grant"; source.repository.syncEnabled = false; source.rewards.providers[0].state = "needs_attention";
  source.balances.providers[0].low = true; let snapshot = f.tasks.snapshot(source, runtime);
  assert.deepEqual(snapshot.issues.map(i => i.id), ["audit", "repository:grant", "claim:qoder:needs_attention", "balance:qoder:low"]);
  assert.equal(item(f.tasks, source, "repository:sync").state, "disabled"); assert.equal(item(f.tasks, source, "balance:qoder").state, "attention");
  source.balances.providers[0].stale = true; snapshot = f.tasks.snapshot(source, runtime);
  assert.ok(snapshot.issues.some(i => i.id === "balance:qoder:stale")); assert.ok(!snapshot.issues.some(i => i.id === "balance:qoder:low"));
  source.balances.providers[0].status = "error"; source.balances.providers[0].error = "old balance";
  snapshot = f.tasks.snapshot(source, runtime); assert.ok(snapshot.issues.some(i => i.id === "balance:qoder:error")); assert.ok(!snapshot.issues.some(i => i.id.endsWith(":stale")));
  delete source.balances.providers[0].profile!.selector; assert.ok(!f.tasks.snapshot(source, runtime).issues.some(i => i.id.startsWith("balance:qoder:")));
});

test("native unavailability and retryable errors appear without discarding next-attempt times", t => {
  const f = setup(t), source = configuredSources(); source.rewards.nativeAvailable = false; source.balances.nativeAvailable = false;
  assert.equal(item(f.tasks, source, "claim:qoder").state, "attention"); assert.equal(item(f.tasks, source, "balance:qoder").state, "attention");
  source.rewards.nativeAvailable = true; source.balances.nativeAvailable = true; source.rewards.providers[0].state = "needs_attention";
  source.balances.providers[0].status = "error"; source.balances.providers[0].error = "unavailable";
  assert.equal(item(f.tasks, source, "claim:qoder").nextCheck, iso(initial + 60000)); assert.equal(item(f.tasks, source, "balance:qoder").nextCheck, iso(initial + 900000));
});

test("task CSV exports only fixed status fields and excludes private messages and selector/path data", t => {
  const f = setup(t), source = configuredSources(); source.rewards.providers[0].name = "=untrusted source name";
  const report = f.tasks.report("tasks", source, runtime); assert.equal(report.split("\r\n").filter(Boolean).length, 21);
  assert.match(report, /"Qoder 国际版 自动领取"/); assert.doesNotMatch(report, /private|untrusted|executable|windowTitle|selector|message/);
  assert.throws(() => f.tasks.report("secret" as "tasks", source, runtime), /不支持/);
});

test("balance CSV includes all retained samples without unit aggregation or invented income", t => {
  const f = setup(t), source = configuredSources(); source.balances.providers[0].history = Array.from({ length: 100 }, (_, i) => ({ at: iso(initial + i), value: i, delta: i ? -1 : undefined, unit: "Credits", reason: "scheduled" }));
  source.balances.providers[1].history = [{ at: iso(initial), value: 0, delta: 0, unit: "CNY", reason: "after_claim" }];
  const report = f.tasks.report("balances", source, runtime); assert.equal(report.split("\r\n").filter(Boolean).length, 102);
  assert.match(report, /"Credits","99","-1","scheduled"/); assert.match(report, /"CNY","0","0","after_claim"/);
  assert.doesNotMatch(report, /private|total|income|收益|合计/);
});

test("CSV quotes commas/newlines and neutralizes formula prefixes in string cells", t => {
  const f = setup(t), source = configuredSources(); const sample = source.balances.providers[0].history[0];
  sample.unit = " \t=HYPERLINK(\"secret\")" as typeof sample.unit; sample.reason = "@formula,\nnext" as typeof sample.reason;
  const report = f.tasks.report("balances", source, runtime); assert.ok(report.includes('"\' \t=HYPERLINK(""secret"")"')); assert.ok(report.includes('"\'@formula,\nnext"'));
});
