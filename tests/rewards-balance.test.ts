import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { RewardsBalanceService, parseBalanceNumber } from "../electron/rewards-balance";
import type { RewardsBridge } from "../electron/rewards-service";
import type { RewardElement, RewardId, RewardSelector } from "../src/rewards-types";
import { fixture, peFixture } from "./helpers";

// All client windows and invocations are in-memory fixtures. No Windows UIA,
// third-party process, account, credential or real claim is accessed here.
type View = { title: string; elements: RewardElement[] };
const title = "Balance Fixture";
const text = (index: number, name: string, parentIndex?: number, automationId = ""): RewardElement => ({ index, name, parentIndex, automationId, controlType: "Text", enabled: true, actionable: false });
const container = (index: number, controlType = "Pane", parentIndex?: number): RewardElement => ({ ...text(index, "", parentIndex), controlType });
const button = (index: number, name: string, automationId = "menu"): RewardElement => ({ ...text(index, name, undefined, automationId), controlType: "Button", actionable: true });
const inline = (value = "1,234.50"): View => ({ title, elements: [text(5, `可用积分余额：${value} 积分`, undefined, "balance")] });
const siblings = (value = "1234.50"): View => ({ title, elements: [container(0, "Window"), container(1, "Pane", 0), text(2, "剩余积分", 1, "label"), text(3, value, 1, "amount"), text(4, "42", 0, "notifications")] });
const home = (): View => ({ title, elements: [button(7, "账户详情")] });

class FakeBridge implements RewardsBridge {
  current = inline();
  availableValue = true;
  inspections = 0;
  invocations: RewardSelector[] = [];
  onInspect?: () => Promise<View> | View;
  onInvoke?: () => Promise<void> | void;
  available() { return this.availableValue; }
  async inspect() { this.inspections++; return structuredClone(this.onInspect ? await this.onInspect() : this.current); }
  async invoke(_exe: string, _title: string, selector: RewardSelector) { this.invocations.push(structuredClone(selector)); if (this.onInvoke) await this.onInvoke(); else this.current = inline(); }
}
function setup(t: TestContext) {
  const f = fixture(t), bridge = new FakeBridge(), executable = f.file("client/Client.exe", peFixture());
  let now = Date.parse("2026-10-24T02:01:00.000Z");
  const balances = new RewardsBalanceService(f.service, bridge, () => now, async () => {});
  return { ...f, bridge, executable, balances, now: () => now, advance: (ms: number) => { now += ms; }, restart: () => new RewardsBalanceService(f.service, bridge, () => now, async () => {}) };
}
type Setup = ReturnType<typeof setup>;
const provider = (f: Setup, id: RewardId = "qoder") => f.balances.snapshot().providers.find(p => p.id === id)!;
async function configured(f: Setup, id: RewardId = "qoder", separated = false) {
  f.balances.bind(id, f.executable); f.bridge.current = separated ? siblings() : inline();
  const o = await f.balances.inspect(id); f.balances.configure(id, o.token, separated ? 2 : 5, separated ? 3 : 5, "积分", 15, 100);
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }

test("balance parser accepts exact zero, decimal and consistent thousands separators", () => {
  const cases: [string, number][] = [["0", 0], ["0.25", 0.25], ["1,234.50", 1234.5], ["1 234 567.89", 1234567.89], ["Available balance: $9,876.50", 9876.5], ["剩余 100 积分", 100], ["余额：0.00", 0], ["9\u202f876.50", 9876.5]];
  for (const [input, expected] of cases) assert.equal(parseBalanceNumber(input)?.value, expected, input);
});

