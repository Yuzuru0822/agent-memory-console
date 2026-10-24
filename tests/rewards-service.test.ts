import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { RewardsService, rewardWindow, nextRewardWindow, type RewardsBridge, type RewardBalanceObserver } from "../electron/rewards-service";
import type { RewardElement, RewardId, RewardSelector } from "../src/rewards-types";
import { fixture, peFixture } from "./helpers";

// All UI observations and invocations are in memory. PE fixtures are only hashed;
// this suite never starts a native bridge, a client, or a real reward claim.
type View = { title: string; elements: RewardElement[] };
type Invocation = { executable: string; title: string; selector: RewardSelector; context?: string[] };
const title = "Fixture Client";
const contextText = "每日免费奖励 100 积分";
const element = (index: number, name: string, controlType = "Button", automationId = `fixture-${index}`): RewardElement => ({
  index, name, controlType, automationId, enabled: true, actionable: controlType !== "Text",
});
const claim = element(1, "领取", "Button", "claim");
const navigation = element(3, "Buddy 加油站", "Button", "rewards-menu");
const panel = (): View => ({ title, elements: [element(0, contextText, "Text"), claim] });
const completed = (): View => ({ title, elements: [element(0, contextText, "Text"), element(2, "今日已领取", "Text")] });
const home = (): View => ({ title, elements: [navigation] });

class FakeBridge implements RewardsBridge {
  current = panel();
  availableValue = true;
  inspections: { executable: string; title?: string }[] = [];
  invocations: Invocation[] = [];
  onInspect?: () => Promise<View> | View;
  onInvoke?: (call: Invocation) => Promise<void> | void;
  available() { return this.availableValue; }
  async inspect(executable: string, windowTitle?: string) {
    this.inspections.push({ executable, title: windowTitle });
    return structuredClone(this.onInspect ? await this.onInspect() : this.current);
  }
  async invoke(executable: string, windowTitle: string, selector: RewardSelector, context?: string[]) {
    const call = { executable, title: windowTitle, selector: structuredClone(selector), context: context && [...context] };
    this.invocations.push(call);
    if (this.onInvoke) await this.onInvoke(call);
    else this.current = selector.name === "领取" ? completed() : panel();
  }
}

function setup(t: TestContext, observer?: RewardBalanceObserver) {
  const f = fixture(t), bridge = new FakeBridge(), executable = f.file("fake-client/Client.exe", peFixture());
  let now = Date.parse("2026-10-24T02:01:00.000Z");
  const waits: number[] = [];
  const delay = async (ms: number) => { waits.push(ms); };
  const rewards = new RewardsService(f.service, bridge, () => now, delay, observer);
  return { ...f, bridge, executable, rewards, waits, now: () => now,
    advance: (ms: number) => { now += ms; },
    restart: () => new RewardsService(f.service, bridge, () => now, delay, observer),
  };
}
type Setup = ReturnType<typeof setup>;
function provider(f: Setup, id: RewardId = "qoder") { return f.rewards.snapshot().providers.find(p => p.id === id)!; }
async function calibrate(f: Setup, id: RewardId = "qoder", withNavigation = false) {
  f.rewards.bind(id, f.executable);
  if (withNavigation) {
    f.bridge.current = home();
    const first = await f.rewards.inspect(id);
    await f.rewards.record(id, first.token, navigation.index, "navigate");
  }
  f.bridge.current = panel();
  let observation = await f.rewards.inspect(id);
  await f.rewards.record(id, observation.token, claim.index, "claim");
  observation = await f.rewards.inspect(id);
  f.rewards.checks(id, observation.token, [0], ["今日已领取", "领取成功"], id.startsWith("qoder") ? 10 : 0);
  f.bridge.invocations = []; f.bridge.inspections = [];
}
async function validated(f: Setup) {
  await calibrate(f); await f.rewards.run("qoder");
  assert.equal(provider(f).profile?.validated, true);
  f.rewards.automation("qoder", true);
  f.bridge.invocations = []; f.bridge.inspections = [];
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}

