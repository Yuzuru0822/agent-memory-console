/* Browser-only renderer smoke; IPC is mocked. Run after npm run build. */
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
(async () => {
  const http = require('node:http');
  const root = path.resolve('dist');
  const server = http.createServer((req, res) => {
    const file = path.resolve(root, '.' + (req.url === '/' ? '/index.html' : req.url.split('?')[0]));
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
    res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html');
    res.end(fs.readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const app = await chromium.launch({ executablePath: process.env.CHROME_BIN || undefined, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await app.newPage({ viewport: { width: 1460, height: 1000 } });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(() => {
    const agents = [{ id: 'demo', name: '研发助手', provider: 'workbuddy', runtime: 'api', endpoint: 'https://example.com/v1/chat/completions', model: 'fixture', allowLoopback: false, memoryFiles: [], skillFiles: [], mcpServers: [], maxOutputTokens: 4096, maxTurns: 4, tokenBudget: 0 }];
    const sessions = [], messages = [], runs = [];
    const file = { path: '', exists: false }, skills = { path: '', exists: false, count: 0, files: 0, linked: false };
    window.consoleApi = {
      snapshot: async () => ({ at: new Date().toISOString(), agents: [], canonicalMemory: file, canonicalSkills: skills, backups: [], logs: [], auditValid: true, storagePath: 'fixture' }),
      taskControlsSnapshot: async () => ({ controls: { paused: false, closeToTray: false }, runtime: { busy: false, trayAvailable: false, windowVisible: true } }),
      repositoryProgress: async () => undefined,
      workbenchSnapshot: async () => ({ agents, accounts: [], sessions, runs, approvals: [] }),
      bridgeSnapshot: async () => ({ tasks: [] }), mcpSnapshot: async () => ({ servers: [] }),
      workbenchNewSession: async agentId => { const s = { id: 's1', agentId, title: '新会话', createdAt: new Date().toISOString(), archived: false }; sessions.push(s); return s; },
      workbenchSession: async id => ({ session: sessions.find(s => s.id === id), messages, runs, events: [] }),
      workbenchSend: async (sessionId, text) => { const run = { id: 'r1', sessionId, agentId: 'demo', state: 'completed', output: '已完成任务分析。', usage: 'actual', inputTokens: 25, outputTokens: 10, assets: [] }; messages.push({ id: 'm1', sessionId, runId: run.id, role: 'user', text, at: new Date().toISOString() }, { id: 'm2', sessionId, runId: run.id, role: 'assistant', text: run.output, at: new Date().toISOString() }); runs.push(run); return run; },
      workbenchArchive: async id => { sessions.find(s => s.id === id).archived = true; },
      workbenchSaveAgent: async a => { agents.push(a); return a; },
    };
  });
  try {
    await page.goto(process.env.CONSOLE_UI_URL || url);
    await page.getByRole('button', { name: 'Agent 工作台', exact: true }).click();
    await page.getByRole('button', { name: '新会话', exact: true }).click();
    await page.getByLabel('对话消息').fill('分析当前项目的依赖关系');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await page.getByText('已完成任务分析。', { exact: true }).waitFor();
    await page.getByRole('button', { name: '新建实例', exact: true }).click();
    await page.getByLabel('名称', { exact: true }).fill('第二个研发助手');
    await page.getByLabel('完整端点').fill('https://example.com/v1/chat/completions');
    await page.getByLabel('模型 / OpenClaw Agent').fill('fixture');
    await page.getByRole('button', { name: '保存实例与授权' }).click();
    await page.getByRole('option', { name: '第二个研发助手 · api' }).waitFor({ state: 'attached' });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'no horizontal overflow');
    fs.mkdirSync(path.resolve('test-results'), { recursive: true });
    await page.screenshot({ path: path.resolve('test-results/workbench.png'), fullPage: true });
    assert.deepEqual(errors, []); console.log('Workbench renderer smoke passed: conversation, instance form, layout, no page errors.');
  } finally { await app.close(); server.close(); }
})().catch(e => { console.error(e); process.exit(1); });
