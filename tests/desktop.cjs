/* Real Electron smoke test with isolated fixture files. Never uses the user's agents. */
const { _electron: electron } = require("playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

(async () => {
  const project = path.resolve(__dirname, "..");
  const fixture = path.resolve(
    project,
    "../../work",
    `desktop-fixture-${Date.now()}`,
  );
  const home = path.join(fixture, "home");
  const data = path.join(fixture, "user-data");
  const results = path.join(project, "test-results");
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  };
  const target = path.join(home, ".workbuddy", "MEMORY.md");
  const source = path.join(fixture, "shared", "MEMORY.md");
  const skillSource = path.join(fixture, "shared", "skills");
  const skillTarget = path.join(home, ".workbuddy", "skills");
  const before = "# Local memory\n\nExisting notes, preserved in backup.\n";
  const after = "# Shared memory\n\nUse UTF-8. Keep changes reviewable.\n";
  write(target, before);
  write(source, after);
  write(
    path.join(skillSource, "review", "SKILL.md"),
    "---\nname: review\ndescription: Review a change\n---\nCheck correctness and safety.\n",
  );
  write(
    path.join(skillTarget, "review", "SKILL.md"),
    "# Earlier review skill\n",
  );
  write(path.join(home, ".trae-cn", "memory", "user_profile.md"), after);
  write(
    path.join(home, ".trae-cn", "skills", "planning", "SKILL.md"),
    "# Planning\n",
  );
  write(path.join(home, ".claude", "CLAUDE.md"), "# Claude instructions\n");
  write(path.join(home, ".claude", "skills", "notes", "SKILL.md"), "# Notes\n");
  write(path.join(home, ".dsh", "AGENTS.md"), "# Harness instructions\n");
  const npmPrefix = path.join(home, "AppData", "Roaming", "npm");
  const npmEntry = path.join(npmPrefix, "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
  write(path.join(npmPrefix, "claude.cmd"), "@echo fixture - must never be executed");
  write(path.join(npmPrefix, "node_modules", "@anthropic-ai", "claude-code", "package.json"), JSON.stringify({name:"@anthropic-ai/claude-code",version:"2.1.243",bin:{claude:"bin/claude.exe"}}));
  const pe = Buffer.alloc(128);
  pe.write("MZ"); pe.writeUInt32LE(64,60); pe.write("PE\0\0",64); pe.writeUInt16LE(0x8664,68); pe.writeUInt16LE(0x0002,86); pe.writeUInt16LE(0x20b,88);
  write(npmEntry, pe); // Format fixture only; never launched.
  write(
    path.join(data, "console-data", "config.json"),
    JSON.stringify(
      {
        version: 1,
        canonicalMemory: source,
        canonicalSkills: skillSource,
        agents: { workbuddy: { memory: target, skills: skillTarget } },
      },
      null,
      2,
    ),
  );
  fs.mkdirSync(results, { recursive: true });
  const app = await electron.launch({
    args: [project],
    env: {
      ...process.env,
      CONSOLE_DEV: "",
      CONSOLE_TEST_DATA: data,
      CONSOLE_TEST_HOME: home,
    },
    timeout: 60000,
  });
  const errors = [];
  try {
    const page = await app.firstWindow();
    page.on("pageerror", (e) => errors.push(e.message));
    await page.waitForSelector(".agent-card", { timeout: 20000 });
    assert.equal(await page.locator(".agent-card").count(), 6);
    assert.equal(await page.evaluate(() => typeof window.require), "undefined");
    assert.equal(
      await page.evaluate(() => typeof window.consoleApi.snapshot),
      "function",
    );
    const security = await app.evaluate(({ BrowserWindow }) => {
      const prefs =
        BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
      return {
        sandbox: prefs.sandbox,
        contextIsolation: prefs.contextIsolation,
        nodeIntegration: prefs.nodeIntegration,
      };
    });
    assert.deepEqual(security, {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    });
    await page.getByLabel("选择 WorkBuddy", { exact: true }).check();
    await page
      .getByRole("button", { name: "预览记忆同步", exact: true })
      .click();
    await page.getByRole("dialog", { name: "同步与恢复预览" }).waitFor();
    assert.match(await page.locator(".diff").innerText(), /Local memory/);
    assert.match(await page.locator(".diff").innerText(), /Shared memory/);
    await page.screenshot({ path: path.join(results, "sync-preview.png") });
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({
        response: 0,
        checkboxChecked: false,
      });
    });
    await page.getByRole("button", { name: "确认并执行", exact: true }).click();
    await page
      .getByRole("dialog", { name: "同步与恢复预览" })
      .waitFor({ state: "detached" });
    assert.equal(
      fs.readFileSync(target, "utf8"),
      before,
      "cancel must not write",
    );
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({
        response: 1,
        checkboxChecked: false,
      });
    });
    await page
      .getByRole("button", { name: "预览记忆同步", exact: true })
      .click();
    await page.getByRole("dialog", { name: "同步与恢复预览" }).waitFor();
    await page.getByRole("button", { name: "确认并执行", exact: true }).click();
    await page
      .getByRole("dialog", { name: "同步与恢复预览" })
      .waitFor({ state: "detached" });
    assert.equal(fs.readFileSync(target, "utf8"), after);
    let state = await page.evaluate(() => window.consoleApi.snapshot());
    assert.equal(state.backups.length, 1);
    assert.equal(state.auditValid, true);
    await page
      .getByRole("button", { name: "预览技能同步", exact: true })
      .click();
    await page.getByRole("dialog", { name: "同步与恢复预览" }).waitFor();
    await page.getByRole("button", { name: "确认并执行", exact: true }).click();
    await page
      .getByRole("dialog", { name: "同步与恢复预览" })
      .waitFor({ state: "detached" });
    assert.equal(
      fs.readFileSync(path.join(skillTarget, "review", "SKILL.md"), "utf8"),
      fs.readFileSync(path.join(skillSource, "review", "SKILL.md"), "utf8"),
    );
    const restore = await page.evaluate(
      (id) => window.consoleApi.restore(id),
      state.backups[0].id,
    );
    await page.evaluate((id) => window.consoleApi.apply(id), restore.id);
    assert.equal(fs.readFileSync(target, "utf8"), before);
    const invalid = await page.evaluate(async () => {
      try {
        await window.consoleApi.backup("not-an-agent");
        return false;
      } catch {
        return true;
      }
    });
    assert.equal(invalid, true);
    const denied = await page.evaluate(async () => {
      try {
        await window.consoleApi.launch("workbuddy");
        return false;
      } catch {
        return true;
      }
    });
    assert.equal(denied, true, "unapproved executable must not launch");
    await page.getByRole("button", { name: "刷新", exact: true }).click();
    await page
      .locator(".agent-card")
      .first()
      .getByRole("button", { name: /查看检查与配置/ })
      .click();
    await page.getByRole("dialog", { name: "WorkBuddy 详情" }).waitFor();
    assert.equal(
      await page
        .getByRole("button", { name: "启动程序", exact: true })
        .isDisabled(),
      true,
    );
    await page.screenshot({ path: path.join(results, "agent-details.png") });
    await page.getByRole("button", { name: "关闭详情", exact: true }).click();
    await page.locator(".agent-card").filter({hasText:"Claude Code CLI"}).getByRole("button", {name:/查看检查与配置/}).click();
    await page.getByRole("dialog", {name:"Claude Code CLI 详情"}).waitFor();
    const npmApproval = page.getByRole("button", {name:"授权检测到的 npm 安装",exact:true});
    await npmApproval.waitFor();
    assert.match(await page.locator(".npm-installation").innerText(), /2\.1\.243/);
    const npmBefore = await page.evaluate(()=>window.consoleApi.snapshot());
    assert.equal(npmBefore.agents.find(a=>a.id==='claude').executableApproved,false);
    await app.evaluate(({dialog})=>{dialog.showMessageBox=async()=>({response:0,checkboxChecked:false});});
    await npmApproval.click();
    await page.waitForFunction(()=>document.querySelector('[role=status]')?.textContent.includes('未授权 npm'));
    assert.equal((await page.evaluate(()=>window.consoleApi.snapshot())).agents.find(a=>a.id==='claude').executableApproved,false);
    await app.evaluate(({dialog})=>{dialog.showMessageBox=async(_window,options)=>{
      if(!options.detail.includes('bin') || !options.detail.includes('2.1.243')) throw new Error('npm confirmation must show the actual entry and version');
      return {response:1,checkboxChecked:false};
    };});
    await npmApproval.click();
    await page.waitForFunction(()=>document.querySelector('.npm-installation')?.textContent.includes('已授权 npm'));
    const npmAfter = (await page.evaluate(()=>window.consoleApi.snapshot())).agents.find(a=>a.id==='claude');
    assert.equal(npmAfter.npmInstallation.entry,npmEntry);
    assert.equal(npmAfter.executableApproved,true);
    assert.equal(await page.getByRole('button',{name:'运行任务',exact:true}).isDisabled(),true,'workspace and task are still required');
    await page.screenshot({path:path.join(results,'npm-installation.png')});
    await page.evaluate(()=>window.consoleApi.clear('claude','executable'));
    assert.equal((await page.evaluate(()=>window.consoleApi.snapshot())).agents.find(a=>a.id==='claude').npmInstallation,undefined);
    await page.getByRole("button", { name: "关闭详情", exact: true }).click();
    for (const label of [
      "记忆与技能",
      "备份快照",
      "活动台账",
      "集成能力",
      "监控总览",
    ]) {
      await page.getByRole("button", { name: label, exact: true }).click();
    }
    await page
      .getByRole("button", { name: "关闭提示", exact: true })
      .click()
      .catch(() => {});
    await page.screenshot({
      path: path.join(results, "dashboard.png"),
      fullPage: true,
    });
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].setSize(1000, 800);
    });
    await page.waitForTimeout(300);
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
      "minimum-width layout must not overflow",
    );
    await page.screenshot({
      path: path.join(results, "dashboard-compact.png"),
      fullPage: true,
    });
    assert.deepEqual(errors, []);
    console.log(
      "PASS desktop: real Electron, six adapters, isolated preload, preview, cancel, memory/skills sync, backups, restore, invalid IPC, launch authorization, npm discovery/cancel/approval/revocation, navigation, responsive layout.",
    );
    console.log("Screenshots: " + results);
  } finally {
    await app.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
