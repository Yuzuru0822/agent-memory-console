import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { fixture } from './helpers';
import { WorkbenchService } from '../electron/workbench/service';
import { WorkbenchStore } from '../electron/workbench/store';
import { workspaceTools } from '../electron/workbench/tools';
import { runRuntime } from '../electron/workbench/runtime';
import type { Runner } from '../electron/workbench/runtime';
import type { AgentInstance, AgentRun } from '../src/workbench-types';
import { AgentBridge } from '../electron/agent-bridge';
import { sse, guardedFetch } from '../electron/workbench/network';
const key = crypto.randomBytes(32);
const codec = {
  seal(text: string) { const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, iv); return Buffer.concat([iv, cipher.update(text), cipher.final(), cipher.getAuthTag()]).toString('base64'); },
  open(text: string) { const data = Buffer.from(text, 'base64'), decipher = crypto.createDecipheriv('aes-256-gcm', key, data.subarray(0, 12)); decipher.setAuthTag(data.subarray(-16)); return Buffer.concat([decipher.update(data.subarray(12, -16)), decipher.final()]).toString(); },
};
const agent = (id = 'test'): AgentInstance => ({ id, name: id, provider: 'workbuddy', runtime: 'api', endpoint: 'https://example.com/v1/chat/completions', model: 'test-model', allowLoopback: false, memoryFiles: [], skillFiles: [], mcpServers: [], maxOutputTokens: 128, maxTurns: 2, tokenBudget: 0 });
async function settle(service: WorkbenchService, id: string) {
  for (let i = 0; i < 200; i++) { const run = service.store.get<AgentRun>('run', id)!; if (!['queued','running','approval'].includes(run.state)) return run; await new Promise(r => setTimeout(r, 5)); }
  throw new Error('run did not finish');
}
function setup(t: any, runner: Runner = async () => ({ text: 'answer', inputTokens: 10, outputTokens: 5 })) {
  const f = fixture(t), workbench = new WorkbenchService(f.service, codec, undefined, undefined, runner); t.after(() => workbench.close()); return { ...f, workbench };
}
test('legacy migration is idempotent and leaves existing config untouched', async t => {
  const f = fixture(t), before = JSON.stringify(f.service.config);
  let w = new WorkbenchService(f.service, codec); assert.equal(w.snapshot().agents.length, 7); assert.equal(w.snapshot().agents.find(a => a.id === 'legacy.claude')?.runtime, 'claude'); await w.close();
  w = new WorkbenchService(f.service, codec); assert.equal(w.snapshot().agents.length, 7); assert.equal(JSON.stringify(f.service.config), before); await w.close();
});
test('same provider supports multiple instances with persistent messages and events', async t => {
  const { workbench: w } = setup(t, async i => { i.emit('text', 'hello'); return { text: 'hello', inputTokens: 7, outputTokens: 1 }; });
  w.saveAgent(agent('a')); w.saveAgent(agent('b')); const a = w.newSession('a'), b = w.newSession('b');
  const r1 = w.send(a.id, 'one'), r2 = w.send(b.id, 'two');
  assert.equal((await settle(w, r1.id)).state, 'completed'); assert.equal((await settle(w, r2.id)).state, 'completed');
  const detail = w.detail(a.id); assert.equal(detail.messages.length, 2); assert.equal(detail.messages[1].text, 'hello'); assert.deepEqual(detail.events.map(e => e.seq), [1,2,3]);
});
test('credential is scoped to endpoint and never returned in snapshot or stored plaintext', async t => {
  const { workbench: w, service } = setup(t);
  const a = w.saveAccount({ name: 'private', endpoint: agent().endpoint!, secret: 'very-sensitive-fixture-value' });
  w.saveAgent({ ...agent(), accountId: a.id });
  assert.throws(() => w.saveAgent({ ...agent('bad'), accountId: a.id, endpoint: 'https://different.example/v1/chat/completions' }), /凭据/);
  assert.ok(!JSON.stringify(w.snapshot()).includes('very-sensitive-fixture-value'));
  for (const name of fs.readdirSync(service.storage).filter(n => n.startsWith('workbench.sqlite'))) assert.ok(!fs.readFileSync(path.join(service.storage, name)).includes(Buffer.from('very-sensitive-fixture-value')));
});
test('archive and identity changes are blocked for active sessions; cancel settles', async t => {
  const { workbench: w } = setup(t, async i => { await new Promise((_r, reject) => i.signal.addEventListener('abort', () => reject(new Error('aborted')))); return { text: '' }; });
  w.saveAgent(agent()); const s = w.newSession('test'), r = w.send(s.id, 'wait');
  assert.throws(() => w.send(s.id, 'duplicate'), /正在执行/); assert.throws(() => w.archive(s.id), /运行结束/);
  w.cancel(r.id); assert.equal((await settle(w, r.id)).state, 'canceled');
  assert.throws(() => w.saveAgent({ ...agent(), model: 'new-model' }), /已有会话/); w.archive(s.id); assert.throws(() => w.send(s.id, 'new'), /归档/);
});
test('restart marks nonterminal runs interrupted and does not execute them', async t => {
  const f = fixture(t); let w = new WorkbenchService(f.service, codec); w.saveAgent(agent()); const s = w.newSession('test');
  w.store.put('run', { id: 'unknown', sessionId: s.id, agentId: 'test', state: 'running', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), output: 'partial', reservedTokens: 100, assets: [], usage: 'unknown' } satisfies AgentRun); await w.close();
  w = new WorkbenchService(f.service, codec, undefined, undefined, async () => { throw new Error('must not execute'); });
  assert.equal(w.snapshot().runs[0].state, 'interrupted'); assert.equal(w.snapshot().runs[0].output, 'partial'); await w.close();
});
test('transaction rolls back when codec refuses encryption', t => {
  const f = fixture(t); let fail = false; const db = new WorkbenchStore(f.service.storage, { ...codec, seal(text) { if (fail) throw new Error('locked'); return codec.seal(text); } });
  assert.throws(() => db.transaction(() => { db.put('test', { id: 'one' }); fail = true; db.put('test', { id: 'two' }); }), /locked/); assert.equal(db.all('test').length, 0); db.close();
});
test('context is versioned per run and does not change when source changes', async t => {
  const { workbench: w, file } = setup(t, async input => ({ text: input.assets[0].text })); const source = file('memory.md', 'original');
  w.saveAgent({ ...agent(), memoryFiles: [source] }); const s = w.newSession('test'), r = w.send(s.id, 'hello'); fs.writeFileSync(source, 'changed');
  assert.equal((await settle(w, r.id)).assets[0].text, 'original'); assert.equal(w.detail(s.id).messages[1].text, 'original');
});
test('budget rejects before executing and unknown reservations persist', async t => {
  let calls = 0; const { workbench: w } = setup(t, async () => { calls++; return { text: 'ok' }; }); w.saveAgent({ ...agent(), tokenBudget: 10 }); const s = w.newSession('test');
  assert.throws(() => w.send(s.id, 'test'), /预算不足/); assert.equal(calls, 0); assert.equal(w.detail(s.id).messages.length, 0);
});
test('workspace tools enforce paths and detect modifications during approval', async t => {
  const f = fixture(t), root = f.dir('project'); f.file('project/a.txt', 'old');
  const tools = workspaceTools(root, async () => { fs.writeFileSync(path.join(root, 'a.txt'), 'other'); });
  await assert.rejects(tools[0].call({ path: '../outside' }), /范围/); await assert.rejects(tools[1].call({ path: 'a.txt', content: 'new' }), /已变化/);
  assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'other');
});
test('tool approval is required, one-use, and tied to a run', async t => {
  const f = fixture(t), root = f.dir('project'); f.file('project/a.txt', 'approved content');
  const w = new WorkbenchService(f.service, codec, undefined, undefined, async i => ({ text: await i.tools[0].call({ path: 'a.txt' }) })); t.after(() => w.close());
  w.saveAgent({ ...agent(), workspace: root }); const s = w.newSession('test'), r = w.send(s.id, 'read');
  await new Promise(r => setTimeout(r, 10)); const approval = w.snapshot().approvals[0]; assert.ok(approval); assert.equal(approval.runId, r.id); w.approve(approval.id, true);
  assert.throws(() => w.approve(approval.id, true), /过期/); assert.equal((await settle(w, r.id)).output, 'approved content');
});
test('bridge dispatch is deduplicated and replies retain console-user provenance', async t => {
  const f = fixture(t), bridge = new AgentBridge(f.service, codec), config = bridge.snapshot().config;
  config.agents.forEach(a => { a.enabled = true; a.allowTargets = config.agents.filter(b => b.id !== a.id).map(b => b.id); }); bridge.configure(config);
  const task = await bridge.send({ source: 'claude', target: 'workbuddy', text: 'please review', messageId: 'stable' });
  let calls = 0; const w = new WorkbenchService(f.service, codec, undefined, bridge, async () => { calls++; return { text: 'reviewed' }; }); t.after(() => w.close()); w.saveAgent(agent());
  const r = w.dispatch(task.id, 'test'); assert.equal(w.dispatch(task.id, 'test').id, r.id); await settle(w, r.id); assert.equal(calls, 1);
  const updated = bridge.snapshot().tasks.find(t => t.id === task.id)!; assert.equal(updated.state, 'completed'); assert.equal(updated.messages.at(-1)?.by, 'console-user');
});
test('SSE parser handles split frames and rejects truncated frames', async () => {
  const r = new Response('data: {"x":1}\r\n\r\ndata: [DONE]\r\n\r\n'); const found = []; for await (const e of sse(r)) found.push(e); assert.deepEqual(found, [{ x: 1 }]);
  await assert.rejects(async () => { for await (const _ of sse(new Response('data: {"x":1}'))) {} }, /中断/);
});
test('network denies metadata targets and redirects', async t => {
  await assert.rejects(guardedFetch('https://169.254.169.254/metadata'), /地址/);
  const server = http.createServer((_req, res) => { res.writeHead(302, { location: 'http://169.254.169.254' }); res.end(); }); await new Promise<void>(r => server.listen(0, '127.0.0.1', r)); t.after(() => server.close());
  await assert.rejects(guardedFetch(`http://127.0.0.1:${(server.address() as any).port}`), /重定向/);
});
test('API runtime streams, invokes approved tool and continues with result', async t => {
  let round = 0, called = false; const requests: any[] = [];
  const server = http.createServer((req, res) => {
    let body = ''; req.on('data', c => body += c); req.on('end', () => {
      requests.push(JSON.parse(body)); res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const chunks = round++ === 0 ? [{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'read', arguments: '{"path":"a"}' } }] }, finish_reason: 'tool_calls' }] }] : [{ choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }] }];
      for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
      res.end('data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":2}}\n\ndata: [DONE]\n\n');
    });
  }); await new Promise<void>(r => server.listen(0, '127.0.0.1', r)); t.after(() => server.close());
  const result = await runRuntime({ agent: { ...agent(), endpoint: `http://127.0.0.1:${(server.address() as any).port}`, allowLoopback: true }, sessionId: 's', messages: [{ role: 'user', content: 'read' }], assets: [], signal: new AbortController().signal, emit() {}, tools: [{ name: 'read', description: 'read', parameters: {}, async call() { called = true; return 'content'; } }] });
  assert.equal(result.text, 'done'); assert.equal(result.inputTokens, 20); assert.ok(called); assert.equal(requests[1].messages.at(-1).role, 'tool');
});
test('MCP SDK interoperates with authenticated bridge and requires connect/call approval', async t => {
  const { connectMcp } = await import('../electron/workbench/tools');
  const f = fixture(t), bridge = new AgentBridge(f.service, codec), config = bridge.snapshot().config;
  const probe = http.createServer(); await new Promise<void>(r => probe.listen(0, '127.0.0.1', r)); const port = (probe.address() as any).port; await new Promise<void>(r => probe.close(() => r()));
  config.port = port; config.agents.find(a => a.id === 'claude')!.enabled = true; bridge.configure(config); await bridge.start(); t.after(() => bridge.stop());
  const connection = bridge.connection('claude'); let approvals = 0;
  const client = await connectMcp('bridge', { type: 'http', url: connection.url, headers: connection.headers }, async () => { approvals++; }, new AbortController().signal);
  try { assert.ok(client.tools.length >= 5); const result = await client.tools[0].call({}); assert.ok(result.includes('content')); assert.equal(approvals, 2); } finally { await client.close(); }
});
test('OpenClaw uses stable session key and sends only the current user message', async t => {
  let body: any;
  const server = http.createServer((req, res) => { let text = ''; req.on('data', c => text += c); req.on('end', () => { body = JSON.parse(text); res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end('data: {"choices":[{"delta":{"content":"gateway answer"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'); }); });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r)); t.after(() => server.close());
  const result = await runRuntime({ agent: { ...agent(), runtime: 'openclaw', endpoint: `http://127.0.0.1:${(server.address() as any).port}`, model: 'openclaw/default', allowLoopback: true }, sessionId: 'stable-session', messages: [{ role: 'user', content: 'old' }, { role: 'assistant', content: 'previous' }, { role: 'user', content: 'new' }], assets: [], tools: [], signal: new AbortController().signal, emit() {} });
  assert.equal(body.user, 'stable-session'); assert.equal(body.messages.length, 1); assert.equal(body.messages[0].content, 'new'); assert.equal(result.externalId, 'stable-session'); assert.equal(result.inputTokens, undefined);
});
test('worktree creates an independent instance and shared memory saves reviewed text', async t => {
  const { execFileSync } = await import('node:child_process'); const f = setup(t); const root = f.dir('project'); f.file('project/a.txt', 'original');
  execFileSync('git', ['init'], { cwd: root }); execFileSync('git', ['add', '.'], { cwd: root }); execFileSync('git', ['-c','user.name=Test','-c','user.email=test@example.invalid','commit','-m','initial'], { cwd: root });
  f.workbench.saveAgent({ ...agent(), workspace: root }); const next = await f.workbench.worktree('test', 'independent'); assert.notEqual(next.workspace, root); assert.equal(fs.readFileSync(path.join(next.workspace!, 'a.txt'), 'utf8'), 'original');
  const central = f.dir('central'); f.service.config.repository = { root: central, agentIds: [], memoryFolders: {}, automation: { enabled: false, intervalSeconds: 60, cleanupEnabled: false, retentionDays: 30, minBackups: 20 } };
  const s = f.workbench.newSession('test'), file = f.workbench.remember(s.id, 'reviewed memory'); assert.match(fs.readFileSync(file, 'utf8'), /reviewed memory/); assert.ok(file.startsWith(central));
});
test('stream redaction protects credentials split across arbitrary chunk boundaries', async () => {
  const { SecretRedactor } = await import('../electron/workbench/redaction');
  const source = 'before secret-token after';
  for (let cut = 0; cut <= source.length; cut++) {
    const r = new SecretRedactor(['secret-token']); const output = r.push(source.slice(0, cut)) + r.push(source.slice(cut)) + r.finish();
    assert.equal(output, 'before [REDACTED] after');
  }
});