test("rewards classify nine regional entries across seven agents without inventing unsupported claims", t => {
  const f = setup(t), providers = f.rewards.snapshot().providers;
  assert.equal(providers.length, 9);
  assert.equal(new Set(providers.map(p => p.agent)).size, 7);
  assert.deepEqual(Object.fromEntries(providers.map(p => [p.id, p.kind])), {
    qoder: "ui", "qoder-cn": "ui", trae: "ui", "trae-global": "unknown", workbuddy: "ui",
    qwen: "automatic", zcode: "automatic", claude: "manual", deepseek: "unknown",
  });
  for (const p of providers.filter(p => p.kind !== "ui")) {
    assert.equal(p.state, "unsupported");
    assert.throws(() => f.rewards.bind(p.id, f.executable), /不支持|尚无/);
  }
  assert.equal(f.bridge.invocations.length, 0);
  assert.throws(() => f.rewards.definition("unknown-provider"), /未知/);
});

test("reward windows use Beijing time and the Qoder 10:00 boundary", () => {
  const before = Date.parse("2026-10-24T01:59:59.999Z"), boundary = before + 1;
  assert.equal(rewardWindow(before, 10), "2026-10-23");
  assert.equal(rewardWindow(boundary, 10), "2026-10-24");
  assert.equal(nextRewardWindow(before, 10), "2026-10-24T02:00:00.000Z");
  assert.equal(nextRewardWindow(boundary, 10), "2026-10-25T02:00:00.000Z");
  assert.equal(rewardWindow(Date.parse("2026-10-23T16:00:00Z"), 0), "2026-10-24");
});

test("inspection and recording a claim only calibrate; neither submits a reward", async t => {
  const f = setup(t); f.rewards.bind("qoder", f.executable);
  const observation = await f.rewards.inspect("qoder");
  assert.equal(observation.title, title);
  await f.rewards.record("qoder", observation.token, 1, "claim");
  assert.equal(f.bridge.invocations.length, 0);
  assert.equal(provider(f).profile?.validated, false);
  assert.equal(provider(f).profile?.enabled, false);
  assert.throws(() => f.rewards.automation("qoder", true), /先完成/);
});

test("calibration rejects expired, superseded and cross-provider observation tokens", async t => {
  const f = setup(t); f.rewards.bind("qoder", f.executable); f.rewards.bind("qoder-cn", f.executable);
  let observation = await f.rewards.inspect("qoder"); f.advance(60_001);
  await assert.rejects(f.rewards.record("qoder", observation.token, 1, "claim"), /过期/);
  observation = await f.rewards.inspect("qoder"); await f.rewards.inspect("qoder");
  await assert.rejects(f.rewards.record("qoder", observation.token, 1, "claim"), /过期/);
  observation = await f.rewards.inspect("qoder");
  await assert.rejects(f.rewards.record("qoder-cn", observation.token, 1, "claim"), /过期/);
  assert.equal(f.bridge.invocations.length, 0);
});

test("paid, destructive and claim-as-navigation controls cannot be recorded", async t => {
  const f = setup(t); f.rewards.bind("workbuddy", f.executable);
  for (const name of ["购买积分", "充值领取", "支付", "重置", "Upgrade", "Reset", "邀请好友领取"]) {
    f.bridge.current = { title, elements: [element(0, name)] };
    const observation = await f.rewards.inspect("workbuddy");
    await assert.rejects(f.rewards.record("workbuddy", observation.token, 0, "navigate"), /不适合|不能/);
    await assert.rejects(f.rewards.record("workbuddy", observation.token, 0, "claim"), /不适合|不能/);
  }
  f.bridge.current = panel();
  const observation = await f.rewards.inspect("workbuddy");
  await assert.rejects(f.rewards.record("workbuddy", observation.token, 1, "navigate"), /单独记录|导航/);
  assert.equal(f.bridge.invocations.length, 0);
});

test("calibration rejects unavailable and duplicated navigation controls before invocation", async t => {
  const f = setup(t); f.rewards.bind("workbuddy", f.executable);
  for (const patch of [{ enabled: false }, { actionable: false }]) {
    f.bridge.current = { title, elements: [{ ...navigation, ...patch }] };
    const observation = await f.rewards.inspect("workbuddy");
    await assert.rejects(f.rewards.record("workbuddy", observation.token, 3, "navigate"), /可用|可点击/);
  }
  f.bridge.current = { title, elements: [navigation, { ...navigation, index: 4 }] };
  const observation = await f.rewards.inspect("workbuddy");
  await assert.rejects(f.rewards.record("workbuddy", observation.token, 3, "navigate"), /不唯一/);
  assert.equal(f.bridge.invocations.length, 0);
});

