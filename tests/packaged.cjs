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
    assert.equal(await page.locator('.agent-card').count(), 6);
    assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
    const snapshot = await page.evaluate(() => window.consoleApi.snapshot());
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
    assert.equal(await page.locator('.integration-row').count(), 6);
    await page.getByRole('button', { name: '监控总览', exact: true }).click();
    await page.screenshot({ path: path.join(resultPath, 'packaged-dashboard.png'), fullPage: true });
    assert.deepEqual(errors, []);
    console.log('PASS packaged Windows app: app.asar loaded, sandbox active, isolated profile, six adapters, native bridge and navigation.');
    console.log(JSON.stringify(metadata));
  } finally {
    await application.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
