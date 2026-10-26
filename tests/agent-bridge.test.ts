import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { AgentBridge } from "../electron/agent-bridge";
import { publicAddress, remoteUrl, deadline, bridgeRpc } from "../electron/agent-bridge-network";
import { fixture } from "./helpers";
import type { AgentId } from "../src/shared";
import type { BridgeTask } from "../src/bridge-types";

// All network tests use isolated loopback HTTP fixtures. No vendor process, account or real endpoint is contacted.
const codec = { seal: (value: string) => Buffer.from(value).toString("base64"), open: (value: string) => Buffer.from(value, "base64").toString("utf8") };
async function freePort() { const server = http.createServer(); await new Promise<void>(r => server.listen(0, "127.0.0.1", r)); const port = (server.address() as any).port; await new Promise<void>(r => server.close(() => r())); return port as number; }
async function setup(t: TestContext, options = {}) {
  const f = fixture(t), bridge = new AgentBridge(f.service, codec, options), config = bridge.snapshot().config;
  config.port = await freePort(); config.agents.forEach(a => { a.enabled = true; a.allowTargets = config.agents.filter(b => b.id !== a.id).map(b => b.id); }); bridge.configure(config);
  t.after(() => bridge.stop()); return { ...f, bridge, config };
}
async function request(url: string, token: string, body: unknown, headers: Record<string, string> = {}, method = "POST") {
  const res = await fetch(url, { method, headers: { Authorization: token, "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers }, ...(method === "POST" ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}) });
  const raw = await res.text(); return { status: res.status, body: raw ? JSON.parse(raw) : undefined, session: res.headers.get("mcp-session-id") };
}
async function client(bridge: AgentBridge, actor: AgentId) {
  const connection = bridge.connection(actor), url = connection.url, token = connection.headers.Authorization;
  const init = await request(url, token, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } } });
  assert.equal(init.body.result.protocolVersion, "2025-11-25"); assert.ok(init.session);
  const headers = { "Mcp-Session-Id": init.session!, "MCP-Protocol-Version": "2025-11-25" };
  assert.equal((await request(url, token, { jsonrpc: "2.0", method: "notifications/initialized" }, headers)).status, 202);
  return { url, token, headers, call: async (name: string, args = {}) => (await request(url, token, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } }, headers)).body.result };
}
function a2a(bridge: AgentBridge, source: AgentId, target: AgentId, method: string, params: any = {}, headers = { "A2A-Version": "1.0" }) {
  const c = bridge.connection(source); return request(c.url.replace(`/mcp/${source}`, `/a2a/${target}`), c.headers.Authorization, { jsonrpc: "2.0", id: "rpc", method, params }, headers);
}
const message = (messageId = "message-1", extra = {}) => ({ messageId, role: "ROLE_USER", parts: [{ text: "hello-peer" }], ...extra });
async function mockRemote(t: TestContext, handler: (body: any, response: http.ServerResponse) => void) {
  const calls: any[] = [], server = http.createServer(async (req, res) => { let body = ""; for await (const part of req) body += part; const parsed = JSON.parse(body); calls.push({ ...parsed, headers: req.headers }); res.setHeader("Content-Type", "application/json"); handler(parsed, res); });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r)); t.after(() => { server.closeAllConnections(); server.close(); });
  return { calls, endpoint: `http://127.0.0.1:${(server.address() as any).port}/rpc` };
}
async function register(f: Awaited<ReturnType<typeof setup>>, endpoint: string) { f.bridge.saveRemote({ id: "remote.test", name: "Fixture", endpoint, allowLoopback: true, token: "test-remote-token" }); const c = f.bridge.snapshot().config; c.agents.find(a => a.id === "claude")!.allowTargets.push("remote.test"); f.bridge.configure(c); }

