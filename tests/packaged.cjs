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
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
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
    const nativeReward = await application.evaluate(() => {
      const req = process.mainModule.require.bind(process.mainModule);
      const nativeFs = req('node:fs');
      const nativePath = req('node:path');
      const helper = nativePath.join(process.resourcesPath, 'rewards', 'RewardBridge.exe');
      const exists = nativeFs.existsSync(helper) && nativeFs.statSync(helper).isFile();
      // Inspect package bytes only. Never start the helper or inspect vendor windows.
      const bytes = exists ? nativeFs.readFileSync(helper) : Buffer.alloc(0);
      const offset = bytes.length >= 64 ? bytes.readUInt32LE(60) : -1;
      const validPE = bytes.length >= 128 && bytes.toString('ascii', 0, 2) === 'MZ'
        && offset >= 64 && offset + 24 <= bytes.length
        && bytes.toString('ascii', offset, offset + 4) === 'PE\0\0'
        && (bytes.readUInt16LE(offset + 22) & 0x0002) !== 0;
      return { resources: process.resourcesPath, helper, exists, validPE };
    });
    assert.equal(path.resolve(nativeReward.resources).toLowerCase(), path.join(path.dirname(executablePath), 'resources').toLowerCase(), 'packaged helper must resolve from this executable resources directory');
    assert.equal(path.resolve(nativeReward.helper).toLowerCase(), path.join(path.dirname(executablePath), 'resources', 'rewards', 'RewardBridge.exe').toLowerCase());
    assert.equal(nativeReward.exists, true, 'packaged reward helper must be included outside app.asar');
    assert.equal(nativeReward.validPE, true, 'packaged reward helper must be an executable PE file');
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
    await page.getByRole('button', { name: '集成能力', exact: true }).click();
    assert.equal(await page.locator('.integration-row').count(), snapshot.agents.length);
    const qoderIntegration = page.locator('.integration-row').filter({ hasText: 'Qoder' });
    assert.match(await qoderIntegration.innerText(), /文档适配/);
    assert.match(await qoderIntegration.innerText(), /用户绑定 EXE 启动/);
    const rewards = await page.evaluate(() => window.consoleApi.rewardsSnapshot());
    assert.equal(rewards.nativeAvailable, true, 'packaged runtime must find its bundled reward component');
    assert.equal(rewards.providers.length, 9, 'packaged rewards catalog must retain all regional distinctions');
    assert.equal(new Set(rewards.providers.map(provider => provider.id)).size, 9);
    assert.deepEqual(rewards.providers.filter(provider => provider.kind === 'ui').map(provider => provider.id), ['qoder', 'qoder-cn', 'trae', 'workbuddy']);
    assert.equal(rewards.logs.length, 0, 'fresh packaged profile must not fabricate reward history');
    await page.getByRole('button', { name: '积分福利', exact: true }).click();
    await page.locator('[data-reward-id]').first().waitFor();
    assert.equal(await page.locator('[data-reward-id]').count(), rewards.providers.length);
    for (const provider of rewards.providers) {
      const card = page.locator(`[data-reward-id="${provider.id}"]`);
      assert.equal(provider.profile, undefined, 'agent discovery must never authorize or configure reward actions');
      if (provider.kind !== 'ui') {
        assert.equal(provider.state, 'unsupported');
        assert.equal(await card.getByRole('button', { name: /校准|管理领取|自动领取/ }).count(), 0, `${provider.id} must not advertise automatic claims`);
        assert.equal(await card.getByRole('checkbox').count(), 0);
      } else {
        assert.equal(provider.state, 'needs_setup');
        await card.getByRole('button', { name: '校准领取流程', exact: true }).click();
        const setup = page.getByRole('region', { name: `${provider.name} 领取配置`, exact: true });
        await setup.waitFor();
        assert.equal(await setup.getByRole('button', { name: '绑定客户端 EXE', exact: true }).isDisabled(), false);
        assert.equal(await setup.getByRole('button', { name: '检查窗口', exact: true }).isDisabled(), true, 'unbound client cannot be inspected');
        assert.equal(await setup.getByRole('button', { name: '手动试领', exact: true }).isDisabled(), true, 'unconfigured client cannot claim');
        const auto = setup.getByRole('checkbox', { name: `${provider.name} 自动领取`, exact: true });
        assert.equal(await auto.isChecked(), false);
        assert.equal(await auto.isDisabled(), true, 'unvalidated flow cannot enable automation');
      }
    }
    await page.screenshot({ path: path.join(resultPath, 'packaged-rewards.png'), fullPage: true });
    await page.getByRole('button', { name: '监控总览', exact: true }).click();
    await page.screenshot({ path: path.join(resultPath, 'packaged-dashboard.png'), fullPage: true });
    assert.deepEqual(errors, []);
    console.log(`PASS packaged Windows app: app.asar loaded, sandbox active, isolated profile, ${snapshot.agents.length} registered adapters, Qoder card and file-only configuration, bundled reward PE/resources path, 9 reward platforms/4 calibratable clients, unsupported capability labels, initially disabled claim/automation controls, native bridge and navigation. No vendor client or native UIA helper was invoked.`);
    console.log(JSON.stringify(metadata));
  } finally {
    await application.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
