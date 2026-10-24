/* Real Electron/IPC/React regression; all vendor observations and invocations are
 * fixtures. Never executes the native UIA helper or a real vendor client. */
const { _electron: electron } = require("playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

(async () => {
  const project = path.resolve(__dirname, "..");
  const fixture = path.resolve(project, "../../work", `rewards-desktop-${Date.now()}`);
  const home = path.join(fixture, "home"), data = path.join(fixture, "user-data");
  const results = path.join(project, "test-results");
  const executable = path.join(fixture, "vendor-fixture.exe");
  for (const directory of [home, data, results]) fs.mkdirSync(directory, { recursive: true });
  const pe = Buffer.alloc(128);
  pe.write("MZ"); pe.writeUInt32LE(64, 60); pe.write("PE\0\0", 64);
  pe.writeUInt16LE(0x8664, 68); pe.writeUInt16LE(0x0002, 86); pe.writeUInt16LE(0x20b, 88);
  fs.writeFileSync(executable, pe); // Header fixture only; must never be launched.
  const app = await electron.launch({ args: [project], env: { ...process.env,
    CONSOLE_DEV: "", CONSOLE_TEST_DATA: data, CONSOLE_TEST_HOME: home }, timeout: 60000 });
  let assertions = 0;
  const check = (actual, expected, message) => { assert.deepEqual(actual, expected, message); assertions++; };
  const errors = [];
  try {
    const page = await app.firstWindow();
    page.on("pageerror", error => errors.push(error.message));
    await page.waitForSelector(".agent-card", { timeout: 20000 });
    await app.evaluate(({ dialog, shell }, fixtureData) => {
      const req = process.mainModule.require.bind(process.mainModule);
      const { WindowsRewardsBridge } = req(fixtureData.bridge);
      const { RewardsService } = req(fixtureData.service);
      const state = global.__rewardFixture = { executable: fixtureData.executable,
        title: "Rewards Fixture", stage: "home", outcome: "success", invocations: [],
        inspections: 0, response: 0, cancelFile: false, dialogs: [], urls: [] };
      const element = (index, name, controlType = "Text", actionable = false) => ({
        index, name, controlType, actionable, automationId: `fixture-${index}`, enabled: true,
      });
      const elements = () => state.stage === "home"
        ? [element(0, "Buddy 加油站", "Button", true), element(1, "Fixture account")]
        : [element(0, "每日免费积分福利"), element(1, "免费奖励"),
          element(2, state.stage === "claimed" ? "今日已领取" : "领取", "Button", state.stage !== "claimed"),
          element(3, "升级订阅", "Button", true), element(4, "领取并使用重置卡", "Button", true)];
      WindowsRewardsBridge.prototype.available = () => true;
      WindowsRewardsBridge.prototype.inspect = async function (exe, title) {
        if (exe !== state.executable || (title !== undefined && title !== state.title))
          throw new Error("Fixture refused unexpected client or window");
        state.inspections++;
        return { title: state.title, elements: elements() };
      };
      WindowsRewardsBridge.prototype.invoke = async function (exe, title, selector, context) {
        if (exe !== state.executable || title !== state.title)
          throw new Error("Fixture refused unexpected client or window");
        const matches = elements().filter(item => item.name === selector.name && item.automationId === selector.automationId && item.controlType === selector.controlType);
        if (matches.length !== 1 || !matches[0].actionable) throw new Error("Fixture selector no longer available");
        state.invocations.push({ name: selector.name, context });
        if (selector.name === "Buddy 加油站") state.stage = "panel";
        else if (selector.name === "领取") {
          if (!Array.isArray(context) || !context.includes("每日免费积分福利")) throw new Error("Claim must carry activity context");
          if (state.outcome === "success") state.stage = "claimed";
        } else throw new Error("Fixture refused non-reward action");
      };
      const snapshot = RewardsService.prototype.snapshot;
      RewardsService.prototype.snapshot = function (...args) {
        global.__rewardService = this;
        return snapshot.apply(this, args);
      };
      dialog.showOpenDialog = async () => ({ canceled: state.cancelFile, filePaths: state.cancelFile ? [] : [state.executable] });
      dialog.showMessageBox = async (_window, options) => {
        state.dialogs.push(options);
        return { response: state.response, checkboxChecked: false };
      };
      shell.openExternal = async url => { state.urls.push(url); };
    }, { executable, bridge: path.join(project, "dist-electron/electron/rewards-windows.js"),
      service: path.join(project, "dist-electron/electron/rewards-service.js") });
    const snapshot = () => page.evaluate(() => window.consoleApi.rewardsSnapshot());
    const provider = async () => (await snapshot()).providers.find(item => item.id === "workbuddy");
    const mutateFixture = changes => app.evaluate((_electron, changes) => Object.assign(global.__rewardFixture, changes), changes);
    const observedActions = () => app.evaluate(() => global.__rewardFixture.invocations);
    const idle = async () => { await page.locator(".reward-pending").waitFor({ state: "detached" }); };
    const rejectIPC = async (method, args, expression) => {
      const result = await page.evaluate(async ({ method, args }) => {
        try { await window.consoleApi[method](...args); return "NOT_REJECTED"; }
        catch (error) { return String(error); }
      }, { method, args });
      assert.match(result, expression); assertions++;
    };
    await page.getByRole("button", { name: "积分福利", exact: true }).click();
    await page.locator("[data-reward-id]").first().waitFor();
    const initial = await snapshot();
    check(initial.providers.length, 9, "catalog must distinguish all nine regional/platform entries");
    check(initial.providers.filter(p => p.kind === "ui").map(p => p.id), ["qoder", "qoder-cn", "trae", "workbuddy"]);
    check(initial.providers.filter(p => p.kind === "automatic").map(p => p.id), ["qwen", "zcode"]);
    check(initial.providers.filter(p => p.kind === "unknown").map(p => p.id), ["trae-global", "deepseek"]);
    check(initial.providers.filter(p => p.kind === "manual").map(p => p.id), ["claude"]);
    for (const p of initial.providers.filter(p => p.kind !== "ui")) {
      const card = page.locator(`[data-reward-id="${p.id}"]`);
      check(await card.getByRole("button", { name: /校准|管理领取|自动领取/ }).count(), 0, `${p.id} must not expose unsupported automation`);
      check(p.state, "unsupported");
    }
    check(await page.evaluate(() => [typeof window.require, typeof window.process, typeof window.consoleApi.invoke]), ["undefined", "undefined", "undefined"]);
    check(await app.evaluate(({ BrowserWindow }) => {
      const p = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
      return [p.sandbox, p.contextIsolation, p.nodeIntegration];
    }), [true, true, false]);
    await rejectIPC("rewardsInspect", ["not-a-provider"], /未知积分平台/);
    await rejectIPC("rewardsBind", ["qwen"], /没有已支持/);
    await rejectIPC("rewardsRule", ["https://attacker.invalid/"], /未知积分平台/);
    await rejectIPC("rewardsAutomation", ["workbuddy", "true"], /参数无效/);
    await page.locator('[data-reward-id="workbuddy"]').getByRole("button", { name: "官方规则", exact: true }).click();
    await idle();
    check(await app.evaluate(() => global.__rewardFixture.urls), [initial.providers.find(p => p.id === "workbuddy").sourceUrl], "only the fixed official URL is opened");
    await page.screenshot({ path: path.join(results, "rewards-overview.png"), fullPage: true });
    await page.locator('[data-reward-id="workbuddy"]').getByRole("button", { name: "校准领取流程", exact: true }).click();
    const setup = page.getByRole("region", { name: "WorkBuddy 领取配置", exact: true });
    await setup.waitFor();
    const bind = setup.getByRole("button", { name: "绑定客户端 EXE", exact: true });
    await mutateFixture({ cancelFile: true });
    await bind.click(); await idle();
    check((await provider()).profile, undefined, "cancel file selection must not bind");
    await mutateFixture({ cancelFile: false, response: 0 });
    await bind.click(); await idle();
    check((await provider()).profile, undefined, "cancel native confirmation must not bind");
    await mutateFixture({ response: 1 });
    await bind.click(); await idle();
    check((await provider()).profile.executable, executable);
    const bindDialog = await app.evaluate(() => global.__rewardFixture.dialogs.at(-1));
    assert.ok(bindDialog.detail.includes(executable)); assertions++;
    check(bindDialog.defaultId, 0, "native confirmation must default to cancel");
    check((await provider()).profile.enabled, false);
    check(await setup.getByRole("checkbox", { name: "WorkBuddy 自动领取", exact: true }).isDisabled(), true);
    await setup.getByRole("button", { name: "检查窗口", exact: true }).click(); await idle();
    check((await observedActions()).length, 0, "inspection must never invoke a control");
    await setup.getByRole("radio", { name: /Buddy 加油站/ }).check();
    await setup.getByRole("button", { name: "记录并打开导航", exact: true }).click(); await idle();
    check((await observedActions()).map(action => action.name), ["Buddy 加油站"]);
    check((await provider()).profile.navigation.length, 1);
    await setup.getByRole("radio", { name: "领取 Button", exact: true }).check();
    await setup.getByRole("button", { name: "记录领取按钮", exact: true }).click(); await idle();
    check((await provider()).profile.claim.name, "领取");
    check((await observedActions()).length, 1, "recording a claim must not execute it");
    check(await setup.getByRole("button", { name: "手动试领", exact: true }).isDisabled(), true, "context is required before trial");
    await setup.getByRole("button", { name: "检查窗口", exact: true }).click(); await idle();
    await setup.getByLabel("活动上下文", { exact: true }).getByRole("checkbox", { name: "每日免费积分福利", exact: true }).check();
    await setup.getByRole("textbox", { name: "平台成功文本", exact: true }).fill("今日已领取\n领取成功");
    await setup.getByRole("spinbutton", { name: "每日重置时间（北京时间）", exact: true }).fill("0");
    await setup.getByRole("button", { name: "保存验证规则", exact: true }).click(); await idle();
    check((await provider()).profile.context, ["每日免费积分福利"]);
    check((await provider()).profile.successTexts, ["今日已领取", "领取成功"]);
    check((await observedActions()).length, 1, "saving checks must never claim");
    const stale = await page.evaluate(() => window.consoleApi.rewardsInspect("workbuddy"));
    await rejectIPC("rewardsRecord", ["workbuddy", stale.token, 3, "claim"], /不适合积分流程/);
    await rejectIPC("rewardsRecord", ["workbuddy", stale.token, 4, "claim"], /不适合积分流程/);
    await rejectIPC("rewardsRecord", ["workbuddy", stale.token, 2, "navigate"], /单独记录/);
    await rejectIPC("rewardsChecks", ["workbuddy", stale.token, [0], ["当前积分 100"], 0], /成功状态仅支持/);
    await rejectIPC("rewardsRecord", ["workbuddy", "expired-observation", 2, "claim"], /已过期/);
    await mutateFixture({ response: 0 });
    await setup.getByRole("button", { name: "手动试领", exact: true }).click(); await idle();
    check((await observedActions()).length, 1, "cancel trial must not invoke navigation or claim");
    await mutateFixture({ response: 1 });
    await setup.getByRole("button", { name: "手动试领", exact: true }).click(); await idle();
    check((await provider()).state, "claimed");
    check((await provider()).profile.validated, true);
    check((await observedActions()).map(action => action.name), ["Buddy 加油站", "领取"], "already visible panel must skip navigation toggles");
    check((await observedActions()).at(-1).context, ["每日免费积分福利"]);
    const automation = setup.getByRole("checkbox", { name: "WorkBuddy 自动领取", exact: true });
    await mutateFixture({ response: 0 });
    await automation.click(); await idle();
    check((await provider()).profile.enabled, false, "cancel automation confirmation must preserve disabled state");
    await mutateFixture({ response: 1 });
    await automation.click(); await idle();
    check((await provider()).profile.enabled, true);
    const actionsBeforeTick = (await observedActions()).length;
    await app.evaluate(async () => { await global.__rewardService.tick(); await global.__rewardService.tick(); });
    check((await observedActions()).length, actionsBeforeTick, "same daily window must not replay a successful claim");
    await setup.getByRole("button", { name: "手动试领", exact: true }).click(); await idle();
    check((await provider()).state, "already_claimed");
    check((await observedActions()).length, actionsBeforeTick, "platform already-claimed state must not click again");
    await page.screenshot({ path: path.join(results, "rewards-calibrated.png"), fullPage: true });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 800));
    await page.waitForTimeout(250);
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "minimum-width rewards layout must not overflow");
    await page.screenshot({ path: path.join(results, "rewards-compact.png"), fullPage: true });
    await mutateFixture({ stage: "panel", outcome: "unknown" });
    await app.evaluate(() => {
      const tomorrow = Date.now() + 86400000;
      global.__rewardService.now = () => tomorrow;
      global.__rewardService.delay = async () => {};
    });
    await app.evaluate(async () => global.__rewardService.tick());
    check((await provider()).state, "unknown", "lack of platform success must remain unknown");
    check((await provider()).profile.enabled, false, "unknown outcome must stop automatic retries");
    check((await provider()).profile.validated, false);
    const afterUnknown = (await observedActions()).length;
    await app.evaluate(async () => { await global.__rewardService.tick(); await global.__rewardService.tick(); });
    check((await observedActions()).length, afterUnknown, "unknown outcome must never auto-submit again");
    check((await snapshot()).logs.some(log => log.state === "unknown"), true);
    check((await snapshot()).logs.some(log => log.state === "claimed"), true);
    check(fs.readFileSync(executable).equals(pe), true, "fixture executable must remain unchanged");
    const stored = JSON.parse(fs.readFileSync(path.join(data, "console-data", "rewards.json"), "utf8"));
    check(stored.profiles.workbuddy.enabled, false, "disabled state must survive persistence");
    check(stored.states.workbuddy.state, "unknown");
    check(errors, [], "renderer must have no uncaught errors");
    console.log(`PASS rewards desktop: ${assertions} assertions; real Electron/preload/IPC/React, nine platform classes, fixed official links, isolated PE binding and cancel, navigation/claim recording, activity checks, trial confirmation/success, automatic daily dedupe, unknown-result pause, persistence, sandbox and compact layout.`);
    console.log("Vendor controls: fixtures only; no native UIA helper or real account was used.");
    console.log("Screenshots: " + results);
  } finally {
    await app.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
