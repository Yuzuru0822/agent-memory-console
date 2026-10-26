// Verify the portable launcher over loopback CDP because the NSIS wrapper does not forward inspector output.
const { chromium } = require('playwright');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const assert = require('node:assert/strict');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
  const project = path.resolve(__dirname, '..');
  const executable = process.argv[2] ? path.resolve(process.argv[2]) : path.join(project, 'release', `Agent-Memory-Console-${require('../package.json').version}-win-x64.exe`);
  const profile = path.resolve(project, '../../work', `portable-profile-${Date.now()}`);
  fs.mkdirSync(profile, { recursive: true });
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  const child = spawn(executable, [`--user-data-dir=${profile}`, '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${port}`], { windowsHide:true, stdio:'ignore' });
  let exitCode;
  child.once('exit', code => { exitCode = code; });
  let browser;
  try {
    const endpoint = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 60000;
    let ready = false;
    while (Date.now() < deadline) {
      try { const response = await fetch(endpoint+'/json/version', {signal:AbortSignal.timeout(1000)}); if (response.ok) { ready=true; break; } } catch {}
      if (exitCode !== undefined) throw new Error('Portable launcher exited before opening the app: '+exitCode);
      await pause(500);
    }
    assert.ok(ready, 'portable must open a debug endpoint within 60 seconds');
    browser = await chromium.connectOverCDP(endpoint);
    const page = browser.contexts()[0].pages()[0];
    await page.waitForSelector('.agent-card', {timeout:20000});
    assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
    const state = await page.evaluate(() => window.consoleApi.snapshot());
    const interop = await page.evaluate(async () => ({mcp:await window.consoleApi.mcpSnapshot(),bridge:await window.consoleApi.bridgeSnapshot()}));
    assert.equal(interop.bridge.running,false);
    assert.ok(interop.bridge.agents.every(agent=>!agent.enabled&&!agent.tokenSet));
    assert.equal(interop.bridge.tasks.length,0);
    assert.equal(interop.mcp.bindings.length,0);
    assert.equal(interop.mcp.variableNames.length,0);
    assert.ok(state.agents.length > 0, 'portable registry must not be empty');
    assert.equal(new Set(state.agents.map(agent => agent.id)).size, state.agents.length, 'portable registry IDs must be unique');
    assert.equal(await page.locator('.agent-card').count(), state.agents.length);
    assert.equal(await page.locator('.filter-group .filter').first().locator('b').innerText(), String(state.agents.length));
    assert.equal(path.dirname(state.storagePath).toLowerCase(), profile.toLowerCase());
    const qoder = state.agents.find(agent => agent.id === 'qoder');
    assert.ok(qoder, 'Qoder must be included in the portable registry');
    assert.equal(qoder.mode, 'desktop');
    assert.equal(qoder.memoryApproved, false);
    assert.equal(qoder.skillsApproved, false);
    assert.equal(qoder.executableApproved, false);
    const qoderCard = page.locator('.agent-card').filter({ has: page.getByRole('heading', { name: 'Qoder', exact: true }) });
    assert.match(await qoderCard.locator('.support-label').innerText(), /文档适配.*文件路径/);
    await qoderCard.getByRole('button', { name: /查看检查与配置/ }).click();
    const qoderDetails = page.getByRole('dialog', { name: 'Qoder 详情' });
    await qoderDetails.waitFor();
    assert.equal(await qoderDetails.locator('.config-blocks .config-block').count(), 4);
    assert.equal(await qoderDetails.locator('.npm-installation, #task').count(), 0);
    assert.equal(await qoderDetails.getByRole('button', { name: '启动程序', exact: true }).isDisabled(), true);
    await qoderDetails.getByRole('button', { name: '关闭详情', exact: true }).click();
    await page.getByRole('button', {name:'集成能力',exact:true}).click();
    assert.equal(await page.locator('.integration-row').count(), state.agents.length);
    const qoderIntegration = page.locator('.integration-row').filter({ hasText: 'Qoder' });
    assert.match(await qoderIntegration.innerText(), /文档适配/);
    assert.match(await qoderIntegration.innerText(), /用户绑定 EXE 启动/);
    await page.screenshot({path:path.join(project,'test-results','portable-integrations.png')});
    const rewards = await page.evaluate(() => window.consoleApi.rewardsSnapshot());
    assert.equal(rewards.nativeAvailable, true, 'portable extraction must retain the native rewards component');
    assert.equal(rewards.providers.length, 9);
    assert.equal(rewards.providers.filter(provider => provider.kind === 'ui').length, 4);
    assert.ok(rewards.providers.every(provider => !provider.profile), 'portable discovery must not bind or enable claims');
    await page.getByRole('button', {name:'积分福利',exact:true}).click();
    await page.locator('[data-reward-id]').first().waitFor();
    assert.equal(await page.locator('[data-reward-id]').count(), 9);
    const balances = await page.evaluate(() => window.consoleApi.rewardBalancesSnapshot());
    assert.equal(balances.providers.length, 9);
    assert.equal(balances.nativeAvailable, true);
    assert.ok(balances.providers.every(provider => !provider.profile && !provider.sample && !provider.low), 'portable must not fabricate current balances');
    assert.equal(await page.locator('[data-balance-id]').count(), 9);
    await page.screenshot({path:path.join(project,'test-results','portable-rewards.png')});
    const tasks = await page.evaluate(() => window.consoleApi.taskCenterSnapshot());
    assert.equal(tasks.tasks.length,20);
    assert.equal(tasks.controls.closeToTray,false);
    assert.equal(tasks.runtime.trayAvailable,false);
    assert.ok(tasks.tasks.every(task=>!task.enabled));
    await page.getByRole('button',{name:'任务中心',exact:true}).click();
    await page.locator('[data-task-id]').first().waitFor();
    assert.equal(await page.locator('[data-task-id]').count(),20);
    await page.screenshot({path:path.join(project,'test-results','portable-tasks.png')});
    await page.close();
    console.log(`PASS portable: standalone launcher extracted and opened, ${state.agents.length} registered adapters, Qoder card and file-only configuration, 9 rewards entries, extracted native component, no default claim grants, local bridge, isolated profile, renderer without Node, navigation.`);
  } finally {
    if (browser) {
      for (const context of browser.contexts()) for (const page of context.pages()) await page.close().catch(()=>{});
      await browser.close().catch(()=>{});
    }
    if (exitCode === undefined) {
      await Promise.race([new Promise(resolve=>child.once('exit',resolve)),pause(5000)]);
      if (exitCode === undefined) child.kill();
    }
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
