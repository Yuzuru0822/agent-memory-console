/* Real Electron/preload/IPC/React coverage with an isolated home and a fixture
 * bridge. No native UIA helper, real vendor process or account is accessed. */
const { _electron: electron } = require("playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

(async () => {
  const project = path.resolve(__dirname, "..");
  const fixture = path.resolve(project, "../../work", `rewards-balance-desktop-${Date.now()}`);
  const home = path.join(fixture, "home"), data = path.join(fixture, "user-data");
  const results = path.join(project, "test-results");
  const executable = path.join(fixture, "vendor-fixture.exe");
  for (const directory of [home, data, results]) fs.mkdirSync(directory, { recursive: true });
  const pe = Buffer.alloc(128);
  pe.write("MZ"); pe.writeUInt32LE(64, 60); pe.write("PE\0\0", 64);
  pe.writeUInt16LE(0x8664, 68); pe.writeUInt16LE(0x0002, 86); pe.writeUInt16LE(0x20b, 88);
  fs.writeFileSync(executable, pe); // Validation header only; never executed.
  const app = await electron.launch({ args: [project], env: { ...process.env,
    CONSOLE_DEV: "", CONSOLE_TEST_DATA: data, CONSOLE_TEST_HOME: home }, timeout: 60000 });
  let assertions = 0;
  const check = (actual, expected, message) => { assert.deepEqual(actual, expected, message); assertions++; };
  const errors = [];
  try {
    const page = await app.firstWindow();
    page.on("pageerror", error => errors.push(error.message));
    await page.waitForSelector(".agent-card", { timeout: 20000 });
    await app.evaluate(({ dialog }, fixtureData) => {
      const req = process.mainModule.require.bind(process.mainModule);
      const { WindowsRewardsBridge } = req(fixtureData.bridge);
      const { RewardsBalanceService } = req(fixtureData.balances);
      const state = global.__balanceFixture = { executable: fixtureData.executable,
        title: "Credits Fixture", stage: "home", amount: "1,250.5", response: 1,
        cancelFile: false, available: true, inspections: 0, invocations: [], dialogs: [] };
      const e = (index, name, controlType = "Text", actionable = false) => ({
        index, name, controlType, actionable, automationId: `fixture-${index}`, enabled: true,
      });
      const elements = () => state.stage === "home"
        ? [e(0, "订阅和用量", "Button", true), e(1, "Fixture overview")]
        : state.stage === "missing" ? [e(0, "账户概览")]
        : state.stage === "claim" || state.stage === "claimed" ? [e(0, "每日免费积分福利"), e(1, "免费奖励"),
          e(2, state.stage === "claimed" ? "今日已领取" : "领取", "Button", state.stage !== "claimed")]
        : [e(0, `剩余积分 ${state.amount}`), e(1, "余额明细"), e(2, "充值", "Button", true)];
      WindowsRewardsBridge.prototype.available = () => state.available;
      WindowsRewardsBridge.prototype.inspect = async function (exe, title) {
        if (exe !== state.executable || (title !== undefined && title !== state.title)) throw new Error("Fixture refused unexpected client or window");
        state.inspections++;
        return { title: state.title, elements: elements() };
      };
      WindowsRewardsBridge.prototype.invoke = async function (exe, title, selector, context) {
        if (exe !== state.executable || title !== state.title) throw new Error("Fixture refused unexpected client or window");
        const matches = elements().filter(item => item.name === selector.name && item.automationId === selector.automationId && item.controlType === selector.controlType);
        if (matches.length !== 1 || !matches[0].actionable) throw new Error("Fixture selector unavailable");
        state.invocations.push({ name: selector.name, context });
        if (selector.name === "订阅和用量") state.stage = "balance";
        else if (selector.name === "领取") {
          if (!Array.isArray(context) || !context.includes("每日免费积分福利")) throw new Error("Claim requires activity context");
          state.stage = "claimed";
        } else throw new Error("Fixture refused unrecognized action");
      };
      const snapshot = RewardsBalanceService.prototype.snapshot;
      RewardsBalanceService.prototype.snapshot = function (...args) {
        global.__balanceService = this;
        return snapshot.apply(this, args);
      };
      dialog.showOpenDialog = async () => ({ canceled: state.cancelFile, filePaths: state.cancelFile ? [] : [state.executable] });
      dialog.showMessageBox = async (_window, options) => { state.dialogs.push(options); return { response: state.response, checkboxChecked: false }; };
    }, { executable, bridge: path.join(project, "dist-electron/electron/rewards-windows.js"), balances: path.join(project, "dist-electron/electron/rewards-balance.js") });
    const balances = () => page.evaluate(() => window.consoleApi.rewardBalancesSnapshot());
    const provider = async () => (await balances()).providers.find(item => item.id === "deepseek");
    const rewards = () => page.evaluate(() => window.consoleApi.rewardsSnapshot());
    const fixtureSet = changes => app.evaluate((_electron, changes) => Object.assign(global.__balanceFixture, changes), changes);
    const actions = () => app.evaluate(() => global.__balanceFixture.invocations);
    const idle = async () => { await page.locator(".reward-pending").waitFor({ state: "detached" }); };
    const rejectIPC = async (method, args, expression) => {
      const result = await page.evaluate(async ({ method, args }) => { try { await window.consoleApi[method](...args); return "NOT_REJECTED"; } catch (error) { return String(error); } }, { method, args });
      assert.match(result, expression); assertions++;
    };
    await page.getByRole("button", { name: "积分福利", exact: true }).click();
    await page.locator("[data-balance-id]").first().waitFor();
    check((await balances()).providers.length, 9);
    check(await page.getByRole("button", { name: "配置余额监控", exact: true }).count(), 9, "all providers can independently monitor balance");
    check(await page.locator(".reward-balance-value").allTextContents(), Array(9).fill("尚未读取"), "unconfigured values must not be fabricated as zero");
    check((await balances()).providers.every(item => item.status === "unconfigured" && !item.sample && !item.low), true);
    await rejectIPC("rewardBalanceInspect", ["unknown-provider"], /未知积分平台/);
    await rejectIPC("rewardBalanceAutomation", ["deepseek", "true"], /无效/);

    const card = page.locator('[data-reward-id="deepseek"]');
    check(await card.getByRole("button", { name: /校准领取|管理领取/ }).count(), 0);
    check((await rewards()).providers.find(item => item.id === "deepseek").state, "unsupported");
    await card.getByRole("button", { name: "配置余额监控", exact: true }).click();
    const setup = page.getByRole("region", { name: "DeepSeek Harness 余额监控配置", exact: true });
    await setup.waitFor();
    const bind = setup.getByRole("button", { name: "绑定余额客户端 EXE", exact: true });
    await fixtureSet({ cancelFile: true });
    await bind.click(); await idle();
    check((await provider()).profile, undefined, "cancelled file dialog cannot bind");
    await fixtureSet({ cancelFile: false, response: 0 });
    await bind.click(); await idle();
    check((await provider()).profile, undefined, "cancelled confirmation cannot bind");
    await fixtureSet({ response: 1 });
    await bind.click(); await idle();
    check((await provider()).profile.executable, executable);
    check((await provider()).profile.enabled, false);
    const bindDialog = await app.evaluate(() => global.__balanceFixture.dialogs.at(-1));
    check(bindDialog.defaultId, 0);
    assert.ok(bindDialog.detail.includes(executable)); assertions++;
    check((await rewards()).providers.find(item => item.id === "deepseek").profile, undefined, "balance bind must not authorize claims");

    await setup.getByRole("button", { name: "检查余额窗口", exact: true }).click(); await idle();
    check((await actions()).length, 0, "inspect is read only");
    await setup.getByRole("radiogroup", { name: "余额导航控件", exact: true }).getByRole("radio", { name: "订阅和用量 Button", exact: true }).check();
    const inspected = await app.evaluate(() => global.__balanceFixture.inspections);
    await setup.getByRole("button", { name: "记录并打开余额导航", exact: true }).click(); await idle();
    check((await actions()).map(item => item.name), ["订阅和用量"]);
    check((await provider()).profile.navigation.length, 1);
    assert.ok(await app.evaluate(() => global.__balanceFixture.inspections) > inspected); assertions++;
    const label = setup.getByRole("radiogroup", { name: "余额标题", exact: true });
    const value = setup.getByRole("radiogroup", { name: "余额数值", exact: true });
    check(await setup.getByRole("radiogroup", { name: "余额导航控件", exact: true }).getByRole("radio", { name: "充值 Button", exact: true }).count(), 0, "paid actions must not be offered as balance navigation");
    await label.getByRole("radio", { name: "剩余积分 1,250.5", exact: true }).check();
    await value.getByRole("radio", { name: "剩余积分 1,250.5", exact: true }).check();
    await setup.getByRole("combobox", { name: "余额单位", exact: true }).selectOption("Credits");
    check(await setup.getByRole("combobox", { name: "余额单位", exact: true }).locator("option").allTextContents(), ["积分", "Credits", "CNY", "USD"]);
    const interval = setup.getByRole("spinbutton", { name: "余额刷新周期", exact: true });
    const save = setup.getByRole("button", { name: "保存余额监控规则", exact: true });
    await interval.fill("4");
    check(await save.isDisabled(), true, "invalid interval blocked in UI");
    await interval.fill("15");
    await setup.getByRole("spinbutton", { name: "低余额提醒阈值", exact: true }).fill("50");
    await setup.screenshot({ path: path.join(results, "rewards-balance-calibration.png") });
    await save.click(); await idle();
    let current = await provider();
    check(current.sample.value, 1250.5);
    check(current.sample.unit, "Credits");
    check(current.profile.selector.layout, "inline");
    check(current.profile.intervalMinutes, 15);
    check(current.profile.lowThreshold, 50);
    check(current.profile.enabled, false);
    check(current.sample.delta, undefined);
    check(current.history.length, 1);
    check((await card.locator(".reward-balance-field").innerText()).trim(), "监控字段：剩余积分", "card must identify the monitored field rather than implying an account total");
    check(await setup.getByRole("radiogroup", { name: "余额标题", exact: true }).count(), 0, "save invalidates observation and old selections");

    // New observations must clear both selected fields, even if the values match.
    await setup.getByRole("button", { name: "检查余额窗口", exact: true }).click(); await idle();
    check(await setup.locator('input[name="balance-label"]:checked').count(), 0);
    check(await setup.locator('input[name="balance-value"]:checked').count(), 0);
    const observed = await page.evaluate(() => window.consoleApi.rewardBalanceInspect("deepseek"));
    await rejectIPC("rewardBalanceConfigure", ["deepseek", observed.token, 0, 0, "BTC", 15], /无效/);
    await rejectIPC("rewardBalanceConfigure", ["deepseek", observed.token, 0, 0, "Credits", 1], /无效/);
    await rejectIPC("rewardBalanceNavigate", ["deepseek", observed.token, 2], /不允许|仅允许/);
    await page.evaluate(() => window.consoleApi.rewardBalanceInspect("deepseek"));
    await rejectIPC("rewardBalanceConfigure", ["deepseek", observed.token, 0, 0, "Credits", 15], /过期/);

    const refresh = setup.getByRole("button", { name: "读取最新余额", exact: true });
    await fixtureSet({ amount: "1,200.25" });
    await refresh.click(); await idle();
    current = await provider();
    check(current.sample.value, 1200.25);
    check(current.sample.delta, -50.25);
    check(current.history.length, 2);
    check(await card.locator(".reward-balance-value").innerText(), "1,200.25\nCredits");
    await fixtureSet({ amount: "0" });
    await refresh.click(); await idle();
    current = await provider();
    check(current.sample.value, 0, "a genuine zero must be displayed");
    check(current.sample.delta, -1200.25);
    check(current.low, true);
    check(current.stale, false);
    check(await card.locator(".reward-balance-alert").count(), 1);
    await fixtureSet({ stage: "missing" });
    await refresh.click(); await idle();
    current = await provider();
    check(current.status, "error");
    check(current.sample.value, 0, "read failure preserves last successful sample");
    check(current.history.length, 3, "read failure does not append a fake zero");
    check(current.stale, true);
    check(current.low, false, "stale low balance must not trigger a current low alert");
    check(await card.locator(".reward-balance-alert").count(), 0);
    assert.match(await card.locator(".reward-balance-summary").innerText(), /读取失败/); assertions++;
    await fixtureSet({ stage: "balance", amount: "42" });
    await refresh.click(); await idle();
    check((await provider()).sample.value, 42);
    check((await provider()).low, true);
    check(await setup.locator(".reward-balance-history tbody tr").count(), 4);
    check((await actions()).map(item => item.name), ["订阅和用量"], "balance refresh never invokes a claim or unnecessary navigation");
    const toggle = setup.getByRole("checkbox", { name: "DeepSeek Harness 自动监控余额", exact: true });
    await fixtureSet({ response: 0 });
    await toggle.click(); await idle();
    check((await provider()).profile.enabled, false, "cancel automatic monitoring leaves it disabled");
    await fixtureSet({ response: 1 });
    await toggle.click(); await idle();
    check((await provider()).profile.enabled, true);
    const stored = JSON.parse(fs.readFileSync(path.join(data, "console-data", "balances.json"), "utf8"));
    check(stored.profiles.deepseek.enabled, true);
    check(stored.states.deepseek.history.at(-1).value, 42);
    await app.evaluate(() => global.__balanceService.tick());
    check((await provider()).history.length, 4, "scheduler must respect the next sample time");

    await setup.screenshot({ path: path.join(results, "rewards-balance-panel.png") });
    await page.locator(".rewards-platform-grid").screenshot({ path: path.join(results, "rewards-balance-cards.png") });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 800));
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "compact layout must not overflow");
    await setup.screenshot({ path: path.join(results, "rewards-balance-compact.png") });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 1000));

    // The one-step start button still requires native confirmation and a real
    // success state from the fixture, rather than merely enabling a checkbox.
    await fixtureSet({ stage: "claim", response: 1 });
    await page.evaluate(async () => {
      const api = window.consoleApi;
      await api.rewardsBind("workbuddy");
      let observed = await api.rewardsInspect("workbuddy");
      await api.rewardsRecord("workbuddy", observed.token, 2, "claim");
      observed = await api.rewardsInspect("workbuddy");
      await api.rewardsChecks("workbuddy", observed.token, [0], ["今日已领取"], 0);
    });
    await page.getByRole("button", { name: "刷新状态", exact: true }).click();
    await page.locator('[data-reward-id="workbuddy"]').getByRole("button", { name: "管理领取流程", exact: true }).click();
    const claimSetup = page.getByRole("region", { name: "WorkBuddy 领取配置", exact: true });
    const start = claimSetup.getByRole("button", { name: "验证并开启自动领取", exact: true });
    check(await start.isEnabled(), true);
    const before = (await actions()).length;
    await fixtureSet({ response: 0 });
    await start.click(); await idle();
    check((await actions()).length, before, "cancel start does not submit a claim");
    check((await rewards()).providers.find(item => item.id === "workbuddy").profile.enabled, false);
    await fixtureSet({ response: 1 });
    await start.click(); await idle();
    const reward = (await rewards()).providers.find(item => item.id === "workbuddy");
    check(reward.state, "claimed");
    check(reward.profile.validated, true);
    check(reward.profile.enabled, true);
    check((await actions()).at(-1).name, "领取");
    check(await start.isDisabled(), true, "enabled automation should not be started twice");
    check((await rewards()).providers.find(item => item.id === "deepseek").state, "unsupported");
    check(fs.readFileSync(executable).equals(pe), true, "fixture executable remains unchanged");
    check(await page.evaluate(() => [typeof window.require, typeof window.process, typeof window.consoleApi.invoke]), ["undefined", "undefined", "undefined"]);
    check(errors, [], "renderer must not throw");
    console.log(`PASS rewards balance desktop: ${assertions} assertions; isolated nine-platform states, independent unsupported-platform balance binding, confirmation cancellation, readonly inspect/navigation, inline calibration, validation, values/delta/zero/low/stale/history, monitoring persistence, verified automatic claim start and compact layout.`);
    console.log("Vendor controls: fixtures only; no native UIA helper or real account was used.");
    console.log("Screenshots: " + results);
  } finally { await app.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