test("balance parser rejects ambiguous, signed, scaled, date, ratio and malformed amounts", () => {
  const cases = ["", "NaN", "Infinity", "1e3", "-1", "−1", "+1", "10%", "100 / 200", "2026-10-24", "2026/10/24", "剩余 30 天", "Remaining 30 days", "Available until 2026", "剩余 100，已用 20", "10,00", "1 23", "1,234 567", "1.000,50", "1.2.3", ".5", "100.", "1k", "1M Credits", "1 million", "2万积分", "约100", "100+", "<100", "≥10", "about 100", "9007199254740992", "00", "01"];
  for (const input of cases) assert.equal(parseBalanceNumber(input), undefined, input);
});

test("all nine provider categories may bind read-only balances; no claim is invoked", async t => {
  const f = setup(t), providers = f.balances.snapshot().providers;
  assert.equal(providers.length, 9);
  for (const p of providers) { f.balances.bind(p.id, f.executable); assert.equal(f.balances.isConfigured(p.id), false); assert.equal(provider(f, p.id).profile?.enabled, false); }
  await configured(f, "qwen");
  assert.equal(provider(f, "qwen").sample?.value, 1234.5); assert.equal(f.bridge.invocations.length, 0);
  assert.throws(() => f.balances.bind("unknown" as RewardId, f.executable), /未知/);
});

test("inline balance refresh matches fixed affixes and IDs, never the old value or index", async t => {
  const f = setup(t); await configured(f);
  f.advance(1000); f.bridge.current = { title, elements: [text(99, "可用积分余额：99.25 积分", undefined, "balance")] };
  await f.balances.refresh("qoder", "after_claim");
  const p = provider(f); assert.equal(p.sample?.value, 99.25); assert.equal(p.sample?.delta, -1135.25); assert.equal(p.sample?.reason, "after_claim"); assert.equal(p.low, true); assert.equal(p.stale, false); assert.equal(p.history.length, 2); assert.equal(f.bridge.invocations.length, 0);
});

test("separate label and amount require one small parent container, and survive index changes", async t => {
  const f = setup(t); await configured(f, "qoder", true);
  f.bridge.current = { title, elements: [container(11, "Group"), text(25, "剩余积分", 11), text(41, "1 234.25", 11, "amount"), text(44, "9999", undefined, "amount")] };
  await f.balances.refresh("qoder"); assert.equal(provider(f).sample?.value, 1234.25); assert.equal(provider(f).stale, false);
});

test("separate balance refuses page-root, unrelated, missing-parent and oversized groups", async t => {
  const f = setup(t); f.balances.bind("qoder", f.executable);
  const bad: View[] = [
    { title, elements: [container(1, "Window"), text(2, "剩余积分", 1), text(3, "100", 1)] },
    { title, elements: [container(1, "Document"), text(2, "剩余积分", 1), text(3, "100", 1)] },
    { title, elements: [container(1), container(4), text(2, "剩余积分", 1), text(3, "100", 4)] },
    { title, elements: [text(2, "剩余积分", 1), text(3, "100", 1)] },
    { title, elements: [container(1), text(2, "剩余积分", 1), text(3, "100", 1), ...Array.from({ length: 11 }, (_, n) => text(n + 4, "其他", 1))] },
  ];
  for (const view of bad) { f.bridge.current = view; const o = await f.balances.inspect("qoder"); assert.throws(() => f.balances.configure("qoder", o.token, 2, 3, "积分", 15), /同一小容器/); }
  assert.equal(provider(f).sample, undefined);
});

test("unlabelled and contradictory values cannot become balance anchors", async t => {
  const f = setup(t); f.balances.bind("qoder", f.executable);
  for (const name of ["100 积分", "今日签到奖励 100 积分", "已用积分 100", "不可用余额 100", "Used balance 100"]) {
    f.bridge.current = { title, elements: [text(5, name)] }; const o = await f.balances.inspect("qoder");
    assert.throws(() => f.balances.configure("qoder", o.token, 5, 5, "积分", 15), /明确/);
  }
  f.bridge.current = siblings("已用 100"); const o = await f.balances.inspect("qoder");
  assert.throws(() => f.balances.configure("qoder", o.token, 2, 3, "积分", 15), /同一小容器/);
});

