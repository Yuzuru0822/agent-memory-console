/* Task center renderer/preload coverage using isolated storage and six controlled
 * IPC handlers. Never creates a tray, changes user preferences or accesses UIA. */
const { _electron: electron } = require("playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

(async () => {
  const project = path.resolve(__dirname, "..");
  const fixture = path.resolve(project, "../../work", `tasks-desktop-${Date.now()}`);
  const home = path.join(fixture, "home"), data = path.join(fixture, "user-data");
  const results = path.join(project, "test-results");
  for (const directory of [home, data, results]) fs.mkdirSync(directory, { recursive: true });
  const app = await electron.launch({ args: [project], env: { ...process.env,
    CONSOLE_DEV: "", CONSOLE_TEST_DATA: data, CONSOLE_TEST_HOME: home }, timeout: 60000 });
  let assertions = 0;
  const check = (actual, expected, message) => { assert.deepEqual(actual, expected, message); assertions++; };
  const errors = [];
  try {
    const page = await app.firstWindow();
    page.on("pageerror", error => errors.push(error.message));
    await page.waitForSelector(".agent-card", { timeout: 20000 });
    await app.evaluate(({ ipcMain }) => {
      const names = ["Qoder 国际", "Qoder CN", "TRAE CN", "WorkBuddy", "Claude Code CLI", "TRAE 国际", "千问 Work", "智谱 Zcode", "DeepSeek Harness"];
      const ids = ["qoder", "qoder-cn", "trae", "workbuddy", "claude", "trae-global", "qwen", "zcode", "deepseek"];
      const at = new Date().toISOString();
      const tasks = [
        { id: "repository-sync", kind: "sync", name: "统一仓库记忆同步", state: "scheduled", enabled: true, message: "按计划双向合并；保留两端内容。", target: "repository", lastAttempt: at, nextCheck: at },
        { id: "repository-cleanup", kind: "cleanup", name: "过期备份清理", state: "disabled", enabled: false, message: "自动清理未启用。", target: "repository" },
        ...ids.map((id, index) => ({ id: `claim-${id}`, kind: "claim", name: `${names[index]} 自动领取`, providerId: id,
          state: ["scheduled", "attention", "waiting", "disabled", "unsupported", "unsupported", "unsupported", "unconfigured", "unsupported"][index],
          enabled: index < 3, message: index === 1 ? "上次领取结果未确认，需要重新校准。" : index === 2 ? "等待平台领取时间。" : index === 0 ? "等待下一次领取窗口。" : "请查看该平台的配置与支持范围。", target: "rewards", lastAttempt: index < 3 ? at : undefined, nextCheck: index === 0 ? at : undefined })),
        ...ids.map((id, index) => ({ id: `balance-${id}`, kind: "balance", name: `${names[index]} 余额监控`, providerId: id,
          state: ["running", "attention", "scheduled", "unconfigured", "disabled", "unconfigured", "unconfigured", "unconfigured", "unconfigured"][index],
          enabled: index < 3, message: index === 1 ? "最新余额读取失败；保留旧余额并标记过期。" : index === 0 ? "正在读取已配置的积分余额。" : "尚未到达下次余额检查时间。", target: "rewards", lastAttempt: index < 3 ? at : undefined, nextCheck: index === 2 ? at : undefined })),
      ];
      const state = global.__tasksFixture = {
        controls: { paused: false, closeToTray: false }, runtime: { busy: true, trayAvailable: false, windowVisible: true }, tasks,
        issues: [
          { id: "repo-conflict", severity: "error", title: "记忆合并存在冲突", detail: "请选择要保留的内容后再同步。", target: "repository" },
          { id: "balance-stale", severity: "warning", title: "Qoder CN 余额过期", detail: "请确认客户端已登录，并重新读取余额。", target: "rewards", providerId: "qoder-cn" },
        ], calls: [], snapshots: 0, controlsReads: 0, failSnapshot: false, failAction: "", delayAction: "", resolveAction: null,
      };
      const clonedControls = () => JSON.parse(JSON.stringify({ controls: state.controls, runtime: state.runtime }));
      const handle = (method, handler) => { const channel = `console:${method}`; ipcMain.removeHandler(channel); ipcMain.handle(channel, handler); };
      const mutation = async (method, value, update) => {
        state.calls.push({ method, value });
        if (state.delayAction === method) await new Promise(resolve => { state.resolveAction = resolve; });
        if (state.failAction === method) throw new Error("模拟保存失败，设置未变更");
        update();
        return { message: method === "report" ? "报告已保存到所选本地位置" : "任务控制设置已更新" };
      };
      handle("taskCenterSnapshot", () => {
        state.snapshots++;
        if (state.failSnapshot) throw new Error("模拟状态读取失败");
        return { ...clonedControls(), at: new Date().toISOString(), tasks: state.tasks.map(task => ({ ...task,
          state: state.controls.paused && task.enabled && ["scheduled", "waiting"].includes(task.state) ? "paused" : task.state })), issues: state.issues };
      });
      handle("taskControlsSnapshot", () => { state.controlsReads++; return clonedControls(); });
      handle("taskPause", (_event, minutes) => mutation("pause", minutes, () => {
        state.controls.paused = true; state.controls.pausedAt = new Date().toISOString();
        state.controls.pauseUntil = minutes === null ? undefined : new Date(Date.now() + minutes * 60000).toISOString();
      }));
      handle("taskResume", () => mutation("resume", undefined, () => { state.controls.paused = false; delete state.controls.pauseUntil; delete state.controls.pausedAt; delete state.controls.error; }));
      handle("taskTray", (_event, enabled) => mutation("tray", enabled, () => { state.controls.closeToTray = enabled; state.runtime.trayAvailable = enabled; }));
      handle("taskReport", (_event, kind) => mutation("report", kind, () => {}));
    });
    await page.reload();
    await page.waitForSelector(".agent-card");
    const state = () => app.evaluate(() => {
      const { resolveAction, ...rest } = global.__tasksFixture;
      return rest;
    });
    const set = changes => app.evaluate((_electron, changes) => Object.assign(global.__tasksFixture, changes), changes);
    const idle = () => page.locator(".tasks-pending").waitFor({ state: "detached" });
    const refresh = async () => {
      const before = (await state()).snapshots;
      await page.getByRole("button", { name: "刷新任务", exact: true }).click();
      await page.waitForFunction(() => !document.querySelector('.tasks-heading button:disabled'));
      assert.ok((await state()).snapshots > before); assertions++;
    };
    check(await page.getByRole("button", { name: "任务中心", exact: true }).count(), 1);
    await page.getByRole("button", { name: "任务中心", exact: true }).click();
    const center = page.getByRole("region", { name: "自动任务中心", exact: true });
    await page.locator("[data-task-id]").first().waitFor();
    check(await page.locator("[data-task-id]").count(), 20);
    check(await center.locator(".task-group").count(), 4);
    check(await center.locator(".tasks-summary strong").allTextContents(), ["20", "7", "1", "3"]);
    check(await center.locator("[data-task-issue]").count(), 2);
    check(await center.getByRole("button", { name: "恢复自动任务", exact: true }).isDisabled(), true);
    check(await center.getByRole("checkbox", { name: "关闭窗口后留在系统托盘", exact: true }).isChecked(), false);
    check(await center.getByRole("checkbox", { name: "关闭窗口后留在系统托盘", exact: true }).isDisabled(), false, "tray can first be enabled before it exists");
    check(await page.locator('[data-task-id="repository-cleanup"] dd').allTextContents(), ["未启用", "—", "—"]);
    assert.match(await page.locator('[data-task-id="claim-qoder-cn"]').innerText(), /结果未确认/); assertions++;
    assert.match(await page.locator('[data-task-id="claim-claude"]').innerText(), /未支持自动执行/); assertions++;
    assert.match(await center.getByRole("region", { name: "自动任务总开关", exact: true }).innerText(), /手动操作仍可使用/); assertions++;
    await page.screenshot({ path: path.join(results, "tasks-center.png"), fullPage: false });

    await center.getByRole("button", { name: "积分领取 9", exact: true }).click();
    check(await page.locator("[data-task-id]").count(), 9);
    await center.getByRole("checkbox", { name: "只看需要关注", exact: true }).check();
    check(await page.locator("[data-task-id]").count(), 2);
    await center.getByRole("textbox", { name: "搜索自动任务", exact: true }).fill("未确认");
    check(await page.locator("[data-task-id]").count(), 1);
    await center.getByRole("textbox", { name: "搜索自动任务", exact: true }).fill("not-a-task");
    check(await page.locator("[data-task-id]").count(), 0);
    await center.getByRole("button", { name: "清除筛选", exact: true }).click();
    check(await page.locator("[data-task-id]").count(), 20);

    const originalEnabled = (await state()).tasks.map(task => task.enabled);
    await center.getByRole("button", { name: "暂停 15 分钟", exact: true }).click(); await idle();
    check((await state()).calls.at(-1), { method: "pause", value: 15 });
    check((await state()).controls.paused, true);
    assert.ok(Date.parse((await state()).controls.pauseUntil) - Date.now() > 14 * 60000); assertions++;
    const banner = page.getByRole("status", { name: "自动任务全局状态", exact: true });
    await banner.waitFor();
    assert.match(await banner.innerText(), /已有操作正在收尾/); assertions++;
    check(await page.locator('[data-task-id="balance-qoder"] .badge').innerText(), "执行中", "pause must not imply termination of in-flight work");
    check(await page.locator('[data-task-id="claim-qoder"] .badge').innerText(), "已暂停");
    check(await page.locator('[data-task-id="claim-qoder-cn"] .badge').innerText(), "需要处理");
    await page.getByRole("button", { name: "监控总览", exact: true }).click();
    check(await page.locator(".tasks-page").count(), 0);
    check(await banner.count(), 1, "global pause visible away from task center");
    const unmounted = (await state()).snapshots;
    const controlsReads = (await state()).controlsReads;
    await page.waitForTimeout(5600);
    check((await state()).snapshots, unmounted, "full task polling stops after leaving the page");
    assert.ok((await state()).controlsReads > controlsReads); assertions++;
    await banner.getByRole("button", { name: "查看任务中心", exact: true }).click();
    await page.locator("[data-task-id]").first().waitFor();
    await center.getByRole("button", { name: "暂停 1 小时", exact: true }).click(); await idle();
    check((await state()).calls.at(-1), { method: "pause", value: 60 });
    await center.getByRole("button", { name: "暂停直到恢复", exact: true }).click(); await idle();
    check((await state()).calls.at(-1), { method: "pause", value: null });
    check((await state()).controls.pauseUntil, undefined);
    assert.match(await banner.innerText(), /暂停直到主动恢复/); assertions++;
    check((await state()).tasks.map(task => task.enabled), originalEnabled, "pause preserves each independent switch");
    await center.getByRole("button", { name: "恢复自动任务", exact: true }).click(); await idle();
    check((await state()).controls.paused, false);
    check(await banner.count(), 0);
    check((await state()).tasks.map(task => task.enabled), originalEnabled, "resume does not enable disabled tasks");
    check(await page.locator('[data-task-id="claim-qoder-cn"] .badge').innerText(), "需要处理", "resume does not erase uncertain claim status");

    await set({ delayAction: "pause" });
    await center.getByRole("button", { name: "暂停 15 分钟", exact: true }).click();
    await page.locator(".tasks-pending").waitFor();
    check(await center.getByRole("button", { name: "暂停 1 小时", exact: true }).isDisabled(), true);
    check(await center.getByRole("button", { name: "任务报告 CSV", exact: true }).isDisabled(), true);
    check(await center.getByRole("checkbox", { name: "关闭窗口后留在系统托盘", exact: true }).isDisabled(), true);
    await refresh();
    check(await page.locator(".tasks-pending").count(), 1, "status can refresh while a mutation is pending");
    await app.evaluate(() => { global.__tasksFixture.delayAction = ""; global.__tasksFixture.resolveAction(); global.__tasksFixture.resolveAction = null; });
    await idle();
    await set({ failAction: "resume" });
    await center.getByRole("button", { name: "恢复自动任务", exact: true }).click(); await idle();
    assert.match(await center.locator(".tasks-notice.is-error").innerText(), /模拟保存失败/); assertions++;
    check((await state()).controls.paused, true);
    check(await banner.count(), 1);
    await set({ failAction: "" });
    await center.getByRole("button", { name: "恢复自动任务", exact: true }).click(); await idle();
    check((await state()).controls.paused, false);

    const tray = center.getByRole("checkbox", { name: "关闭窗口后留在系统托盘", exact: true });
    await tray.click(); await idle();
    check((await state()).calls.at(-1), { method: "tray", value: true });
    check(await tray.isChecked(), true);
    await tray.click(); await idle();
    check((await state()).controls.closeToTray, false);
    assert.match(await center.getByRole("region", { name: "后台运行设置", exact: true }).innerText(), /关闭窗口仍会运行自动任务/); assertions++;
    await center.getByRole("button", { name: "任务报告 CSV", exact: true }).click(); await idle();
    check((await state()).calls.at(-1), { method: "report", value: "tasks" });
    await center.getByRole("button", { name: "余额记录 CSV", exact: true }).click(); await idle();
    check((await state()).calls.at(-1), { method: "report", value: "balances" });

    await set({ failSnapshot: true });
    await refresh();
    check(await page.locator("[data-task-id]").count(), 20, "failed refresh preserves the previous snapshot");
    assert.match(await center.locator(".tasks-notice.is-error").innerText(), /信息可能已过期/); assertions++;
    await set({ failSnapshot: false });
    await refresh();
    check(await center.locator(".tasks-notice.is-error").count(), 0);
    await app.evaluate(() => {
      const state = global.__tasksFixture;
      state.controls.error = "控制文件无法读取";
      state.controls.paused = true;
      state.controls.closeToTray = true;
      state.runtime.trayAvailable = false;
      state.runtime.calibrationUntil = new Date(Date.now() + 60000).toISOString();
      state.issues = [];
    });
    await refresh();
    check(await tray.isDisabled(), false, "broken tray setting can be disabled");
    assert.match(await center.getByRole("region", { name: "后台运行设置", exact: true }).innerText(), /系统托盘尚未就绪/); assertions++;
    assert.match(await banner.innerText(), /控制文件无法读取/); assertions++;
    assert.match(await center.locator(".tasks-clear").innerText(), /没有已报告的问题/); assertions++;
    assert.match(await center.getByRole("region", { name: "自动任务总开关", exact: true }).innerText(), /客户端校准中/); assertions++;
    await center.getByRole("button", { name: "恢复自动任务", exact: true }).click(); await idle();
    check((await state()).controls.error, undefined);
    await app.evaluate(() => {
      const state = global.__tasksFixture;
      state.controls.closeToTray = false;
      state.runtime.busy = false; state.runtime.trayAvailable = true; delete state.runtime.calibrationUntil;
      state.issues = [{ id: "repo-conflict", severity: "error", title: "记忆合并存在冲突", detail: "请选择要保留的内容后再同步。", target: "repository" },
        { id: "balance-stale", severity: "warning", title: "Qoder CN 余额过期", detail: "请确认客户端已登录，并重新读取余额。", target: "rewards", providerId: "qoder-cn" }];
    });
    await refresh();
    await center.getByRole("button", { name: "处理问题：记忆合并存在冲突", exact: true }).click();
    await page.locator(".repository-page").waitFor();
    check(await page.locator(".tasks-page").count(), 0);
    await page.getByRole("button", { name: "任务中心", exact: true }).click();
    await center.getByRole("button", { name: "处理问题：Qoder CN 余额过期", exact: true }).click();
    await page.locator(".rewards-page").waitFor();
    check(await page.locator(".tasks-page").count(), 0);
    await page.getByRole("button", { name: "任务中心", exact: true }).click();
    await center.getByRole("button", { name: "配置任务：统一仓库记忆同步", exact: true }).click();
    await page.locator(".repository-page").waitFor();
    await page.getByRole("button", { name: "任务中心", exact: true }).click();
    await center.getByRole("button", { name: "配置任务：Qoder 国际 自动领取", exact: true }).click();
    await page.locator(".rewards-page").waitFor();
    await page.getByRole("button", { name: "任务中心", exact: true }).click();
    await page.locator("[data-task-id]").first().waitFor();
    await page.setViewportSize({ width: 1000, height: 760 });
    await page.evaluate(() => window.scrollTo(0, 0));
    check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, "1000px layout cannot overflow horizontally");
    check(await page.evaluate(() => { const sidebar = document.querySelector('.sidebar').getBoundingClientRect(); const last = document.querySelector('.nav-items button:last-child').getBoundingClientRect(); return last.bottom <= sidebar.bottom; }), true, "all eight navigation items remain reachable");
    await page.screenshot({ path: path.join(results, "tasks-compact.png"), fullPage: false });
    await center.getByRole("button", { name: "余额监控 9", exact: true }).click();
    await center.locator(".tasks-inventory").scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(results, "tasks-inventory.png"), fullPage: false });
    check(await page.locator("[data-task-id]").count(), 9);
    check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    check(errors, []);
    console.log(`PASS tasks desktop: ${assertions} assertions; task controls, filters, global pause, pending/errors, navigation, reports and 1000px layout. No real tray or vendor UIA.`);
  } finally { await app.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
