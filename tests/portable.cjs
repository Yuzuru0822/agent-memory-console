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
  const executable = path.join(project, 'release', 'Agent-Memory-Console-0.1.0-win-x64.exe');
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
    assert.equal(await page.locator('.agent-card').count(), 6);
    assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
    const state = await page.evaluate(() => window.consoleApi.snapshot());
    assert.equal(path.dirname(state.storagePath).toLowerCase(), profile.toLowerCase());
    await page.getByRole('button', {name:'集成能力',exact:true}).click();
    assert.equal(await page.locator('.integration-row').count(), 6);
    await page.screenshot({path:path.join(project,'test-results','portable-integrations.png')});
    await page.close();
    console.log('PASS portable: standalone launcher extracted and opened, six adapters, local bridge, isolated profile, renderer without Node, navigation.');
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