test("ambiguous duplicate balances stop calibration and later refresh without guessing", async t => {
  const f = setup(t); await configured(f); f.bridge.current.elements.push(text(6, "可用积分余额：20 积分", undefined, "balance"));
  const o = await f.balances.inspect("qoder"); assert.throws(() => f.balances.configure("qoder", o.token, 5, 5, "积分", 15), /多个匹配/);
  const result = await f.balances.refresh("qoder"); assert.match(result.message, /多个匹配/); assert.equal(provider(f).sample?.value, 1234.5); assert.equal(provider(f).stale, true); assert.equal(f.bridge.invocations.length, 0);
});

test("duplicate sibling labels and fields are ambiguous even when amounts agree", async t => {
  const f = setup(t); await configured(f, "qoder", true); f.bridge.current.elements.push(text(6, "剩余积分", 1));
  await f.balances.refresh("qoder"); assert.equal(provider(f).status, "error"); assert.match(provider(f).error || "", /多个匹配/);
});

test("zero is a valid low balance; failed reads keep history stale and never fabricate zero", async t => {
  const f = setup(t); await configured(f); f.bridge.current = inline("0"); await f.balances.refresh("qoder");
  assert.equal(provider(f).sample?.value, 0); assert.equal(provider(f).low, true);
  f.bridge.onInspect = () => { throw new Error("Windows 桌面已锁定"); }; f.advance(1000);
  await f.balances.refresh("qoder"); const p = provider(f);
  assert.equal(p.sample?.value, 0); assert.equal(p.history.length, 2); assert.equal(p.low, false); assert.equal(p.stale, true); assert.equal(p.status, "error");
  assert.match(p.error || "", /锁定/);
  f.bridge.onInspect = undefined; f.bridge.current = inline("12"); await f.balances.refresh("qoder");
  assert.equal(provider(f).sample?.value, 12); assert.equal(provider(f).low, true); assert.equal(provider(f).error, undefined);
});

test("freshness expires, errors do not enable monitoring, and first enable needs a real observation", async t => {
  const f = setup(t); f.balances.bind("qoder", f.executable); assert.throws(() => f.balances.automation("qoder", true), /先成功读取/);
  await configured(f); f.bridge.current = inline("5"); await f.balances.refresh("qoder"); assert.equal(provider(f).low, true);
  f.advance(15 * 60000 + 1); assert.equal(provider(f).stale, true); assert.equal(provider(f).low, false); assert.throws(() => f.balances.automation("qoder", true), /先成功读取/);
  await f.balances.refresh("qoder"); f.balances.automation("qoder", true); assert.equal(provider(f).profile?.enabled, true);
});

test("expired, replaced, cross-provider and changed-profile observations are rejected", async t => {
  const f = setup(t); f.balances.bind("qoder", f.executable); f.balances.bind("qwen", f.executable);
  let o = await f.balances.inspect("qoder"); f.advance(60_001); assert.throws(() => f.balances.configure("qoder", o.token, 5, 5, "积分", 15), /过期/);
  o = await f.balances.inspect("qoder"); await f.balances.inspect("qoder"); assert.throws(() => f.balances.configure("qoder", o.token, 5, 5, "积分", 15), /过期/);
  o = await f.balances.inspect("qoder"); assert.throws(() => f.balances.configure("qwen", o.token, 5, 5, "积分", 15), /过期/);
  await configured(f); o = await f.balances.inspect("qoder"); f.balances.automation("qoder", true); assert.throws(() => f.balances.configure("qoder", o.token, 5, 5, "积分", 15), /过期/);
});

