import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { WindowsRewardsBridge } from "../electron/rewards-windows";
import { fixture, peFixture } from "./helpers";

// Transport-only fixtures: no helper or client process is launched by mocked tests.
function transport(t: TestContext, respond?: (child: FakeChild, request: string) => void) {
  const f = fixture(t), helper = f.file("native/RewardBridge.exe", peFixture()), executable = f.file("Client & spaces/Client.exe", peFixture());
  const child = new FakeChild(); let call: unknown[] = [];
  t.mock.method(childProcess, "spawn", (...args: unknown[]) => { call = args; return child; });
  let input = "";
  child.stdin.on("data", data => { input += data.toString("utf8"); });
  child.stdin.on("finish", () => { queueMicrotask(() => respond?.(child, input)); });
  t.after(() => { child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); });
  return { ...f, helper, executable, child, bridge: new WindowsRewardsBridge(helper), call: () => call, request: () => input };
}
class FakeChild extends EventEmitter {
  stdin = new PassThrough(); stdout = new PassThrough(); stderr = new PassThrough(); kills = 0;
  kill() { this.kills++; return true; }
  reply(value: unknown, code = 0) { this.stdout.write(JSON.stringify(value)); this.emit("close", code, null); }
}
const element = { index: 0, name: "领取", automationId: "claim-button", controlType: "Button", enabled: true, actionable: true };
const win = { skip: process.platform !== "win32" };