test("calibration refuses balances, unrelated text, success states and paid activity as free-reward context", async t => {
  const f = setup(t); f.rewards.bind("workbuddy", f.executable);
  for (const name of ["账号信息", "剩余积分 100", "今日已领取", "购买积分赠送100", "领取成功"]) {
    f.bridge.current = { title, elements: [element(0, name, "Text")] };
    const observation = await f.rewards.inspect("workbuddy");
    assert.throws(() => f.rewards.checks("workbuddy", observation.token, [0], ["今日已领取"], 0), /上下文|活动|免费/);
  }
  assert.equal(f.bridge.invocations.length, 0);
});

test("success calibration requires explicit status text and Qoder keeps its official reset hour", async t => {
  const f = setup(t); f.rewards.bind("qoder", f.executable);
  for (const success of ["100", "积分", "成功", "领取", "账户正常", "已到账100积分"]) {
    const observation = await f.rewards.inspect("qoder");
    assert.throws(() => f.rewards.checks("qoder", observation.token, [0], [success], 10), /成功状态/);
  }
  const observation = await f.rewards.inspect("qoder");
  assert.throws(() => f.rewards.checks("qoder", observation.token, [0], ["今日已领取"], 0), /10:00/);
});

test("already claimed observations never click or validate a first-time flow", async t => {
  const f = setup(t); await calibrate(f); f.bridge.current = completed();
  await f.rewards.run("qoder");
  assert.equal(f.bridge.invocations.length, 0);
  assert.equal(provider(f).state, "already_claimed");
  assert.equal(provider(f).profile?.validated, false);
  assert.throws(() => f.rewards.automation("qoder", true), /先完成/);
});

test("duplicate claim selectors cannot cause any claim submission", async t => {
  const f = setup(t); await calibrate(f);
  f.bridge.current.elements.push({ ...claim, index: 8 });
  await f.rewards.run("qoder");
  assert.equal(f.bridge.invocations.length, 0);
  assert.equal(provider(f).state, "needs_attention");
  assert.match(provider(f).lastMessage!, /不唯一/);
});

test("a successful claim passes its calibrated context to the bridge and persists verified success", async t => {
  const f = setup(t); await calibrate(f);
  await f.rewards.run("qoder");
  assert.equal(f.bridge.invocations.length, 1);
  assert.deepEqual(f.bridge.invocations[0].context, [contextText]);
  assert.equal(provider(f).state, "claimed");
  assert.equal(provider(f).profile?.validated, true);
  assert.equal(provider(f).lastSuccess, new Date(f.now()).toISOString());
  const stored = f.restart().snapshot().providers.find(p => p.id === "qoder")!;
  assert.equal(stored.profile?.validated, true);
  assert.equal(stored.lastSuccess, provider(f).lastSuccess);
  assert.equal(f.service.verifyAudit().valid, true);
});

test("success text outside the calibrated activity cannot validate the submitted claim", async t => {
  const f = setup(t); await calibrate(f);
  f.bridge.onInvoke = () => { f.bridge.current = { title, elements: [element(2, "今日已领取", "Text")] }; };
  await f.rewards.run("qoder");
  assert.equal(f.bridge.invocations.length, 1);
  assert.equal(provider(f).state, "unknown");
  assert.equal(provider(f).profile?.validated, false);
  assert.equal(provider(f).lastSuccess, undefined);
});

test("vague output is not success even when the calibrated activity is still visible", async t => {
  const f = setup(t); await calibrate(f);
  f.bridge.onInvoke = () => { f.bridge.current = { title, elements: [element(0, contextText, "Text"), element(2, "成功", "Text")] }; };
  await f.rewards.run("qoder");
  assert.equal(provider(f).state, "unknown");
  assert.equal(provider(f).profile?.validated, false);
  assert.equal(f.bridge.invocations.length, 1);
});