test("navigation refuses all claiming, spending, account and security controls", async t => {
  const f = setup(t); f.balances.bind("qoder", f.executable);
  for (const name of ["领取", "签到", "Claim", "Check in", "使用重置卡", "兑换积分", "充值", "登录", "Sign in", "Privacy", "发送", "邀请好友", "升级套餐"]) {
    f.bridge.current = { title, elements: [button(7, name)] }; const o = await f.balances.inspect("qoder"); await assert.rejects(f.balances.navigate("qoder", o.token, 7), /仅允许/);
  }
  f.bridge.current = { title, elements: [button(7, "继续", "claim-bonus")] }; const o = await f.balances.inspect("qoder"); await assert.rejects(f.balances.navigate("qoder", o.token, 7), /仅允许/);
  assert.equal(f.bridge.invocations.length, 0);
});

test("the verified read-only subscription-and-usage page does not allow subscription purchases", async t => {
  const f = setup(t); f.balances.bind("workbuddy", f.executable);
  f.bridge.current = { title, elements: [button(7, "订阅和用量")] }; let o = await f.balances.inspect("workbuddy");
  await f.balances.navigate("workbuddy", o.token, 7); assert.equal(f.bridge.invocations.length, 1);
  for (const name of ["订阅", "充值", "购买", "订阅和用量：立即充值", "订阅和用量 升级套餐"]) {
    f.bridge.current = { title, elements: [button(7, name)] }; o = await f.balances.inspect("workbuddy"); await assert.rejects(f.balances.navigate("workbuddy", o.token, 7), /仅允许/);
  }
  assert.equal(f.bridge.invocations.length, 1);
});

test("recorded read-only navigation runs only when balance is not already visible", async t => {
  const f = setup(t); f.balances.bind("qoder", f.executable); f.bridge.current = home();
  let o = await f.balances.inspect("qoder"); await f.balances.navigate("qoder", o.token, 7); assert.equal(f.bridge.invocations.length, 1);
  o = await f.balances.inspect("qoder"); f.balances.configure("qoder", o.token, 5, 5, "积分", 15);
  f.bridge.invocations = []; await f.balances.refresh("qoder"); assert.equal(f.bridge.invocations.length, 0);
  f.bridge.current = home(); await f.balances.refresh("qoder"); assert.equal(f.bridge.invocations.length, 1); assert.equal(provider(f).stale, false);
});

test("navigation rechecks uniqueness and executable before invocation", async t => {
  const f = setup(t); f.balances.bind("qoder", f.executable); f.bridge.current = home(); const o = await f.balances.inspect("qoder");
  f.bridge.current.elements.push(button(8, "账户详情")); await assert.rejects(f.balances.navigate("qoder", o.token, 7), /不唯一/); assert.equal(f.bridge.invocations.length, 0);
});

test("pre-claim balance sampling never navigates away from the reward page", async t => {
  const f = setup(t); f.balances.bind("qoder", f.executable); f.bridge.current = home();
  let o = await f.balances.inspect("qoder"); await f.balances.navigate("qoder", o.token, 7);
  o = await f.balances.inspect("qoder"); f.balances.configure("qoder", o.token, 5, 5, "积分", 15);
  f.bridge.invocations = []; f.bridge.current = home();
  await f.balances.refresh("qoder", "before_claim"); assert.equal(f.bridge.invocations.length, 0); assert.equal(provider(f).stale, true); assert.equal(provider(f).history.length, 1);
  await f.balances.refresh("qoder", "after_claim"); assert.equal(f.bridge.invocations.length, 1); assert.equal(provider(f).sample?.reason, "after_claim"); assert.equal(provider(f).stale, false);
});

