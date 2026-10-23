/* Packaged Git regression: isolated profile and fixture repository, no Agent grants. */
const { _electron: electron } = require("playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

(async () => {
  if (!process.argv[2]) throw new Error('Usage: node tests/repository-packaged.cjs "<packaged Agent Memory Console.exe>"');
  const project = path.resolve(__dirname, "..");
  const executablePath = path.resolve(process.argv[2]);
  assert.equal(fs.statSync(executablePath).isFile(), true);
  const fixture = path.resolve(project, "../../work", `repository-packaged-${Date.now()}-${process.pid}`);
  const userData = path.join(fixture, "profile");
  const repository = path.join(fixture, "central-repository");
  const configFile = path.join(userData, "console-data", "config.json");
  const memory = path.join(repository, "memories", "claude", "fixture.md");
  const asset = path.join(repository, "skills", "fixture", "assets", "sample.bin");
  const memoryText = "# Packaged repository fixture\nCreated only inside this test directory.\n";
  const binary = Buffer.from([0, 255, 17, 128, 1, 10]);
  const results = path.join(project, "test-results");
  for (const dir of [userData, repository, results]) fs.mkdirSync(dir, { recursive: true });
  const write = (file, content) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  };
  const config = () => JSON.parse(fs.readFileSync(configFile, "utf8"));
  const env = { ...process.env, CONSOLE_DEV: "", CONSOLE_TEST_HOME: "", CONSOLE_TEST_DATA: "" };
  delete env.ELECTRON_RUN_AS_NODE;
  let application;
  const errors = [];

  async function launch() {
    application = await electron.launch({ executablePath, args: [`--user-data-dir=${userData}`], env, timeout: 60000 });
    const page = await application.firstWindow();
    page.on("pageerror", error => errors.push(error.message));
    await page.waitForSelector(".agent-card", { timeout: 20000 });
    const metadata = await application.evaluate(({ app, BrowserWindow }) => {
      const preferences = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
      return { packaged: app.isPackaged, appPath: app.getAppPath(), userData: app.getPath("userData"), version: app.getVersion(),
        sandbox: preferences.sandbox, contextIsolation: preferences.contextIsolation, nodeIntegration: preferences.nodeIntegration };
    });
    assert.equal(metadata.packaged, true);
    assert.match(metadata.appPath, /[\\/]app\.asar$/i, "this test must execute the ASAR package");
    assert.equal(metadata.version, require("../package.json").version);
    assert.equal(path.resolve(metadata.userData).toLowerCase(), userData.toLowerCase(), "never use the user's real application profile");
    assert.equal(metadata.sandbox, true);
    assert.equal(metadata.contextIsolation, true);
    assert.equal(metadata.nodeIntegration, false);
    assert.equal(await page.evaluate(() => typeof window.require), "undefined");
    return { page, metadata };
  }

  async function assertNoAgentGrants(page) {
    const current = config();
    assert.deepEqual(current.agents, {}, "repository testing must not authorize any Agent path or executable");
    assert.deepEqual(current.repository.agentIds, []);
    assert.deepEqual(current.repository.memoryFolders, {});
    assert.equal(current.repository.automation.enabled, false);
    assert.equal(current.repository.automation.cleanupEnabled, false);
    const snapshot = await page.evaluate(() => window.consoleApi.repositorySnapshot());
    assert.ok(snapshot.members.every(member => !member.selected));
    return snapshot;
  }

  try {
    const first = await launch();
    await application.evaluate(({ dialog }, selected) => {
      globalThis.packagedRepositoryDialogs = [];
      dialog.showOpenDialog = async (_window, options) => {
        if (!options.title.includes("Git 仓库")) throw new Error("Packaged test refused an unexpected non-repository picker");
        return { canceled: false, filePaths: [selected] };
      };
      dialog.showMessageBox = async (_window, options) => {
        if (options.message !== "创建或打开本地 Git 仓库") throw new Error("Packaged test refused an unexpected authorization request");
        globalThis.packagedRepositoryDialogs.push(options);
        return { response: 1, checkboxChecked: false };
      };
    }, repository);
    await first.page.evaluate(() => window.consoleApi.repositoryChoose());
    const initial = await assertNoAgentGrants(first.page);
    assert.equal(initial.root, repository);
    assert.deepEqual(initial.git, { branch: "main", dirty: 0 });
    assert.equal(initial.history.length, 1);
    assert.equal(initial.error, undefined);
    const marker = JSON.parse(fs.readFileSync(path.join(repository, ".agent-console-repository.json"), "utf8"));
    assert.equal(marker.version, 1);
    assert.equal(marker.application, "agent-memory-console");
    assert.equal(fs.readFileSync(path.join(repository, ".git", "HEAD"), "utf8").trim(), "ref: refs/heads/main");

    write(memory, memoryText);
    write(asset, binary);
    write(path.join(repository, "skills", "fixture", "SKILL.md"), "# Fixture skill\nDo not execute any test assets.\n");
    write(path.join(repository, "skills", "fixture", "scripts", "never-run.js"), "throw new Error('This fixture must never execute');\n");
    const dirty = await first.page.evaluate(() => window.consoleApi.repositorySnapshot());
    assert.equal(dirty.git.dirty, 4);
    await first.page.evaluate(() => window.consoleApi.repositoryCommit());
    const committed = await assertNoAgentGrants(first.page);
    assert.deepEqual(committed.git, { branch: "main", dirty: 0 });
    assert.equal(committed.history.length, 2);
    assert.match(committed.history[0].message, /手动保存/);
    const oid = committed.history[0].oid;
    assert.match(oid, /^[a-f0-9]{40}$/);
    assert.equal(fs.readFileSync(path.join(repository, ".git", "refs", "heads", "main"), "utf8").trim(), oid);
    assert.ok(fs.existsSync(path.join(repository, ".git", "objects", oid.slice(0, 2), oid.slice(2))));
    const dialogs = await application.evaluate(() => globalThis.packagedRepositoryDialogs);
    assert.equal(dialogs.length, 1);
    assert.ok(dialogs[0].detail.includes(repository));
    assert.equal(dialogs[0].defaultId, 0);
    assert.equal(dialogs[0].cancelId, 0);

    await application.close();
    application = undefined;
    const restarted = await launch();
    const persisted = await assertNoAgentGrants(restarted.page);
    assert.equal(persisted.root, repository);
    assert.deepEqual(persisted.git, { branch: "main", dirty: 0 });
    assert.deepEqual(persisted.history.map(entry => entry.oid), committed.history.map(entry => entry.oid));
    assert.equal(fs.readFileSync(memory, "utf8"), memoryText);
    assert.deepEqual(fs.readFileSync(asset), binary);

    // Resolve through the packaged entry, proving both Git and its transitive
    // dependencies work from app.asar rather than this test's node_modules.
    const embedded = await application.evaluate(async ({ app }, input) => {
      // Playwright's main-process evaluation has Node globals but no CommonJS
      // `require` binding. Electron's bundled Node exposes built-ins directly.
      const path = process.getBuiltinModule("node:path");
      const packagedRequire = process.getBuiltinModule("node:module").createRequire(path.join(app.getAppPath(), "package.json"));
      const backend = packagedRequire("./dist-electron/electron/repository-git.js");
      return { gitModule: packagedRequire.resolve("isomorphic-git"),
        memory: (await backend.readRevision(input.root, input.oid, "memories/claude/fixture.md")).toString("utf8"),
        binary: [...await backend.readRevision(input.root, input.oid, "skills/fixture/assets/sample.bin")] };
    }, { root: repository, oid });
    assert.match(embedded.gitModule, /[\\/]app\.asar[\\/]node_modules[\\/]isomorphic-git[\\/]/i);
    assert.equal(embedded.memory, memoryText);
    assert.deepEqual(embedded.binary, [...binary]);
    await restarted.page.evaluate(() => window.consoleApi.repositoryCommit());
    assert.equal((await restarted.page.evaluate(() => window.consoleApi.repositorySnapshot())).history.length, 2, "no-change commit must not duplicate history");
    await restarted.page.getByRole("button", { name: "统一仓库", exact: true }).click();
    await restarted.page.getByRole("heading", { name: "统一记忆与技能仓库", exact: true }).waitFor();
    await restarted.page.screenshot({ path: path.join(results, "repository-packaged.png"), fullPage: true });
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ ok: true, fixture, executablePath, version: restarted.metadata.version, oid, gitModule: embedded.gitModule,
      scenarios: ["isolated-packaged-profile", "native-repository-authorization", "embedded-git-init", "dirty-status", "binary-and-script-commit", "restart-history", "embedded-revision-read", "no-agent-grants"] }));
  } finally {
    if (application) await application.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