test("automatic scheduling does not repeat a verified window and runs after the next boundary", async t => {
  const f = setup(t); await validated(f);
  await f.rewards.tick(); assert.equal(f.bridge.invocations.length, 0);
  f.advance(23 * 3600000); await f.rewards.tick(); assert.equal(f.bridge.invocations.length, 0);
  f.advance(3600000); f.bridge.current = panel(); await f.rewards.tick();
  assert.equal(f.bridge.invocations.length, 1);
  assert.equal(provider(f).state, "claimed");
  assert.equal(provider(f).nextCheck, "2026-10-26T02:00:00.000Z");
  await f.rewards.tick(); assert.equal(f.bridge.invocations.length, 1);
});

test("navigation crossing the daily reset records the window in which claim was actually submitted", async t => {
  const f = setup(t); await calibrate(f, "qoder", true); f.advance(-61_000);
  assert.equal(new Date(f.now()).toISOString(), "2026-10-24T01:59:59.000Z");
  f.bridge.current = home();
  f.bridge.onInvoke = call => {
    if (call.selector.name === "Buddy 加油站") { f.advance(2000); f.bridge.current = panel(); }
    else f.bridge.current = completed();
  };
  await f.rewards.run("qoder");
  assert.equal(provider(f).state, "claimed");
  assert.deepEqual(f.bridge.invocations.map(call => call.selector.name), ["Buddy 加油站", "领取"]);
  f.rewards.automation("qoder", true);
  assert.equal(provider(f).nextCheck, "2026-10-25T02:00:00.000Z");
  f.bridge.current = panel(); await f.rewards.tick();
  assert.equal(f.bridge.invocations.length, 2);
});

test("a claim whose submission and success observation straddle reset stays unknown and paused", async t => {
  const f = setup(t); await calibrate(f); f.advance(-61_000);
  f.bridge.onInvoke = () => { f.advance(2000); f.bridge.current = completed(); };
  await f.rewards.run("qoder");
  assert.equal(f.bridge.invocations.length, 1);
  assert.equal(provider(f).state, "unknown");
  assert.equal(provider(f).profile?.enabled, false);
  assert.equal(provider(f).profile?.validated, false);
  assert.equal(provider(f).lastSuccess, undefined);
  f.advance(86400000); await f.rewards.tick();
  assert.equal(f.bridge.invocations.length, 1);
});

test("an uncertain submitted claim disables automation and is not retried by ticks", async t => {
  const f = setup(t); await validated(f); f.advance(86400000); f.bridge.current = panel();
  f.bridge.onInvoke = () => { /* No completion was observed. */ };
  await f.rewards.tick();
  assert.equal(provider(f).state, "unknown");
  assert.equal(provider(f).profile?.enabled, false);
  assert.equal(provider(f).profile?.validated, false);
  f.advance(86400000); await f.rewards.tick();
  assert.equal(f.bridge.invocations.length, 1);
});

test("a bridge timeout after submission is persisted as unknown and never retried", async t => {
  const f = setup(t); await validated(f); f.advance(86400000); f.bridge.current = panel();
  f.bridge.onInvoke = () => { throw new Error("桥接超时，结果未确认"); };
  await f.rewards.tick();
  assert.equal(provider(f).state, "unknown");
  assert.equal(provider(f).profile?.enabled, false);
  f.advance(86400000); await f.rewards.tick();
  assert.equal(f.bridge.invocations.length, 1);
});

test("restart recovers an in-flight unknown marker as paused and blocks automatic or manual retry", async t => {
  const f = setup(t); await validated(f);
  const file = path.join(f.service.storage, "rewards.json"), stored = JSON.parse(fs.readFileSync(file, "utf8"));
  stored.states.qoder = { state: "unknown", message: "领取请求待核验；中断后需人工检查", attempt: new Date(f.now()).toISOString() };
  fs.writeFileSync(file, JSON.stringify(stored));
  const restarted = f.restart(), state = restarted.snapshot().providers.find(p => p.id === "qoder")!;
  assert.equal(state.state, "unknown");
  assert.equal(state.profile?.enabled, false);
  assert.equal(state.profile?.validated, false);
  f.bridge.current = panel(); f.advance(86400000);
  await restarted.tick(); await restarted.run("qoder").catch(() => undefined);
  assert.equal(f.bridge.invocations.length, 0);
  assert.throws(() => restarted.automation("qoder", true), /验证|校准|核对|先完成/);
});