test("bridge defaults closed, all identities disabled and configuration validates complete ACL", async t => {
  const f = fixture(t), bridge = new AgentBridge(f.service, codec);
  assert.equal(bridge.snapshot().running, false); assert.ok(bridge.snapshot().agents.every(a => !a.enabled && !a.tokenSet));
  await assert.rejects(bridge.start(), /至少/);
  assert.throws(() => bridge.configure({ port: 0, agents: [] }), /无效/);
  const c = bridge.snapshot().config; c.agents[0].allowTargets = [c.agents[0].id]; assert.throws(() => bridge.configure(c), /自身/);
});
test("independent credentials, private persistence, no token in snapshots or audit", async t => {
  const f = await setup(t), a = f.bridge.connection("claude"), b = f.bridge.connection("trae");
  assert.notEqual(a.headers.Authorization, b.headers.Authorization);
  assert.ok(!JSON.stringify(f.bridge.snapshot()).includes(a.headers.Authorization.slice(7)));
  await f.bridge.send({ source: "claude", target: "trae", text: "SECRET-BODY-ONLY", messageId: "stable-1" });
  const raw = fs.readFileSync(path.join(f.service.storage, "agent-bridge.private.json"), "utf8"); assert.ok(!raw.includes("SECRET-BODY-ONLY"));
  assert.ok(!JSON.stringify(f.service.verifyAudit().rows).includes("SECRET-BODY-ONLY"));
  const reopened = new AgentBridge(f.service, codec); assert.equal(reopened.snapshot().running, false); assert.equal(reopened.snapshot().tasks[0].messages[0].text, "SECRET-BODY-ONLY");
});
test("two real MCP HTTP identities send, inspect, claim and reply without claiming model execution", async t => {
  const f = await setup(t); await f.bridge.start(); const sender = await client(f.bridge, "claude"), recipient = await client(f.bridge, "trae");
  const sent = await sender.call("bridge_message_send", { target: "trae", text: "review-this", messageId: "send-1", source: "workbuddy" });
  const task: BridgeTask = sent.structuredContent.result; assert.equal(task.source, "claude"); assert.equal(task.delivery, "queued"); assert.equal(task.state, "submitted");
  const inbox = await recipient.call("bridge_inbox_list"); assert.equal(inbox.structuredContent.result[0].id, task.id); assert.equal(f.bridge.snapshot().tasks[0].delivery, "queued");
  const claimed = await recipient.call("bridge_task_claim", { taskId: task.id }); assert.equal(claimed.structuredContent.result.delivery, "received");
  const replied = await recipient.call("bridge_task_reply", { taskId: task.id, text: "reviewed", state: "completed" }); assert.equal(replied.structuredContent.result.messages[1].by, "trae");
  const observed = await sender.call("bridge_task_get", { taskId: task.id }); assert.equal(observed.structuredContent.result.state, "completed"); assert.ok(f.bridge.snapshot().agents.find(a => a.id === "trae")!.lastConnectedAt);
});
test("ACL blocks disabled destinations and unauthorized edges", async t => {
  const f = await setup(t), c = f.bridge.snapshot().config; c.agents.find(a => a.id === "claude")!.allowTargets = []; f.bridge.configure(c);
  await assert.rejects(f.bridge.send({ source: "claude", target: "trae", text: "x" }), /未授权/);
  c.agents.find(a => a.id === "claude")!.allowTargets = ["trae"]; c.agents.find(a => a.id === "trae")!.enabled = false; f.bridge.configure(c);
  await assert.rejects(f.bridge.send({ source: "claude", target: "trae", text: "x" }), /未启用/);
});
test("MCP foreign identities cannot read, claim, reply to or cancel unrelated tasks", async t => {
  const f = await setup(t), task = await f.bridge.send({ source: "claude", target: "trae", text: "private" }); await f.bridge.start();
  const foreign = await client(f.bridge, "qoder"), sender = await client(f.bridge, "claude");
  for (const name of ["bridge_task_get", "bridge_task_claim", "bridge_task_cancel", "bridge_task_reply"]) assert.equal((await foreign.call(name, { taskId: task.id, text: "spoof", state: "completed" })).isError, true);
  assert.equal((await sender.call("bridge_task_reply", { taskId: task.id, text: "spoof", state: "completed" })).isError, true);
});
test("stable message IDs survive restart and mismatched duplicate content fails", async t => {
  const f = await setup(t), input = { source: "claude" as const, target: "trae", text: "once", messageId: "once-id" };
  const first = await f.bridge.send(input), second = await f.bridge.send(input); assert.equal(first.id, second.id);
  await assert.rejects(f.bridge.send({ ...input, text: "different" }), /messageId/);
  const reopened = new AgentBridge(f.service, codec); assert.equal((await reopened.send(input)).id, first.id); assert.equal(reopened.snapshot().tasks.length, 1);
});
test("manual replies retain console-user provenance and terminal tasks cannot reopen", async t => {
  const f = await setup(t), task = await f.bridge.send({ source: "claude", target: "trae", text: "question" });
  const reply = f.bridge.reply({ taskId: task.id, text: "human reply", state: "completed" }); assert.equal(reply.messages[1].by, "console-user");
  assert.throws(() => f.bridge.reply({ taskId: task.id, text: "again", state: "completed" }), /不能/); await assert.rejects(f.bridge.cancel(task.id), /结束/);
});
test("local cancellation is idempotent and does not delete message history", async t => {
  const f = await setup(t), task = await f.bridge.send({ source: "claude", target: "trae", text: "cancel" });
  assert.equal((await f.bridge.cancel(task.id)).delivery, "canceled"); assert.equal((await f.bridge.cancel(task.id)).state, "canceled"); assert.equal(f.bridge.snapshot().tasks[0].messages.length, 1);
});
test("tokens are required on discovery and token rotation revokes existing MCP session", async t => {
  const f = await setup(t); await f.bridge.start(); const old = await client(f.bridge, "claude");
  assert.equal((await request(old.url, "Bearer invalid", {})).status, 401);
  f.bridge.rotateToken("claude"); assert.equal((await request(old.url, old.token, { jsonrpc: "2.0", id: 1, method: "tools/list" }, old.headers)).status, 401);
  const cardUrl = old.url.replace("/mcp/claude", "/a2a/trae/.well-known/agent-card.json");
  const card = await request(cardUrl, f.bridge.connection("claude").headers.Authorization, undefined, {}, "GET"); assert.equal(card.body.supportedInterfaces[0].protocolVersion, "1.0"); assert.deepEqual(card.body.securityRequirements, [{ schemes: { bridge: { list: [] } } }]);
});
test("Host and Origin checks reject browser/rebinding requests; HTTP GET MCP has no SSE", async t => {
  const f = await setup(t); await f.bridge.start(); const c = f.bridge.connection("claude");
  assert.equal((await request(c.url, c.headers.Authorization, {}, { Origin: "https://evil.example" })).status, 403);
  const status = await new Promise<number>(resolve => { const req = http.request(c.url, { method: "GET", headers: { Host: "evil.example", Authorization: c.headers.Authorization } }, res => { res.resume(); resolve(res.statusCode!); }); req.end(); });
  assert.equal(status, 403);
  assert.equal((await request(c.url, c.headers.Authorization, undefined, {}, "GET")).status, 405);
});
test("MCP protocol/session lifecycle and notification response are explicit", async t => {
  const f = await setup(t); await f.bridge.start(); const c = f.bridge.connection("claude");
  const malformed = await request(c.url, c.headers.Authorization, "{"); assert.equal(malformed.body.error.code, -32700);
  const batch = await request(c.url, c.headers.Authorization, []); assert.equal(batch.body.error.code, -32600);
  const withoutInit = await request(c.url, c.headers.Authorization, { jsonrpc: "2.0", id: 2, method: "tools/list" }); assert.equal(withoutInit.body.error.code, -32600);
  const user = await client(f.bridge, "claude"); const list = await request(user.url, user.token, { jsonrpc: "2.0", id: 2, method: "tools/list" }, user.headers); assert.equal(list.body.result.tools.length, 7);
  assert.equal((await request(user.url, user.token, { jsonrpc: "2.0", id: 3, method: "tools/list" }, { ...user.headers, Accept: "application/json" })).status, 406);
});
test("MCP negotiates one supported version and rejects mixed protocol headers after initialization", async t => {
  const f = await setup(t); await f.bridge.start(); const c = f.bridge.connection("claude");
  for (const proposed of ["2025-03-26", "2099-01-01"]) {
    const init = await request(c.url, c.headers.Authorization, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: proposed, capabilities: {}, clientInfo: { name: "negotiation-test", version: "1" } } });
    assert.equal(init.body.result.protocolVersion, "2025-11-25"); assert.ok(init.session);
    const negotiated = { "Mcp-Session-Id": init.session!, "MCP-Protocol-Version": init.body.result.protocolVersion };
    const initialized = { jsonrpc: "2.0", method: "notifications/initialized" };
    assert.equal((await request(c.url, c.headers.Authorization, initialized, { ...negotiated, "MCP-Protocol-Version": proposed })).status, 400);
    const list = { jsonrpc: "2.0", id: 2, method: "tools/list" };
    assert.equal((await request(c.url, c.headers.Authorization, list, negotiated)).body.error.code, -32600);
    assert.equal((await request(c.url, c.headers.Authorization, initialized, negotiated)).status, 202);
    assert.equal((await request(c.url, c.headers.Authorization, list, negotiated)).body.result.tools.length, 7);
    assert.equal((await request(c.url, c.headers.Authorization, list, { ...negotiated, "MCP-Protocol-Version": proposed })).status, 400);
    assert.equal((await request(c.url, c.headers.Authorization, list, { "Mcp-Session-Id": init.session! })).status, 400);
  }
});
test("A2A 1.0 uses wrapped SendMessage response, exact enums, GetTask and no legacy default", async t => {
  const f = await setup(t); await f.bridge.start();
  const result = await a2a(f.bridge, "claude", "trae", "SendMessage", { message: message(), configuration: { returnImmediately: true, historyLength: 0 } });
  const task = result.body.result.task; assert.equal(task.status.state, "TASK_STATE_SUBMITTED"); assert.equal(task.history, undefined);
  const got = await a2a(f.bridge, "claude", "trae", "GetTask", { id: task.id }); assert.equal(got.body.result.id, task.id); assert.equal(got.body.result.history[0].role, "ROLE_USER");
  assert.equal((await a2a(f.bridge, "claude", "trae", "GetTask", { id: task.id }, {} as any)).body.error.code, -32009);
  assert.equal((await a2a(f.bridge, "claude", "trae", "message/send", {})).body.error.code, -32601);
});
test("A2A default blocking waits for actual reply and timeout preserves submitted task", async t => {
  const f = await setup(t, { blockingWaitMs: 200 }); await f.bridge.start();
  const wait = a2a(f.bridge, "claude", "trae", "SendMessage", { message: message("wait-1") });
  while (!f.bridge.snapshot().tasks.length) await new Promise(r => setTimeout(r, 5));
  f.bridge.reply({ taskId: f.bridge.snapshot().tasks[0].id, text: "done", state: "completed" }); assert.equal((await wait).body.result.task.status.state, "TASK_STATE_COMPLETED");
  const timeout = await a2a(f.bridge, "claude", "trae", "SendMessage", { message: message("wait-2") }); assert.equal(timeout.body.error.code, -32004); assert.equal(f.bridge.snapshot().tasks.find(t => t.messageId === "wait-2")!.state, "submitted");
});
test("A2A continuation enforces task context and rejects unsupported payload/capabilities", async t => {
  const f = await setup(t); await f.bridge.start();
  const result = await a2a(f.bridge, "claude", "trae", "SendMessage", { message: message(), configuration: { returnImmediately: true } }), task = result.body.result.task;
  f.bridge.reply({ taskId: task.id, text: "need detail", state: "input-required" });
  const bad = await a2a(f.bridge, "claude", "trae", "SendMessage", { message: message("more", { taskId: task.id, contextId: "wrong" }), configuration: { returnImmediately: true } }); assert.equal(bad.body.error.code, -32602);
  const good = await a2a(f.bridge, "claude", "trae", "SendMessage", { message: message("more", { taskId: task.id }), configuration: { returnImmediately: true } }); assert.equal(good.body.result.task.contextId, task.contextId);
  assert.equal((await a2a(f.bridge, "claude", "trae", "SendMessage", { message: message("file", { parts: [{ raw: "abc" }] }) })).body.error.code, -32005);
  assert.equal((await a2a(f.bridge, "claude", "trae", "SubscribeToTask", { id: task.id })).body.error.code, -32004);
  assert.equal((await a2a(f.bridge, "claude", "trae", "CreateTaskPushNotificationConfig", {})).body.error.code, -32003);
});
test("completed A2A continuations return the original result on exact retry without reopening or duplicating", async t => {
  const f = await setup(t); await f.bridge.start();
  const initial = await f.bridge.send({ source: "claude", target: "trae", text: "question", messageId: "initial-retry" });
  const needed = f.bridge.reply({ taskId: initial.id, text: "hello-peer", state: "input-required" }, "trae");
  const recipientMessageId = needed.messages.at(-1)!.id;
  const spoof = await a2a(f.bridge, "claude", "trae", "SendMessage", { message: message(recipientMessageId, { taskId: initial.id }), configuration: { returnImmediately: true } });
  assert.equal(spoof.body.error.code, -32602);
  const followup = message("completed-retry", { taskId: initial.id, contextId: initial.contextId });
  await a2a(f.bridge, "claude", "trae", "SendMessage", { message: followup, configuration: { returnImmediately: true } });
  f.bridge.reply({ taskId: initial.id, text: "finished", state: "completed" }, "trae");
  const before = f.bridge.snapshot().tasks;
  const retry = await a2a(f.bridge, "claude", "trae", "SendMessage", { message: followup });
  assert.equal(retry.body.result.task.id, initial.id); assert.equal(retry.body.result.task.status.state, "TASK_STATE_COMPLETED");
  const originalRetry = await a2a(f.bridge, "claude", "trae", "SendMessage", { message: message("initial-retry", { taskId: initial.id, parts: [{ text: "question" }] }) });
  assert.equal(originalRetry.body.result.task.id, initial.id);
  for (const invalid of [
    { ...followup, contextId: "wrong-context" }, { ...followup, contextId: "" },
    { ...followup, parts: [{ text: "changed-content" }] }, { ...followup, messageId: "new-message-on-terminal" },
  ]) assert.equal((await a2a(f.bridge, "claude", "trae", "SendMessage", { message: invalid, configuration: { returnImmediately: true } })).body.error.code, -32602);
  assert.equal((await a2a(f.bridge, "claude", "qoder", "SendMessage", { message: followup, configuration: { returnImmediately: true } })).body.error.code, -32602);
  assert.equal((await a2a(f.bridge, "trae", "trae", "SendMessage", { message: followup, configuration: { returnImmediately: true } })).body.error.code, -32602);
  assert.deepEqual(f.bridge.snapshot().tasks, before);
  const other = await f.bridge.send({ source: "claude", target: "trae", text: "another-task" });
  assert.equal((await a2a(f.bridge, "claude", "trae", "SendMessage", { message: { ...followup, taskId: other.id, contextId: other.contextId }, configuration: { returnImmediately: true } })).body.error.code, -32602);
  assert.equal(f.bridge.snapshot().tasks.find(task => task.id === other.id)!.messages.length, 1);
});
test("A2A task listing scopes visibility and cursor pagination", async t => {
  const f = await setup(t); await f.bridge.start();
  for (let i = 0; i < 3; i++) await f.bridge.send({ source: "claude", target: "trae", text: `msg-${i}` });
  await f.bridge.send({ source: "qoder", target: "trae", text: "private-other" });
  const first = (await a2a(f.bridge, "claude", "trae", "ListTasks", { pageSize: 2, historyLength: 0 })).body.result;
  assert.equal(first.totalSize, 3); assert.equal(first.tasks.length, 2); assert.ok(first.nextPageToken);
  const next = (await a2a(f.bridge, "claude", "trae", "ListTasks", { pageSize: 2, pageToken: first.nextPageToken })).body.result; assert.equal(next.tasks.length, 1); assert.equal(next.nextPageToken, "");
});
test("remote send/get/cancel use registered endpoint and separate credential, retain task mapping", async t => {
  const remote = await mockRemote(t, (body, res) => res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: body.method === "SendMessage" ? { task: { id: "remote-task", contextId: "remote-context", status: { state: "TASK_STATE_WORKING" } } } : { id: "remote-task", contextId: "remote-context", status: { state: body.method === "CancelTask" ? "TASK_STATE_CANCELED" : "TASK_STATE_WORKING" } } })));
  const f = await setup(t); await register(f, remote.endpoint);
  const task = await f.bridge.send({ source: "claude", target: "remote.test", text: "to remote", messageId: "remote-once" }); assert.equal(task.remoteTaskId, "remote-task"); assert.equal(task.state, "working");
  assert.equal(remote.calls[0].headers.authorization, "Bearer test-remote-token"); assert.equal(remote.calls[0].headers["a2a-version"], "1.0"); assert.equal(remote.calls[0].params.configuration.returnImmediately, true);
  assert.equal(remote.calls[0].params.message.contextId, undefined);
  await f.bridge.refreshTask(task.id); assert.equal(remote.calls[1].params.id, "remote-task");
  assert.equal((await f.bridge.cancel(task.id)).state, "canceled"); f.bridge.removeRemote("remote.test");
});
test("remote completed message returns real text; failed protocol responses do not invent completion", async t => {
  const remote = await mockRemote(t, (body, res) => res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { message: { messageId: "rmsg", contextId: "rctx", role: "ROLE_AGENT", parts: [{ text: "remote-reply" }] } } })));
  const f = await setup(t); await register(f, remote.endpoint);
  const task = await f.bridge.send({ source: "claude", target: "remote.test", text: "hello" }); assert.equal(task.state, "completed"); assert.equal(task.messages[1].text, "remote-reply"); assert.equal(task.messages[1].by, "remote.test");
});
test("unknown remote outcome never retries on duplicate send or refresh without remote task ID", async t => {
  const remote = await mockRemote(t, (_body, res) => res.end("{broken")), f = await setup(t); await register(f, remote.endpoint);
  const input = { source: "claude" as const, target: "remote.test", text: "once", messageId: "unknown-id" }, task = await f.bridge.send(input);
  assert.equal(task.delivery, "unknown"); assert.notEqual(task.state, "completed"); await f.bridge.send(input); await f.bridge.refreshTask(task.id); assert.equal(remote.calls.length, 1);
  await assert.rejects(f.bridge.cancel(task.id), /结果未知/); assert.throws(() => f.bridge.removeRemote("remote.test"), /未结束/);
});
test("remote redirect is not followed and explicit protocol rejection is recorded as failed", async t => {
  let reject = false; const remote = await mockRemote(t, (body, res) => { if (!reject) { res.statusCode = 302; res.setHeader("Location", "http://169.254.169.254/"); res.end(); } else res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: -32602, message: "bad" } })); });
  const f = await setup(t); await register(f, remote.endpoint); assert.equal((await f.bridge.send({ source: "claude", target: "remote.test", text: "one" })).delivery, "unknown");
  reject = true; assert.equal((await f.bridge.send({ source: "claude", target: "remote.test", text: "two" })).state, "failed"); assert.equal(remote.calls.length, 2);
});
test("unsupported remote responses close their socket immediately even if the body never ends", async t => {
  for (const [status, contentType] of [[500, "application/json"], [200, "text/plain"]] as const) {
    let closed!: () => void; const connectionClosed = new Promise<void>(resolve => { closed = resolve; });
    const remote = await mockRemote(t, (_body, res) => {
      res.writeHead(status, { "Content-Type": contentType }); res.write("unending-body");
      const writing = setInterval(() => res.write("more-data"), 5);
      res.on("close", () => { clearInterval(writing); closed(); }); t.after(() => clearInterval(writing));
    });
    await assert.rejects(bridgeRpc(remote.endpoint, true, undefined, { jsonrpc: "2.0", id: "bad-response", method: "SendMessage" }, 3000), /受支持/);
    await deadline(connectionClosed, 750);
  }
});
test("remote URL policy blocks credentials, private networks, metadata, implicit loopback and self loops", async t => {
  for (const url of ["http://example.com/rpc", "https://user:pass@example.com/rpc", "https://example.com/rpc?token=x", "https://10.0.0.1/rpc", "https://169.254.169.254/rpc", "https://[::1]/rpc", "http://127.0.0.1:9999/rpc"]) assert.throws(() => remoteUrl(url, false));
  for (const address of ["127.0.0.1", "10.0.0.2", "100.64.0.1", "192.168.1.1", "169.254.169.254", "::1", "::ffff:127.0.0.1", "fc00::1", "fe80::1", "2001:db8::1"]) assert.equal(publicAddress(address), false, address);
  assert.equal(publicAddress("8.8.8.8"), true); assert.equal(publicAddress("2606:4700:4700::1111"), true);
  const f = await setup(t); assert.throws(() => f.bridge.saveRemote({ id: "remote.self", name: "self", endpoint: `http://127.0.0.1:${f.config.port}/a2a/claude`, allowLoopback: true }), /当前/);
});
test("IPv6 CIDR policy rejects compressed transition and all special-purpose global prefixes", () => {
  for (const address of ["2001::1", "2001::7f00:1", "2001:0:0:0:0:0:7f00:1", "2001:1::1", "2001:2::1", "2001:3::1", "2001:4:112::1", "2001:10::1", "2001:1f:ffff::1", "2001:20::1", "2001:30::1", "2001:1ff:ffff::1", "2001:db8::1", "2002:7f00:1::", "2620:4f:8000::1", "3fff::1", "3fff:fff:ffff::1"]) {
    assert.equal(publicAddress(address), false, address); assert.throws(() => remoteUrl(`https://[${address}]/rpc`, false), /不允许/);
  }
  for (const address of ["2001:200::1", "2001:4860:4860::8888", "2606:4700:4700::1111", "3ffe:ffff::1", "3fff:1000::1"]) assert.equal(publicAddress(address), true, address);
  assert.equal(publicAddress("2606:4700::1%eth0"), false);
});
test("corrupted private state fails closed, and seal failure rolls back memory", async t => {
  const f = await setup(t), original = f.bridge.snapshot();
  const broken = new AgentBridge(f.service, { ...codec, seal: () => { throw new Error("DPAPI unavailable"); } });
  assert.throws(() => broken.rotateToken("claude"), /DPAPI/); assert.deepEqual(broken.snapshot().config, original.config);
  fs.writeFileSync(path.join(f.service.storage, "agent-bridge.private.json"), "bad"); const reopened = new AgentBridge(f.service, codec); assert.ok(reopened.snapshot().error); await assert.rejects(reopened.start(), /私有存储/);
});
test("changing port while listening is rejected and stop keeps persisted tasks", async t => {
  const f = await setup(t); await f.bridge.start(); const c = f.bridge.snapshot().config; c.port = await freePort(); assert.throws(() => f.bridge.configure(c), /停止/);
  await f.bridge.send({ source: "claude", target: "trae", text: "keep" }); await f.bridge.stop(); assert.equal(f.bridge.snapshot().running, false); assert.equal(f.bridge.snapshot().tasks.length, 1);
});