test("refresh resumes at the last uniquely visible navigation step in an open menu", async t => {
  const f = setup(t); f.balances.bind("qoder", f.executable); const account = button(7, "账户详情"), usage = button(8, "额度详情", "usage");
  f.bridge.current = { title, elements: [account] }; f.bridge.onInvoke = () => { f.bridge.current = { title, elements: [account, usage] }; };
  let o = await f.balances.inspect("qoder"); await f.balances.navigate("qoder", o.token, 7);
  f.bridge.onInvoke = () => { f.bridge.current = inline(); };
  o = await f.balances.inspect("qoder"); await f.balances.navigate("qoder", o.token, 8);
  o = await f.balances.inspect("qoder"); f.balances.configure("qoder", o.token, 5, 5, "积分", 15);
  f.bridge.current = { title, elements: [account, usage] }; f.bridge.invocations = [];
  await f.balances.refresh("qoder"); assert.deepEqual(f.bridge.invocations.map(s => s.name), ["额度详情"]); assert.equal(provider(f).stale, false);
});

test("unit changes, rule changes, rebinding and reset clear incompatible history and automation", async t => {
  const f = setup(t); await configured(f); await f.balances.refresh("qoder"); f.balances.automation("qoder", true);
  const o = await f.balances.inspect("qoder"); f.balances.configure("qoder", o.token, 5, 5, "Credits", 30, 10);
  assert.equal(provider(f).history.length, 1); assert.equal(provider(f).sample?.delta, undefined); assert.equal(provider(f).sample?.unit, "Credits"); assert.equal(provider(f).profile?.enabled, false);
  f.balances.bind("qoder", f.executable); assert.equal(provider(f).history.length, 0); assert.equal(f.balances.isConfigured("qoder"), false);
  await configured(f); f.balances.reset("qoder"); assert.equal(provider(f).sample, undefined); assert.equal(provider(f).profile?.navigation.length, 0); assert.equal(provider(f).profile?.enabled, false);
});

test("history is capped at 100 and changes mean observed delta, not claimed rewards", async t => {
  const f = setup(t); await configured(f);
  for (let n = 0; n < 105; n++) { f.advance(1000); f.bridge.current = inline(String(n)); await f.balances.refresh("qoder", n % 2 ? "before_claim" : "after_claim"); }
  const p = provider(f); assert.equal(p.history.length, 100); assert.equal(p.sample?.value, 104); assert.equal(p.sample?.delta, 1); assert.equal(p.history[0].value, 5);
  const stored = fs.readFileSync(path.join(f.service.storage, "balances.json"), "utf8"); assert.equal(stored.includes("elements"), false); assert.equal(stored.includes("token"), false);
  assert.equal(f.restart().snapshot().providers.find(p => p.id === "qoder")?.history.length, 100);
});

test("scheduler respects intervals, calibration pauses and fairness after provider failure", async t => {
  const f = setup(t); await configured(f, "qoder"); f.balances.automation("qoder", true); await configured(f, "qwen"); f.balances.automation("qwen", true);
  const initial = f.bridge.inspections; await f.balances.tick(); assert.equal(f.bridge.inspections, initial);
  f.advance(15 * 60000); f.bridge.onInspect = () => { throw new Error("client unavailable"); }; await f.balances.tick(); assert.equal(provider(f).status, "error");
  f.bridge.onInspect = undefined; await f.balances.tick(); assert.equal(provider(f, "qwen").sample?.reason, "scheduled");
  await f.balances.inspect("qwen"); assert.equal(provider(f, "qwen").profile?.enabled, false);
  const before = f.bridge.inspections; f.advance(60000); await f.balances.tick(); assert.equal(f.bridge.inspections, before);
  f.advance(15 * 60000); await f.balances.tick(); assert.equal(provider(f).sample?.reason, "scheduled");
});

test("all async operations and synchronous mutations exclude concurrent UI work", async t => {
  const f = setup(t); await configured(f); const gate = deferred<View>(); f.bridge.onInspect = () => gate.promise;
  const active = f.balances.inspect("qoder"); assert.equal(f.balances.snapshot().running, "qoder");
  await assert.rejects(f.balances.inspect("qoder"), /尚未完成/); await assert.rejects(f.balances.refresh("qoder"), /尚未完成/); await assert.rejects(f.balances.navigate("qoder", "fake", 7), /尚未完成/);
  assert.throws(() => f.balances.bind("qwen", f.executable), /尚未完成/); assert.throws(() => f.balances.configure("qoder", "fake", 5, 5, "积分", 15), /尚未完成/); assert.throws(() => f.balances.reset("qoder"), /尚未完成/); assert.throws(() => f.balances.automation("qoder", false), /尚未完成/);
  const before = f.bridge.inspections; await f.balances.tick(); assert.equal(f.bridge.inspections, before); gate.resolve(inline()); await active; assert.equal(f.balances.snapshot().running, undefined);
});