test("changed executable bytes require rebinding before any UI inspection or invocation", async t => {
  const f = setup(t); await validated(f);
  const bytes = peFixture(); bytes[120] = 42; fs.writeFileSync(f.executable, bytes);
  await assert.rejects(f.rewards.inspect("qoder"), /更新|变化/);
  assert.throws(() => f.rewards.automation("qoder", true), /更新|变化/);
  await f.rewards.run("qoder");
  assert.equal(f.bridge.inspections.length, 0);
  assert.equal(f.bridge.invocations.length, 0);
  assert.equal(provider(f).state, "needs_attention");
});

test("an executable replaced after inspection is rejected immediately before invoking claim", async t => {
  const f = setup(t); await calibrate(f);
  f.bridge.onInspect = () => { const bytes = peFixture(); bytes[121] = 11; fs.writeFileSync(f.executable, bytes); return panel(); };
  await f.rewards.run("qoder");
  assert.equal(f.bridge.invocations.length, 0);
  assert.equal(provider(f).state, "needs_attention");
});

test("a damaged activity ledger prevents binding, calibration and reward execution", async t => {
  const f = setup(t); await calibrate(f);
  fs.appendFileSync(path.join(f.service.storage, "activity.jsonl"), '{"tampered":true}\n');
  assert.equal(f.service.verifyAudit().valid, false);
  assert.throws(() => f.rewards.bind("workbuddy", f.executable), /台账/);
  assert.throws(() => f.rewards.reset("qoder"), /台账/);
  assert.throws(() => f.rewards.automation("qoder", false), /台账/);
  await assert.rejects(f.rewards.run("qoder"), /台账/);
  assert.equal(f.bridge.invocations.length, 0);
});

test("only one reward workflow can run and concurrent ticks cannot duplicate submission", async t => {
  const f = setup(t); await calibrate(f);
  const entered = deferred<void>(), release = deferred<void>();
  f.bridge.onInvoke = async () => { entered.resolve(); await release.promise; f.bridge.current = completed(); };
  const running = f.rewards.run("qoder"); await entered.promise;
  try {
    assert.equal(f.rewards.snapshot().running, "qoder");
    await assert.rejects(f.rewards.run("qoder"), /正在执行|尚未完成/);
    await f.rewards.tick(); assert.equal(f.bridge.invocations.length, 1);
    assert.throws(() => f.rewards.bind("workbuddy", f.executable), /尚未完成/);
    assert.throws(() => f.rewards.reset("qoder"), /尚未完成/);
  } finally { release.resolve(); await running; }
  assert.equal(f.rewards.snapshot().running, undefined);
});

test("opening calibration pauses automatic claims before a pending inspection can complete", async t => {
  const f = setup(t); await validated(f); f.advance(86400000); f.bridge.current = panel();
  const entered = deferred<void>(), release = deferred<View>();
  f.bridge.onInspect = async () => { entered.resolve(); return release.promise; };
  const inspection = f.rewards.inspect("qoder"); await entered.promise;
  try {
    assert.equal(provider(f).profile?.enabled, false);
    await f.rewards.tick(); assert.equal(f.bridge.invocations.length, 0);
    await assert.rejects(f.rewards.run("qoder"), /正在执行|尚未完成/);
  } finally { release.resolve(panel()); await inspection; }
  assert.equal(provider(f).profile?.enabled, false);
  f.bridge.onInspect = undefined;
  await f.rewards.run("qoder");
  assert.equal(provider(f).state, "claimed");
  assert.equal(f.bridge.invocations.length, 1);
});

test("recording navigation owns the UI lock until completion and then permits a normal trial claim", async t => {
  const f = setup(t); await calibrate(f, "workbuddy", true); f.bridge.current = home();
  const observation = await f.rewards.inspect("workbuddy");
  const entered = deferred<void>(), release = deferred<void>();
  f.bridge.onInvoke = async () => { entered.resolve(); await release.promise; f.bridge.current = panel(); };
  const recording = f.rewards.record("workbuddy", observation.token, navigation.index, "navigate");
  await entered.promise;
  try {
    await assert.rejects(f.rewards.run("workbuddy"), /正在执行|尚未完成/);
    await assert.rejects(f.rewards.inspect("workbuddy"), /正在执行|尚未完成/);
    await assert.rejects(f.rewards.record("workbuddy", observation.token, navigation.index, "navigate"), /正在执行|尚未完成/);
    await f.rewards.tick(); assert.equal(f.bridge.invocations.length, 1);
  } finally { release.resolve(); await recording; }
  f.bridge.onInvoke = undefined;
  await f.rewards.run("workbuddy");
  assert.equal(provider(f, "workbuddy").state, "claimed");
  assert.deepEqual(f.bridge.invocations.map(call => call.selector.name), ["Buddy 加油站", "领取"]);
});

