/* Real Electron regression using isolated fixture files; never reads real Agent data. */
const { _electron: electron } = require("playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

(async () => {
  const project = path.resolve(__dirname, "..");
  const fixture = path.resolve(project, "../../work", `repository-bulk-desktop-${Date.now()}`);
  const home = path.join(fixture, "home");
  const data = path.join(fixture, "user-data");
  const repository = path.join(fixture, "central-repository");
  const claude = path.join(home, ".claude", "skills");
  const workbuddy = path.join(home, ".workbuddy", "skills");
  const results = path.join(project, "test-results");
  const csvFile = path.join(fixture, "sync-review.csv");
  const configFile = path.join(data, "console-data", "config.json");
  const stamp = Date.now() - 3600000;
  const relative = (index) => index < 3 ? `batch-target/file-${index}.md` : `bulk/file-${String(index).padStart(4, "0")}.md`;
  const content = (agent, index) => `PRIVATE-FILE-CONTENT-${agent}-${index}\n`;
  const write = (file, text, modified) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    if (modified !== undefined) fs.utimesSync(file, new Date(modified), new Date(modified));
  };
  const read = (file) => fs.readFileSync(file, "utf8");
  for (let index = 0; index < 660; index += 1) {
    write(path.join(claude, relative(index)), content("claude", index), stamp);
    write(path.join(workbuddy, relative(index)), content("workbuddy", index), stamp - 3600000);
  }
  write(configFile, JSON.stringify({ version: 1, agents: { claude: { skills: claude }, workbuddy: { skills: workbuddy } } }, null, 2));
  fs.mkdirSync(repository, { recursive: true });
  fs.mkdirSync(results, { recursive: true });
  const app = await electron.launch({
    args: [project],
    env: { ...process.env, CONSOLE_DEV: "", CONSOLE_TEST_HOME: home, CONSOLE_TEST_DATA: data },
    timeout: 60000,
  });
  const errors = [];
  let page;
  try {
    page = await app.firstWindow();
    page.setDefaultTimeout(30000);
    page.on("pageerror", (error) => errors.push(error.message));
    await page.waitForSelector(".agent-card", { timeout: 30000 });
    await app.evaluate(({ dialog }, selected) => {
      globalThis.bulkReviewDialogs = [];
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected.repository] });
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: selected.csvFile });
      dialog.showMessageBox = async (_window, options) => {
        globalThis.bulkReviewDialogs.push(options);
        return { response: 1, checkboxChecked: false };
      };
    }, { repository, csvFile });
    await page.getByRole("button", { name: "统一仓库", exact: true }).click();
    await page.getByRole("heading", { name: "统一记忆与技能仓库" }).waitFor();
    await page.getByRole("button", { name: "选择目录并初始化 Git", exact: true }).click();
    await page.getByRole("button", { name: "选择其他仓库目录", exact: true }).waitFor();
    assert.deepEqual(JSON.parse(read(configFile)).repository.agentIds.sort(), ["claude", "workbuddy"]);

    const preview = page.getByRole("button", { name: "预览双向同步", exact: true });
    const region = page.getByRole("region", { name: "双向同步预览" });
    const apply = page.getByRole("button", { name: /^确认应用双向同步/ });
    const search = page.getByRole("textbox", { name: "搜索同步文件", exact: true });
    const filter = page.getByRole("combobox", { name: "筛选同步文件", exact: true });
    const visibleFiles = page.locator(".repo-file-list button");
    const batch = (name) => page.getByRole("button", { name, exact: true });
    const ready = () => page.waitForFunction(() => Array.from(document.querySelectorAll("button")).some((button) => button.textContent.trim() === "预览双向同步" && !button.disabled), undefined, { timeout: 60000 });
    await preview.click();
    await region.waitFor({ timeout: 60000 });
    await ready();
    assert.equal(await visibleFiles.count(), 1320, "660 differing shared files produce 1320 Agent references");
    assert.equal(await apply.isDisabled(), false, "all absent-repository conflicts should be preselected without 660 manual decisions");
    assert.match(await region.innerText(), /默认采用 Agent 清单.*660/);
    assert.equal(fs.existsSync(path.join(repository, "skills", relative(0))), false, "preview must not write files");

    await search.fill("batch-target/");
    assert.equal(await visibleFiles.count(), 6);
    await batch("勾选当前筛选冲突").click();
    assert.equal(await page.locator(".repo-file-list input[type=checkbox]:checked").count(), 6);
    await batch("清除处理选择").click();
    assert.equal(await apply.isDisabled(), true, "clearing selected shared groups must leave unresolved conflicts");
    await filter.selectOption("unresolved");
    assert.equal(await visibleFiles.count(), 6, "unresolved filter must include every reference of the three cleared groups");
    await batch("恢复推荐").click();
    assert.equal(await apply.isDisabled(), false);
    assert.equal(await visibleFiles.count(), 0, "restored recommendations must leave the unresolved filter empty");
    await filter.selectOption("all");
    await batch("采用最新 Agent").click();
    assert.equal(await apply.isDisabled(), false);
    await batch("取消全部勾选").click();
    assert.equal(await page.locator(".repo-file-list input[type=checkbox]:checked").count(), 0);

    await visibleFiles.filter({ hasText: "file-0.md" }).filter({ hasText: "WorkBuddy" }).click();
    const agentChoice = page.getByRole("radio", { name: "采用 Agent 内容", exact: true });
    assert.equal(await agentChoice.isChecked(), false, "another Agent's selected shared source must not be shown as this Agent's checked radio");
    await agentChoice.check();
    assert.equal(await agentChoice.isChecked(), true);
    assert.equal(await apply.isDisabled(), false, "manual shared-source override must resolve all references consistently");
    await batch("导出处理清单").click();
    await page.waitForFunction(() => document.querySelector(".repo-notice")?.textContent?.includes("导出"));
    assert.ok(fs.existsSync(csvFile), "review list should be exported through a native save dialog");
    const csv = read(csvFile);
    assert.ok(csv.includes("batch-target/file-0.md") && csv.includes("bulk/file-0659.md"), "CSV covers filtered and nonfiltered files");
    assert.ok(csv.includes("claude") && csv.includes("workbuddy"), "CSV includes review source identities");
    assert.equal(csv.includes("PRIVATE-FILE-CONTENT"), false, "CSV must contain metadata only, never file contents");
    await search.fill("");
    await page.screenshot({ path: path.join(results, "repository-bulk-desktop.png"), fullPage: true });
    await region.screenshot({ path: path.join(results, "repository-bulk-preview.png") });
    await apply.click({ timeout: 300000 });
    await region.waitFor({ state: "detached", timeout: 300000 });
    for (let index = 0; index < 660; index += 1) {
      const expected = content(index === 0 ? "workbuddy" : "claude", index);
      for (const directory of [claude, workbuddy, path.join(repository, "skills")]) {
        assert.equal(read(path.join(directory, relative(index))), expected, `shared file ${index} must use a consistent selected source`);
      }
    }

    for (let index = 0; index < 3; index += 1) {
      write(path.join(claude, relative(index)), `PRIVATE-NEW-AGENT-${index}\n`, stamp + 1200000);
      write(path.join(workbuddy, relative(index)), `PRIVATE-OTHER-AGENT-${index}\n`, stamp - 1200000);
      write(path.join(repository, "skills", relative(index)), `PRIVATE-OLDER-REPOSITORY-${index}\n`, stamp);
    }
    await preview.click();
    await region.waitFor({ timeout: 60000 });
    await ready();
    assert.equal(await visibleFiles.count(), 6);
    assert.equal(await apply.isDisabled(), false, "newer Agent contents should also be preselected when a repository version exists");
    const recommendationRows = page.locator(".repo-recommendation-table tbody tr");
    assert.equal(await recommendationRows.count(), 3);
    for (let index = 0; index < 3; index += 1) {
      const cells = recommendationRows.nth(index).locator("td");
      assert.equal(await cells.nth(1).innerText(), "Claude Code CLI", "newest Agent must be the actual recommendation source");
      assert.equal(await cells.nth(5).innerText(), "Claude Code CLI 内容", "recommendation must be initialized as the shared group's current resolution");
    }
    assert.match(await region.innerText(), /仓库.*旧|Agent.*更新|Agent.*较新/);
    await batch("勾选当前筛选冲突").click();
    await batch("采用仓库").click();
    assert.equal(await apply.isDisabled(), false, "explicit bulk repository selection must override default Agent choices");
    await apply.click({ timeout: 300000 });
    await region.waitFor({ state: "detached", timeout: 300000 });
    for (let index = 0; index < 3; index += 1) {
      for (const directory of [claude, workbuddy, path.join(repository, "skills")]) {
        assert.equal(read(path.join(directory, relative(index))), `PRIVATE-OLDER-REPOSITORY-${index}\n`);
      }
    }
    assert.deepEqual(errors, []);
    const dialogs = await app.evaluate(() => globalThis.bulkReviewDialogs);
    assert.ok(dialogs.every((options) => options.defaultId === 0 && options.cancelId === 0));
    console.log(JSON.stringify({ ok: true, fixture, files: 660, references: 1320, scenarios: ["missing-repository-defaults", "newest-agent-shared-source", "search-and-filter", "bulk-clear-and-restore", "explicit-shared-source", "metadata-only-csv", "actual-660-file-sync", "older-repository-defaults", "bulk-repository-override"] }));
  } finally {
    // Large fixture writes can outlast a UI wait. Finish isolated writes before
    // exiting, otherwise the application's busy-operation guard blocks quit.
    if (page && !page.isClosed()) {
      await page.waitForFunction(async () => !(await window.consoleApi.repositorySnapshot()).running, undefined, { timeout: 300000 });
    }
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await app.close().catch(() => {});
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