test("changed executable, missing native helper and changed title preserve stale last sample", async t => {
  const f = setup(t); await configured(f); fs.appendFileSync(f.executable, "changed"); await f.balances.refresh("qoder");
  assert.match(provider(f).error || "", /已更新/); assert.equal(provider(f).sample?.value, 1234.5); assert.equal(provider(f).stale, true);
  await configured(f); f.bridge.availableValue = false; await f.balances.refresh("qoder"); assert.match(provider(f).error || "", /组件不可用/); f.bridge.availableValue = true;
  f.bridge.current = { ...inline(), title: "A different client" }; await f.balances.refresh("qoder"); assert.match(provider(f).error || "", /窗口标题/); assert.equal(f.bridge.invocations.length, 0);
});

test("audit corruption blocks observation, refresh and all mutations without invoking clients", async t => {
  const f = setup(t); await configured(f); const before = f.bridge.inspections;
  f.service.verifyAudit = () => ({ valid: false, rows: [], error: "corrupt" });
  await assert.rejects(f.balances.inspect("qoder"), /台账/); await assert.rejects(f.balances.refresh("qoder"), /台账/); assert.throws(() => f.balances.automation("qoder", true), /台账/); assert.throws(() => f.balances.reset("qoder"), /台账/);
  assert.equal(f.bridge.inspections, before); assert.equal(provider(f).stale, true); assert.equal(provider(f).low, false);
});

test("invalid settings and persisted malformed structures fail closed", async t => {
  const f = setup(t); await configured(f); const o = await f.balances.inspect("qoder");
  for (const interval of [0, 4, 1441, 15.5, NaN]) assert.throws(() => f.balances.configure("qoder", o.token, 5, 5, "积分", interval), /参数无效/);
  for (const threshold of [-1, NaN, Infinity]) assert.throws(() => f.balances.configure("qoder", o.token, 5, 5, "积分", 15, threshold), /参数无效/);
  const file = path.join(f.service.storage, "balances.json"), original = JSON.parse(fs.readFileSync(file, "utf8"));
  for (const mutate of [(v: any) => { v.profiles.qoder.navigation = [{ name: "Claim", automationId: "", controlType: "Button" }]; }, (v: any) => { v.states.qoder.history[0].value = -1; }, (v: any) => { v.states.qoder.history[0].unit = "USD"; }, (v: any) => { v.states.qoder.history[0].at = "nonsense"; }, (v: any) => { v.profiles.unknown = v.profiles.qoder; }, (v: any) => { v.states.qoder.history = Array(101).fill(v.states.qoder.history[0]); }]) {
    const data = structuredClone(original); mutate(data); fs.writeFileSync(file, JSON.stringify(data)); assert.throws(() => f.restart(), /无效|仅允许|未知/);
  }
  fs.writeFileSync(file, " ".repeat(2 * 1024 * 1024 + 1)); assert.throws(() => f.restart(), /过大/);
});

test("linked executable ancestors are refused instead of traversed", t => {
  const f = setup(t), alias = path.join(f.root, "client-link");
  try { fs.symlinkSync(path.dirname(f.executable), alias, "junction"); } catch (error) { if (["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code || "")) { t.skip("junction permission unavailable"); return; } throw error; }
  assert.throws(() => f.balances.bind("qoder", path.join(alias, "Client.exe")), /链接|junction/); assert.equal(f.bridge.inspections, 0);
});
