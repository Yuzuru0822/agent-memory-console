/* Isolated Electron UI regression. Never authorizes or modifies real Agent files. */
const { _electron: electron } = require("playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

(async () => {
  const project = path.resolve(__dirname, "..");
  const fixture = path.resolve(
    project,
    "../../work",
    `repository-desktop-${Date.now()}`,
  );
  const home = path.join(fixture, "home");
  const data = path.join(fixture, "user-data");
  const repository = path.join(fixture, "central-repository");
  const memory = path.join(home, ".workbuddy", "memory");
  const skills = path.join(home, ".workbuddy", "skills");
  const results = path.join(project, "test-results");
  const configFile = path.join(data, "console-data", "config.json");
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  };
  const read = (file) => fs.readFileSync(file, "utf8");
  const config = () => JSON.parse(read(configFile));
  const base = "# Profile\nalpha\nunchanged center\nomega\n";
  const localMemory = path.join(memory, "profile.md");
  const repoMemory = path.join(
    repository,
    "memories",
    "workbuddy",
    "profile.md",
  );
  const localSkill = path.join(skills, "review", "SKILL.md");
  const repoSkill = path.join(repository, "skills", "review", "SKILL.md");
  write(localMemory, base);
  write(path.join(memory, "nested", "notes.md"), "# A second memory file\n");
  write(localSkill, "# Review skill\nRead the proposed change.\n");
  write(
    path.join(skills, "review", "scripts", "helper.js"),
    "// Data fixture only; never execute this skill.\n",
  );
  write(path.join(home, ".workbuddy", "MEMORY.md"), "# Legacy single file\n");
  write(
    configFile,
    JSON.stringify(
      {
        version: 1,
        agents: {
          workbuddy: {
            memory: path.join(home, ".workbuddy", "MEMORY.md"),
            skills,
          },
        },
      },
      null,
      2,
    ),
  );
  fs.mkdirSync(repository, { recursive: true });
  fs.mkdirSync(results, { recursive: true });
  const app = await electron.launch({
    args: [project],
    env: {
      ...process.env,
      CONSOLE_DEV: "",
      CONSOLE_TEST_HOME: home,
      CONSOLE_TEST_DATA: data,
    },
    timeout: 60000,
  });
  const errors = [];
  try {
    const page = await app.firstWindow();
    page.on("pageerror", (error) => errors.push(error.message));
    await page.waitForSelector(".agent-card", { timeout: 20000 });
    assert.equal(await page.evaluate(() => typeof window.require), "undefined");
    await page.getByRole("button", { name: "统一仓库", exact: true }).click();
    await page.getByRole("heading", { name: "统一记忆与技能仓库" }).waitFor();
    await page
      .getByRole("button", { name: "选择目录并初始化 Git", exact: true })
      .waitFor();

    await app.evaluate(({ dialog }, selected) => {
      globalThis.repositoryDialogs = [];
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [selected],
      });
      dialog.showMessageBox = async (_window, options) => {
        globalThis.repositoryDialogs.push(options);
        return { response: 0, checkboxChecked: false };
      };
    }, repository);
    await page
      .getByRole("button", { name: "选择目录并初始化 Git", exact: true })
      .click();
    await page.waitForFunction(() =>
      document.querySelector(".repo-notice")?.textContent.includes("取消"),
    );
    assert.equal(
      config().repository,
      undefined,
      "cancel must not authorize or initialize a repository",
    );
    assert.equal(fs.existsSync(path.join(repository, ".git")), false);

    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async (_window, options) => {
        globalThis.repositoryDialogs.push(options);
        return { response: 1, checkboxChecked: false };
      };
    });
    await page
      .getByRole("button", { name: "选择目录并初始化 Git", exact: true })
      .click();
    await page
      .getByRole("button", { name: "选择其他仓库目录", exact: true })
      .waitFor();
    assert.equal(config().repository.root, repository);
    assert.ok(fs.existsSync(path.join(repository, ".git", "HEAD")));
    assert.ok(
      (await page.evaluate(() => window.consoleApi.repositorySnapshot()))
        .history.length >= 1,
    );

    const member = page
      .locator(".repo-member-option")
      .filter({ hasText: "WorkBuddy" })
      .getByRole("checkbox");
    await member.uncheck();
    await page
      .getByRole("button", { name: "保存纳管选择", exact: true })
      .click();
    await page.waitForFunction(
      async () =>
        !(await window.consoleApi.repositorySnapshot()).members.find(
          (member) => member.id === "workbuddy",
        ).selected,
    );
    await member.check();
    await page
      .getByRole("button", { name: "保存纳管选择", exact: true })
      .click();
    await page.waitForFunction(
      async () =>
        (await window.consoleApi.repositorySnapshot()).members.find(
          (member) => member.id === "workbuddy",
        ).selected,
    );
    assert.deepEqual(config().repository.agentIds, ["workbuddy"]);
    const agent = page.locator(".repo-agent").filter({ hasText: "WorkBuddy" });
    await app.evaluate(({ dialog }, selected) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [selected],
      });
    }, memory);
    await agent
      .getByRole("button", { name: "选择记忆目录", exact: true })
      .click();
    await page.waitForFunction(
      async (selected) =>
        (await window.consoleApi.repositorySnapshot()).members.find(
          (member) => member.id === "workbuddy",
        ).memoryPath === selected,
      memory,
    );
    assert.equal(config().repository.memoryFolders.workbuddy, memory);

    const preview = page.getByRole("button", {
      name: "预览双向同步",
      exact: true,
    });
    const apply = () => page.getByRole("button", { name: /^确认应用双向同步/ });
    await preview.click();
    await page.getByRole("region", { name: "双向同步预览" }).waitFor();
    assert.match(
      await page.locator(".repo-file-list").innerText(),
      /profile.md/,
    );
    assert.match(await page.locator(".repo-file-list").innerText(), /notes.md/);
    const canceledPlan = await page.evaluate(() =>
      window.consoleApi.repositoryPreview(),
    );
    await page
      .getByRole("button", { name: "关闭双向同步预览", exact: true })
      .click();
    await page
      .getByRole("region", { name: "双向同步预览" })
      .waitFor({ state: "detached" });
    const canceledDenied = await page.evaluate(async (id) => {
      try {
        await window.consoleApi.repositoryApply(id, {});
        return false;
      } catch {
        return true;
      }
    }, canceledPlan.id);
    assert.equal(
      canceledDenied,
      true,
      "closing preview must release and invalidate its backend plan",
    );
    assert.equal(fs.existsSync(repoMemory), false);
    await preview.click();
    await page.getByRole("region", { name: "双向同步预览" }).waitFor();
    await apply().click();
    await page
      .getByRole("region", { name: "双向同步预览" })
      .waitFor({ state: "detached" });
    assert.equal(read(repoMemory), base);
    assert.equal(
      read(
        path.join(repository, "memories", "workbuddy", "nested", "notes.md"),
      ),
      "# A second memory file\n",
    );
    assert.equal(
      read(path.join(repository, "skills", "review", "scripts", "helper.js")),
      "// Data fixture only; never execute this skill.\n",
    );
    assert.equal(
      fs.lstatSync(skills).isSymbolicLink(),
      false,
      "saving members must never implicitly link a directory",
    );

    write(localMemory, base.replace("alpha", "alpha from Agent"));
    write(repoMemory, base.replace("omega", "omega from repository"));
    await preview.click();
    await page.getByRole("region", { name: "双向同步预览" }).waitFor();
    assert.equal(
      await page.locator(".repo-file-list .conflict").count(),
      0,
      "nonoverlapping edits should merge",
    );
    await apply().click();
    await page
      .getByRole("region", { name: "双向同步预览" })
      .waitFor({ state: "detached" });
    const merged = base
      .replace("alpha", "alpha from Agent")
      .replace("omega", "omega from repository");
    assert.equal(read(localMemory), merged);
    assert.equal(read(repoMemory), merged);

    write(localMemory, merged.replace("unchanged center", "Agent conflict"));
    write(
      repoMemory,
      merged.replace("unchanged center", "Repository conflict"),
    );
    await preview.click();
    await page.locator(".repo-conflict-resolution").waitFor();
    assert.equal(
      await apply().isDisabled(),
      true,
      "unresolved conflict must disable applying",
    );
    await page.getByRole("radio", { name: "手动合并", exact: true }).check();
    const manual = "# Reviewed merge\nKeep both useful decisions.\n";
    await page
      .getByRole("textbox", { name: "手动合并 profile.md", exact: true })
      .fill(manual);
    await page.screenshot({
      path: path.join(results, "repository-conflict.png"),
      fullPage: true,
    });
    await apply().click();
    await page
      .getByRole("region", { name: "双向同步预览" })
      .waitFor({ state: "detached" });
    assert.equal(read(localMemory), manual);
    assert.equal(read(repoMemory), manual);

    fs.unlinkSync(localMemory);
    await preview.click();
    await page.getByRole("region", { name: "双向同步预览" }).waitFor();
    assert.match(
      await page.locator(".repo-file-description").innerText(),
      /不传播删除/,
    );
    await apply().click();
    await page
      .getByRole("region", { name: "双向同步预览" })
      .waitFor({ state: "detached" });
    assert.equal(
      read(localMemory),
      manual,
      "missing content should be restored, not delete the opposite side",
    );

    write(localSkill, "# Agent skill choice\n");
    write(repoSkill, "# Repository skill choice\n");
    await agent
      .getByRole("button", { name: "预览连接技能", exact: true })
      .click();
    const linkPreview = page.getByRole("region", { name: "技能连接预览" });
    await linkPreview.waitFor();
    const linkApply = linkPreview.getByRole("button", {
      name: "确认导入并连接技能",
      exact: true,
    });
    assert.equal(await linkApply.isDisabled(), true);
    await linkPreview
      .getByRole("radio", { name: "采用 Agent", exact: true })
      .check();
    await linkApply.click();
    await linkPreview.waitFor({ state: "detached" });
    const linked = (
      await page.evaluate(() => window.consoleApi.repositorySnapshot())
    ).members.find((member) => member.id === "workbuddy");
    assert.equal(linked.linked, true);
    assert.ok(linked.originalBackup);
    assert.equal(fs.lstatSync(skills).isSymbolicLink(), true);
    assert.equal(
      fs.realpathSync(skills).toLowerCase(),
      path.join(repository, "skills").toLowerCase(),
    );
    assert.equal(read(repoSkill), "# Agent skill choice\n");
    assert.equal(
      read(path.join(linked.originalBackup, "review", "SKILL.md")),
      "# Agent skill choice\n",
    );
    write(
      path.join(repository, "skills", "new-shared", "SKILL.md"),
      "# Shared live skill\n",
    );
    assert.equal(
      read(path.join(skills, "new-shared", "SKILL.md")),
      "# Shared live skill\n",
    );
    await agent
      .getByRole("button", { name: "解除连接并恢复原目录", exact: true })
      .click();
    await page.waitForFunction(
      async () =>
        !(await window.consoleApi.repositorySnapshot()).members.find(
          (member) => member.id === "workbuddy",
        ).linked,
    );
    assert.equal(fs.lstatSync(skills).isSymbolicLink(), false);
    assert.equal(read(localSkill), "# Agent skill choice\n");
    assert.ok(
      fs.existsSync(path.join(repository, "skills", "new-shared", "SKILL.md")),
      "unlink must preserve the repository",
    );

    const auto = page.getByRole("checkbox", { name: /启用自动双向同步/ });
    const cleanup = page.getByRole("checkbox", {
      name: /自动清理过期备份与临时文件/,
    });
    await auto.check();
    await cleanup.check();
    await page
      .getByRole("spinbutton", { name: "自动同步间隔秒", exact: true })
      .fill("60");
    await page
      .getByRole("button", { name: "保存自动化设置", exact: true })
      .click();
    await page.waitForFunction(
      async () =>
        (await window.consoleApi.repositorySnapshot()).automation.enabled,
    );
    assert.deepEqual(config().repository.automation, {
      enabled: true,
      intervalSeconds: 60,
      cleanupEnabled: true,
      retentionDays: 30,
      minBackups: 20,
    });
    await auto.uncheck();
    await cleanup.uncheck();
    await page
      .getByRole("button", { name: "保存自动化设置", exact: true })
      .click();
    await page.waitForFunction(
      async () =>
        !(await window.consoleApi.repositorySnapshot()).automation.enabled,
    );
    await page
      .getByRole("button", { name: "按已保存规则清理", exact: true })
      .click();
    await page.waitForFunction(() =>
      document.querySelector(".repo-notice")?.textContent.includes("清理"),
    );
    assert.equal(read(repoMemory), manual);
    const traeSkills = path.join(home, ".trae-cn", "skills");
    const binaryWinner = Buffer.from([0, 17, 29, 255]);
    write(path.join(skills, "review", "asset.bin"), binaryWinner);
    write(
      path.join(traeSkills, "review", "asset.bin"),
      Buffer.from([0, 99, 42, 255]),
    );
    await app.evaluate(({ dialog }, selected) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [selected],
      });
    }, traeSkills);
    await page.evaluate(() => window.consoleApi.pick("trae", "skills"));
    await page
      .locator(".repo-member-option")
      .filter({ hasText: "TRAE" })
      .getByRole("checkbox")
      .check();
    await page
      .getByRole("button", { name: "保存纳管选择", exact: true })
      .click();
    await page.waitForFunction(
      async () =>
        (await window.consoleApi.repositorySnapshot()).members.find(
          (member) => member.id === "trae",
        ).selected,
    );
    await preview.click();
    await page.getByRole("region", { name: "双向同步预览" }).waitFor();
    await page
      .locator(".repo-file-list button")
      .filter({ hasText: "asset.bin" })
      .filter({ hasText: "WorkBuddy" })
      .click();
    assert.equal(await apply().isDisabled(), true);
    assert.equal(await page.getByRole("button", { name: "仓库版本用于所有引用方", exact: true }).isDisabled(), true, "a missing repository binary cannot be selected as the winner");
    await page
      .getByRole("button", { name: "此 Agent 版本用于所有引用方", exact: true })
      .click();
    assert.equal(await apply().isDisabled(), false);
    await apply().click();
    await page
      .getByRole("region", { name: "双向同步预览" })
      .waitFor({ state: "detached" });
    assert.deepEqual(
      fs.readFileSync(path.join(repository, "skills", "review", "asset.bin")),
      binaryWinner,
    );
    assert.deepEqual(
      fs.readFileSync(path.join(traeSkills, "review", "asset.bin")),
      binaryWinner,
    );
    const dialogs = await app.evaluate(() => globalThis.repositoryDialogs);
    assert.ok(
      dialogs.some((options) => options.detail?.includes(repository)),
      "native authorization must show the real repository path",
    );
    assert.ok(
      dialogs.every(
        (options) => options.defaultId === 0 && options.cancelId === 0,
      ),
      "native confirmation must default to cancel",
    );

    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setSize(1000, 800),
    );
    await page.waitForFunction(() => window.innerWidth <= 1000);
    await page.screenshot({
      path: path.join(results, "repository-compact.png"),
      fullPage: true,
    });
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth + 1,
      ),
      "repository layout must fit 1000px window",
    );
    assert.deepEqual(errors, []);
    console.log(
      JSON.stringify({
        ok: true,
        fixture,
        scenarios: [
          "cancel-init",
          "cancel-preview",
          "local-git",
          "saved-members",
          "folder-memory",
          "three-way-merge",
          "manual-conflict",
          "no-delete-propagation",
          "whole-skill-bundle",
          "shared-binary-conflict-winner",
          "junction-create-undo",
          "automation-settings",
          "retention-cleanup",
          "compact-layout",
        ],
      }),
    );
  } finally {
    await app.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