test("slow requests cannot finish with a token revoked during upload", async t => {
  const f = await setup(t); await f.bridge.start(); const c = f.bridge.connection("claude");
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "SendMessage", params: { message: message("slow"), configuration: { returnImmediately: true } } });
  let connection!: http.ClientRequest;
  const result = new Promise<number>(resolve => { connection = http.request(c.url.replace("/mcp/claude", "/a2a/trae"), { method: "POST", headers: { Authorization: c.headers.Authorization, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), "A2A-Version": "1.0" } }, res => { res.resume(); resolve(res.statusCode!); }); connection.write(body.slice(0, 20)); });
  await new Promise(r => setTimeout(r, 30)); f.bridge.rotateToken("claude"); connection.end(body.slice(20)); assert.equal(await result, 401); assert.equal(f.bridge.snapshot().tasks.length, 0);
});
test("DNS deadline also bounds a resolution that never settles", async () => {
  const started = Date.now(); await assert.rejects(deadline(new Promise(() => {}), 25), /DNS/); assert.ok(Date.now() - started < 500);
  assert.equal(await deadline(Promise.resolve("resolved"), 1000), "resolved");
});
test("native immediate message may omit contextId and does not inherit a made-up remote context", async t => {
  const remote = await mockRemote(t, (body, res) => res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { message: { messageId: "immediate", role: "ROLE_AGENT", parts: [{ text: "done" }] } } })));
  const f = await setup(t); await register(f, remote.endpoint); const task = await f.bridge.send({ source: "claude", target: "remote.test", text: "hello" });
  assert.equal(task.state, "completed"); assert.equal(task.remoteContextId, undefined); assert.equal(remote.calls[0].params.message.contextId, undefined);
});
test("stopping ingress while a remote request is in flight retains its eventual response", async t => {
  let release!: () => void;
  const remote = await mockRemote(t, (body, res) => { release = () => res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { message: { messageId: "reply", role: "ROLE_AGENT", parts: [{ text: "later" }] } } })); });
  const f = await setup(t); await register(f, remote.endpoint); await f.bridge.start(); const sending = f.bridge.send({ source: "claude", target: "remote.test", text: "wait" });
  while (!release) await new Promise(r => setTimeout(r, 5)); assert.equal(f.bridge.snapshot().tasks[0].delivery, "unknown"); await f.bridge.stop(); release();
  assert.equal((await sending).state, "completed"); assert.equal(f.bridge.snapshot().running, false);
});
test("MCP tools do not expose private filesystem/OS error details", async t => {
  const f = await setup(t); await f.bridge.start(); const c = await client(f.bridge, "claude");
  const original = f.service.audit.bind(f.service); f.service.audit = () => { throw new Error("secret C:\\Private\\token.txt credential=hidden"); };
  const result = await c.call("bridge_message_send", { target: "trae", text: "x" }); f.service.audit = original;
  assert.equal(result.isError, true); assert.ok(!JSON.stringify(result).includes("Private")); assert.equal(f.bridge.snapshot().tasks.length, 0);
});

