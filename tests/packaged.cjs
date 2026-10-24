// Launch the actual packaged app. Uses Chromium's user-data-dir override; no writes to Agent files.
const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

(async () => {
  const project = path.resolve(__dirname, '..');
  const userData = path.resolve(project, '../../work', `packaged-profile-${Date.now()}`);
  const executablePath = process.argv[2] ? path.resolve(process.argv[2]) : path.join(project, 'release', 'win-unpacked', 'Agent Memory Console.exe');
  const resultPath = path.join(project, 'test-results');
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(resultPath, { recursive: true });
  const application = await electron.launch({ executablePath, args: [`--user-data-dir=${userData}`], timeout: 60000 });
  try {
    const page = await application.firstWindow();
    const metadata = await application.evaluate(({ app, BrowserWindow }) => ({
      packaged: app.isPackaged,
      userData: app.getPath('userData'),
      version: app.getVersion(),
      visible: BrowserWindow.getAllWindows()[0].isVisible(),
      sandbox: BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences().sandbox,
    }));
    assert.equal(metadata.packaged, true);
    assert.equal(metadata.sandbox, true);
    assert.equal(metadata.version, require('../package.json').version);
    assert.equal(metadata.visible, true);
    assert.equal(path.resolve(metadata.userData).toLowerCase(), userData.toLowerCase(), 'packaged smoke must use an isolated profile');
    await page.waitForSelector('.agent-card', { timeout: 20000 });
    assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
    const snapshot = await page.evaluate(() => window.consoleApi.snapshot());
    assert.ok(snapshot.agents.length > 0, 'packaged registry must not be empty');
    assert.equal(new Set(snapshot.agents.map(agent => agent.id)).size, snapshot.agents.length, 'packaged registry IDs must be unique');
    assert.equal(await page.locator('.agent-card').count(), snapshot.agents.length);
    assert.equal(await page.locator('.filter-group .filter').first().locator('b').innerText(), String(snapshot.agents.length));
    const qoder = snapshot.agents.find(agent => agent.id === 'qoder');
    assert.ok(qoder, 'Qoder must be included in the packaged registry');
    assert.equal(qoder.mode, 'desktop');
    assert.equal(qoder.memoryApproved, false);
    assert.equal(qoder.skillsApproved, false);
    assert.equal(qoder.executableApproved, false, 'Qoder discovery must not grant execution permission');
    const qoderCard = page.locator('.agent-card').filter({ has: page.getByRole('heading', { name: 'Qoder', exact: true }) });
    assert.match(await qoderCard.locator('.support-label').innerText(), /文档适配.*文件路径/);
    await qoderCard.getByRole('button', { name: /查看检查与配置/ }).click();
    const qoderDetails = page.getByRole('dialog', { name: 'Qoder 详情' });
    await qoderDetails.waitFor();
    assert.equal(await qoderDetails.locator('.config-blocks .config-block').count(), 4);
    assert.equal(await qoderDetails.locator('.npm-installation, #task').count(), 0);
    assert.equal(await qoderDetails.getByRole('button', { name: '启动程序', exact: true }).isDisabled(), true);
    await qoderDetails.getByRole('button', { name: '关闭详情', exact: true }).click();
    const claude = snapshot.agents.find(a=>a.id==='claude');
    assert.equal(claude.executableApproved,false,'discovery in a new profile must not grant permission');
    if (process.env.CONSOLE_EXPECT_NPM_VERSION) {
      assert.equal(claude.npmCandidate?.packageVersion,process.env.CONSOLE_EXPECT_NPM_VERSION);
      await page.locator('.agent-card').filter({hasText:'Claude Code CLI'}).getByRole('button',{name:/查看检查与配置/}).click();
      await page.getByRole('button',{name:'授权检测到的 npm 安装',exact:true}).waitFor();
      await page.getByRole('button',{name:'关闭详情',exact:true}).click();
    }
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.getByRole('button', { name: '集成能力', exact: true }).click();
    assert.equal(await page.locator('.integration-row').count(), snapshot.agents.length);
    const qoderIntegration = page.locator('.integration-row').filter({ hasText: 'Qoder' });
    assert.match(await qoderIntegration.innerText(), /文档适配/);
    assert.match(await qoderIntegration.innerText(), /用户绑定 EXE 启动/);
    await page.getByRole('button', { name: '监控总览', exact: true }).click();
    await page.screenshot({ path: path.join(resultPath, 'packaged-dashboard.png'), fullPage: true });
    assert.deepEqual(errors, []);
    console.log(`PASS packaged Windows app: app.asar loaded, sandbox active, isolated profile, ${snapshot.agents.length} registered adapters, Qoder card and file-only configuration, native bridge and navigation.`);
    console.log(JSON.stringify(metadata));
  } finally {
    await application.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