test("Windows rewards requests use a fixed executable, shell-free spawn and JSON stdin", win, async t => {
  const f = transport(t, child => child.reply({ ok: true, title: "Client 奖励", elements: [element] }));
  assert.equal(f.bridge.available(), true);
  const result = await f.bridge.inspect(f.executable, "Client 奖励");
  assert.deepEqual(result, { title: "Client 奖励", elements: [element] });
  assert.equal(f.call()[0], f.helper); assert.deepEqual(f.call()[1], []);
  assert.deepEqual(f.call()[2], { shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  assert.deepEqual(JSON.parse(f.request()), { action: "inspect", executable: f.executable, windowTitle: "Client 奖励" });
  assert.equal(f.child.kills, 0);
});

test("Windows reward invoke sends exact selectors as data and does not accept executable command strings", win, async t => {
  const f = transport(t, child => child.reply({ ok: true }));
  const selector = { name: '领取 & $(calc.exe) "quoted"', automationId: "fixed", controlType: "Button" };
  await f.bridge.invoke(f.executable, "Client 奖励", selector);
  assert.deepEqual(JSON.parse(f.request()), { action: "invoke", executable: f.executable, windowTitle: "Client 奖励", selector });
  assert.deepEqual(f.call()[1], []);
  await assert.rejects(f.bridge.inspect(`${f.executable} --claim`), /\.exe|路径/);
  await assert.rejects(f.bridge.inspect(f.file("client.cmd", "never execute")), /\.exe/);
});

test("Windows reward invoke rejects empty, unsupported or extra selector fields before starting a helper", win, async t => {
  const f = transport(t);
  for (const selector of [
    { name: "password", automationId: "password", controlType: "Edit" },
    { name: "", automationId: "", controlType: "Button" },
    { name: "领取", automationId: "claim", controlType: "Button", command: "anything" },
    { name: "x".repeat(301), automationId: "claim", controlType: "Button" },
  ]) await assert.rejects(f.bridge.invoke(f.executable, "Client", selector), /控件|字段|明确命名/);
  await assert.rejects(f.bridge.invoke(f.executable, "", element), /唯一窗口标题/);
  assert.deepEqual(f.call(), []);
});

test("Windows reward invoke passes bounded context for native revalidation and keeps navigation context-free", win, async t => {
  let f = transport(t, child => child.reply({ ok: true }));
  const selector = { name: "领取", automationId: "claim", controlType: "Button" };
  await f.bridge.invoke(f.executable, "Client", selector, ["每日免费奖励", "Daily credits"]);
  assert.deepEqual(JSON.parse(f.request()).expectedContext, ["每日免费奖励", "Daily credits"]);
  f = transport(t, child => child.reply({ ok: true }));
  await f.bridge.invoke(f.executable, "Client", { name: "积分", automationId: "nav", controlType: "TabItem" });
  assert.equal(Object.hasOwn(JSON.parse(f.request()), "expectedContext"), false);
  f = transport(t);
  for (const context of [[" "], ["x".repeat(301)], Array(6).fill("每日奖励"), ["a\0b"], "not an array", [1]])
    await assert.rejects(f.bridge.invoke(f.executable, "Client", selector, context as string[]), /上下文|字段/);
  assert.deepEqual(f.call(), []);
});

test("Windows reward responses reject protocol drift, duplicate indices, Edit controls and unsafe actions", win, async t => {
  const responses: unknown[] = [
    { ok: "true", title: "Client", elements: [] },
    { ok: true, title: "Client", elements: [], command: "injected" },
    { ok: true, title: "Client", elements: [element, element] },
    { ok: true, title: "Client", elements: [{ ...element, controlType: "Edit" }] },
    { ok: true, title: "Client", elements: [{ ...element, enabled: false }] },
    { ok: true, title: "Client", elements: [{ ...element, controlType: "Pane" }] },
    { ok: true, title: "Client", elements: [{ ...element, name: "x".repeat(301) }] },
    { ok: true, title: "Client", elements: [{ ...element, index: -1 }] },
    { ok: true, title: "Client", elements: Array.from({ length: 501 }, (_, index) => ({ ...element, index })) },
  ];
  for (const response of responses) {
    const f = transport(t, child => child.reply(response));
    await assert.rejects(f.bridge.inspect(f.executable));
  }
});

test("Windows reward bridge preserves locked-desktop errors and rejects success on abnormal exit", win, async t => {
  let f = transport(t, child => child.reply({ ok: false, error: "桌面已锁定或会话未激活，请解锁后重试" }, 1));
  await assert.rejects(f.bridge.inspect(f.executable), /桌面已锁定/);
  f = transport(t, child => child.reply({ ok: true, title: "Client", elements: [] }, 1));
  await assert.rejects(f.bridge.inspect(f.executable), /异常退出.*结果未确认/);
  f = transport(t, child => child.reply({ ok: true, title: "Different Client", elements: [] }));
  await assert.rejects(f.bridge.inspect(f.executable, "Client"), /不同的窗口标题/);
  f = transport(t, child => child.reply({ ok: false, error: "奖励活动上下文已变化，拒绝执行" }, 1));
  await assert.rejects(f.bridge.invoke(f.executable, "Client", { name: "领取", automationId: "claim", controlType: "Button" }, ["每日奖励"]), /上下文已变化/);
});

test("Windows reward bridge caps combined stdout/stderr and kills only its spawned helper", win, async t => {
  const f = transport(t, child => { child.stderr.write(Buffer.alloc(1024 * 1024 + 1, 65)); });
  await assert.rejects(f.bridge.inspect(f.executable), /超过 1 MiB/);
  assert.equal(f.child.kills, 1);
  assert.equal(f.call()[0], f.helper);
});

test("Windows reward bridge times out after 15 seconds without retrying an uncertain action", win, async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = transport(t);
  const pending = assert.rejects(f.bridge.invoke(f.executable, "Client", { name: "领取", automationId: "claim", controlType: "Button" }), /超时.*结果未确认/);
  t.mock.timers.tick(15_001); await pending;
  assert.equal(f.child.kills, 1); assert.deepEqual(f.call()[1], []);
});

test("Windows reward bridge rejects invalid UTF-8 and multiple JSON responses", win, async t => {
  let f = transport(t, child => { child.stdout.write(Buffer.from([0xc3, 0x28])); child.emit("close", 0, null); });
  await assert.rejects(f.bridge.inspect(f.executable));
  f = transport(t, child => { child.stdout.write('{"ok":true}\n{"ok":true}'); child.emit("close", 0, null); });
  await assert.rejects(f.bridge.inspect(f.executable));
});

test("compiled native helper rejects malformed requests before any desktop access", win, t => {
  const f = fixture(t), executable = f.file("client.exe", peFixture());
  const helper = path.resolve(__dirname, "../native/bin/RewardBridge.exe");
  if (!new WindowsRewardsBridge(helper).available()) { t.skip("Build RewardBridge before running native protocol checks"); return; }
  const requests = [
    "not JSON", "[1,2]", JSON.stringify({ action: "execute", code: "anything" }),
    JSON.stringify({ action: "inspect", executable, selector: {} }),
    JSON.stringify({ action: "invoke", executable, windowTitle: "Client", selector: { name: "x", automationId: "y", controlType: "Edit" } }),
    JSON.stringify({ action: "inspect", executable, expectedContext: ["每日奖励"] }),
    ...[[" "], ["x".repeat(301)], Array(6).fill("每日奖励"), "not an array", [1]].map(expectedContext =>
      JSON.stringify({ action: "invoke", executable, windowTitle: "Client", selector: { name: "领取", automationId: "claim", controlType: "Button" }, expectedContext })),
    JSON.stringify({ action: "inspect", executable: "\\\\server\\share\\client.exe" }),
    "x".repeat(16385),
  ];
  for (const input of requests) {
    const result = childProcess.spawnSync(helper, [], { shell: false, windowsHide: true, input, encoding: "utf8", timeout: 5000, maxBuffer: 1024 * 1024 });
    assert.equal(result.error, undefined); assert.equal(result.status, 1);
    const response = JSON.parse(result.stdout); assert.equal(response.ok, false); assert.equal(typeof response.error, "string");
    assert.doesNotMatch(response.error, /桌面|窗口|解锁/); // Each request must fail in parsing, not in UIA/window discovery.
    assert.equal(result.stderr, "");
  }
});

test("native inspection projection excludes hidden success and context labels without accessing UIA", win, t => {
  const f = fixture(t), helper = path.resolve(__dirname, "../native/bin/RewardBridge.exe");
  if (!new WindowsRewardsBridge(helper).available()) { t.skip("Build RewardBridge before native projection checks"); return; }
  // Load the helper assembly without running its entry point; call only its pure
  // projection function. This fixture never obtains an AutomationElement/window.
  const source = f.file("ProjectionProbe.cs", `
using System;
using System.Reflection;
using System.Web.Script.Serialization;
public static class ProjectionProbe {
  public static int Main(string[] args) {
    var method = Assembly.LoadFrom(args[0]).GetType("RewardBridge").GetMethod("DisplayElement", BindingFlags.Static | BindingFlags.NonPublic);
    foreach (string text in new[] { "Already claimed", "Daily free rewards" }) {
      if (method.Invoke(null, new object[] { 0, text, "label", "Text", true, false, true }) != null) return 10;
    }
    var visible = method.Invoke(null, new object[] { 0, "Daily free rewards", "label", "Text", true, false, false });
    if (visible == null) return 11;
    Console.WriteLine(new JavaScriptSerializer().Serialize(visible));
    return 0;
  }
}`);
  const framework = path.join(process.env.SystemRoot!, "Microsoft.NET/Framework64/v4.0.30319");
  const probe = path.join(f.root, "ProjectionProbe.exe");
  const compiled = childProcess.spawnSync(path.join(framework, "csc.exe"), ["/nologo", "/target:exe", "/platform:x64", `/out:${probe}`, `/reference:${path.join(framework, "System.Web.Extensions.dll")}`, source], { shell: false, windowsHide: true, encoding: "utf8", timeout: 10000 });
  assert.equal(compiled.error, undefined); assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
  const result = childProcess.spawnSync(probe, [helper], { shell: false, windowsHide: true, encoding: "utf8", timeout: 5000, maxBuffer: 1024 * 1024 });
  assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { index: 0, name: "Daily free rewards", automationId: "label", controlType: "Text", enabled: true, actionable: false });
});