test("invalid send configuration is rejected before persistence and list timestamp/artifact controls apply", async t => {
  const f = await setup(t); await f.bridge.start();
  const bad = await a2a(f.bridge, "claude", "trae", "SendMessage", { message: message("bad-history"), configuration: { returnImmediately: true, historyLength: -1 } });
  assert.equal(bad.body.error.code, -32602); assert.equal(f.bridge.snapshot().tasks.length, 0);
  const task = await f.bridge.send({ source: "claude", target: "trae", text: "x" }); f.bridge.reply({ taskId: task.id, text: "answer", state: "completed" });
  const list = (await a2a(f.bridge, "claude", "trae", "ListTasks", {})).body.result; assert.equal(list.tasks[0].artifacts, undefined);
  assert.equal((await a2a(f.bridge, "claude", "trae", "ListTasks", { includeArtifacts: true })).body.result.tasks[0].artifacts[0].parts[0].text, "answer");
  assert.equal((await a2a(f.bridge, "claude", "trae", "ListTasks", { statusTimestampAfter: "2099-01-01T00:00:00Z" })).body.result.totalSize, 0);
});
test("continuation message IDs remain globally deduplicated for their authenticated source", async t => {
  const f = await setup(t); await f.bridge.start(); const initial = await f.bridge.send({ source: "claude", target: "trae", text: "first" });
  const more = await a2a(f.bridge, "claude", "trae", "SendMessage", { message: message("followup-id", { taskId: initial.id }), configuration: { returnImmediately: true } }); assert.equal(more.body.result.task.id, initial.id);
  const repeated = await f.bridge.send({ source: "claude", target: "trae", text: "hello-peer", messageId: "followup-id" }); assert.equal(repeated.id, initial.id); assert.equal(f.bridge.snapshot().tasks.length, 1);
});
test("HTTP rate limit and text bounds reject excess without adding tasks", async t => {
  const f = await setup(t); await f.bridge.start(); const c = f.bridge.connection("claude");
  await assert.rejects(f.bridge.send({ source: "claude", target: "trae", text: "x".repeat(16001) }), /过长/);
  const url = c.url.replace("/mcp/claude", "/a2a/trae/.well-known/agent-card.json"); let status = 200;
  for (let i = 0; i < 121; i++) status = (await request(url, c.headers.Authorization, undefined, {}, "GET")).status;
  assert.equal(status, 429); assert.equal(f.bridge.snapshot().tasks.length, 0);
});