test("navigation opens the activity panel and stops once the calibrated panel is reached", async t => {
  const f = setup(t); await calibrate(f, "workbuddy", true); f.bridge.current = home();
  await f.rewards.run("workbuddy");
  assert.deepEqual(f.bridge.invocations.map(call => call.selector.name), ["Buddy 加油站", "领取"]);
  assert.equal(provider(f, "workbuddy").state, "claimed");
});

test("an already open activity panel is never toggled closed by replaying navigation", async t => {
  const f = setup(t); await calibrate(f, "workbuddy", true); f.bridge.current = panel();
  await f.rewards.run("workbuddy");
  assert.deepEqual(f.bridge.invocations.map(call => call.selector.name), ["领取"]);
  assert.equal(provider(f, "workbuddy").state, "claimed");
});

test("a success label on an unrelated page cannot skip required activity context", async t => {
  const f = setup(t); await calibrate(f);
  f.bridge.current = { title, elements: [element(0, "账号资料", "Text"), element(2, "今日已领取", "Text")] };
  await f.rewards.run("qoder");
  assert.equal(provider(f).state, "needs_attention");
  assert.equal(provider(f).profile?.validated, false);
  assert.equal(f.bridge.invocations.length, 0);
});

test("start enables and persists automatic claiming only after verified claim success", async t => {
  const f = setup(t); await calibrate(f); const result = await f.rewards.start("qoder");
  assert.match(result.message, /自动领取已开启/); assert.equal(provider(f).state, "claimed"); assert.equal(provider(f).profile?.validated, true); assert.equal(provider(f).profile?.enabled, true);
  assert.equal(f.bridge.invocations.length, 1); assert.equal(f.restart().snapshot().providers.find(p => p.id === "qoder")?.profile?.enabled, true);
  await f.rewards.tick(); assert.equal(f.bridge.invocations.length, 1);
});

test("start does not enable a first flow just because the account already claimed", async t => {
  const f = setup(t); await calibrate(f); f.bridge.current = completed(); const result = await f.rewards.start("qoder");
  assert.match(result.message, /尚未开启/); assert.equal(provider(f).state, "already_claimed"); assert.equal(provider(f).profile?.enabled, false); assert.equal(provider(f).profile?.validated, false); assert.equal(f.bridge.invocations.length, 0);
});

test("start leaves unknown submission paused and cannot trigger a second submission", async t => {
  const f = setup(t); await calibrate(f); f.bridge.onInvoke = () => {};
  const result = await f.rewards.start("qoder"); assert.match(result.message, /尚未开启/); assert.equal(provider(f).state, "unknown"); assert.equal(provider(f).profile?.enabled, false);
  await assert.rejects(f.rewards.start("qoder"), /结果未知/); f.advance(86400000); await f.rewards.tick(); assert.equal(f.bridge.invocations.length, 1);
});

test("a previously verified flow can restart automation from an already-claimed panel", async t => {
  const f = setup(t); await validated(f); f.rewards.automation("qoder", false); f.bridge.current = completed();
  await f.rewards.start("qoder"); assert.equal(provider(f).state, "already_claimed"); assert.equal(provider(f).profile?.enabled, true); assert.equal(f.bridge.invocations.length, 0);
});

test("balance observations bracket claim submission and success, with persisted result available afterwards", async t => {
  const events: string[] = []; let observedState: string | undefined;
  const f = setup(t, async (id, reason) => { assert.equal(id, "qoder"); events.push(reason); if (reason === "after_claim") observedState = provider(f).state; });
  await calibrate(f);
  f.bridge.onInspect = () => { events.push("inspect"); return f.bridge.current; };
  f.bridge.onInvoke = () => { events.push("claim"); f.bridge.current = completed(); };
  await f.rewards.run("qoder");
  assert.deepEqual(events, ["before_claim", "inspect", "claim", "inspect", "after_claim"]); assert.equal(observedState, "claimed"); assert.equal(provider(f).state, "claimed");
});

test("balance observation failures cannot erase claim success or lead to a repeated daily submission", async t => {
  const observations: string[] = [];
  const f = setup(t, async (_id, reason) => { observations.push(reason); throw new Error("余额不可读"); });
  await calibrate(f); await f.rewards.start("qoder");
  assert.deepEqual(observations, ["before_claim", "after_claim"]); assert.equal(provider(f).state, "claimed"); assert.equal(provider(f).profile?.validated, true); assert.equal(provider(f).profile?.enabled, true);
  await f.rewards.tick(); await f.rewards.tick(); assert.equal(f.bridge.invocations.length, 1); assert.equal(observations.length, 2);
  const restarted = f.restart(); await restarted.tick(); assert.equal(f.bridge.invocations.length, 1); assert.equal(restarted.snapshot().providers.find(p => p.id === "qoder")?.state, "claimed");
});

test("scheduler invokes balance observers around each due window only", async t => {
  const observations: string[] = []; const f = setup(t, async (_id, reason) => { observations.push(reason); });
  await calibrate(f); await f.rewards.start("qoder"); observations.length = 0;
  await f.rewards.tick(); assert.deepEqual(observations, []);
  f.advance(86400000); f.bridge.current = panel(); await f.rewards.tick();
  assert.deepEqual(observations, ["before_claim", "after_claim"]); assert.equal(f.bridge.invocations.length, 2);
  await f.rewards.tick(); assert.equal(observations.length, 2); assert.equal(f.bridge.invocations.length, 2);
});

test("unknown submissions still get an after-claim balance read without validating the claim", async t => {
  const observations: string[] = []; const f = setup(t, async (_id, reason) => { observations.push(reason); });
  await calibrate(f); f.bridge.onInvoke = () => {}; await f.rewards.run("qoder");
  assert.deepEqual(observations, ["before_claim", "after_claim"]); assert.equal(provider(f).state, "unknown"); assert.equal(provider(f).profile?.validated, false); assert.equal(provider(f).profile?.enabled, false);
});

test("the reward UI lock remains held until the after-claim observer finishes", async t => {
  const entered = deferred<void>(), release = deferred<void>();
  const f = setup(t, async (_id, reason) => { if (reason === "after_claim") { entered.resolve(); await release.promise; } });
  await calibrate(f); const active = f.rewards.start("qoder"); await entered.promise;
  try {
    assert.equal(provider(f).state, "claimed"); assert.equal(f.rewards.snapshot().running, "qoder"); await assert.rejects(f.rewards.run("qoder"), /正在执行/);
    await f.rewards.tick(); assert.equal(f.bridge.invocations.length, 1);
  } finally { release.resolve(); await active; }
  assert.equal(f.rewards.snapshot().running, undefined); assert.equal(provider(f).profile?.enabled, true);
});

test("an expanded account menu resumes from the later visible reward step instead of toggling avatar", async t => {
  const f = setup(t), avatar = element(10, "我的账户", "Button", "avatar"); f.rewards.bind("workbuddy", f.executable);
  f.bridge.current = { title, elements: [avatar] }; f.bridge.onInvoke = () => { f.bridge.current = { title, elements: [avatar, navigation] }; };
  let o = await f.rewards.inspect("workbuddy"); await f.rewards.record("workbuddy", o.token, avatar.index, "navigate");
  f.bridge.onInvoke = () => { f.bridge.current = panel(); }; o = await f.rewards.inspect("workbuddy"); await f.rewards.record("workbuddy", o.token, navigation.index, "navigate");
  o = await f.rewards.inspect("workbuddy"); await f.rewards.record("workbuddy", o.token, claim.index, "claim");
  o = await f.rewards.inspect("workbuddy"); f.rewards.checks("workbuddy", o.token, [0], ["今日已领取", "领取成功"], 0);
  f.bridge.current = { title, elements: [avatar, navigation] }; f.bridge.onInvoke = undefined; f.bridge.invocations = [];
  await f.rewards.run("workbuddy"); assert.deepEqual(f.bridge.invocations.map(v => v.selector.name), ["Buddy 加油站", "领取"]); assert.equal(provider(f, "workbuddy").state, "claimed");
});
