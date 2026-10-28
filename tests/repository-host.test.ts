import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RepositoryHost } from "../electron/repository-host";
import { ConsoleService } from "../electron/service";
import { createAdapters } from "../electron/adapters";

const auto = { enabled: true, intervalSeconds: 30, cleanupEnabled: false, retentionDays: 30, minBackups: 20 };

function workerFixture(t: TestContext, bootstrap?: (root: string) => string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-console-worker-test-"));
  const file = (relative: string, value = "base\n") => {
    const target = path.join(root, relative); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, value); return target;
  };
  const dir = (relative: string) => { const target = path.join(root, relative); fs.mkdirSync(target, { recursive: true }); return target; };
  const service = new ConsoleService(path.join(root, "storage"), createAdapters(path.join(root, "home"), path.join(root, "local")), [path.join(root, "protected")]);
  const source = path.resolve(__dirname, "../electron/repository-worker.ts");
  const entry = file("worker-bootstrap.cjs", bootstrap?.(root) || `require(${JSON.stringify(require.resolve("tsx/cjs"))}); require(${JSON.stringify(source)});`);
  const host = new RepositoryHost(service, entry);
  // On Windows the worker must release handles before removing its fixture tree.
  t.after(async () => { await host.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, file, dir, service, host };
}

async function memoryFixture(t: TestContext) {
  const f = workerFixture(t), memory = f.file("agent/CLAUDE.md"), central = f.dir("central");
  f.service.bind("claude", "memory", memory);
  await f.host.choose(central); await f.host.members(["claude"]);
  await f.host.apply((await f.host.preview()).id, {});
  return { ...f, memory, central, remote: path.join(central, "memories/claude/CLAUDE.md") };
}

test("real repository worker keeps the main event loop responsive through bulk preview and apply", async t => {
  const f = workerFixture(t), central = f.dir("central"), count = 100;
  for (let i = 0; i < count; i++) f.file(`skills/demo/file-${i.toString().padStart(4, "0")}.md`, `skill ${i}\n`);
  f.service.bind("claude", "skills", f.dir("skills"));
  await f.host.choose(central); await f.host.members(["claude"]);
  assert.equal(f.service.config.repository?.root, central);
  assert.deepEqual(f.service.config.repository?.agentIds, ["claude"]);
  let ticks = 0, last = Date.now(), maxGap = 0;
  const timer = setInterval(() => { const now = Date.now(); maxGap = Math.max(maxGap, now - last); last = now; ticks++; }, 10);
  try {
    const plan = await f.host.preview(), previewTicks = ticks;
    assert.equal(plan.files.length, count);
    assert.ok(previewTicks >= 5, `preview main-thread ticks: ${previewTicks}`);
    assert.equal((await f.host.review(plan.id)).id, plan.id, "the same worker preserves plans between IPC calls");
    assert.equal(await f.host.apply(plan.id, {}), count);
    assert.ok(ticks - previewTicks >= 5, `apply main-thread ticks: ${ticks - previewTicks}`);
    assert.ok(maxGap < 2000, `main-thread heartbeat stalled for ${maxGap} ms`);
    assert.equal(f.host.progress()?.state, "completed");
    assert.equal(fs.readFileSync(path.join(central, "skills/demo/file-0099.md"), "utf8"), "skill 99\n");
    t.diagnostic(`100-file preview/apply: ${ticks} main-thread heartbeats; longest interval ${maxGap} ms`);
  } finally { clearInterval(timer); }
});

test("worker plans reject main-thread authorization changes and refresh grants on the next operation", async t => {
  const f = await memoryFixture(t);
  fs.writeFileSync(f.memory, "pending\n");
  const plan = await f.host.preview();
  const replacement = f.file("replacement/CLAUDE.md", "replacement\n");
  f.service.bind("claude", "memory", replacement);
  await assert.rejects(f.host.apply(plan.id, {}), /授权变化|授权|过期/);
  assert.equal(fs.readFileSync(f.remote, "utf8"), "base\n");
  const updated = await f.host.preview();
  assert.ok(updated.files.every(file => file.agentPath === replacement));
  assert.ok(updated.files.some(file => file.localText === "replacement\n"));
});

test("main and worker activity share one ordered audit writer while synchronization runs", async t => {
  const f = await memoryFixture(t), original = f.service.audit.bind(f.service), calls: string[] = [];
  f.service.audit = (action, detail) => {
    // Synchronize on the actual worker audit request, not filesystem speed or a 75 ms timer.
    if (action === "repository.sync") { calls.push("main.during"); original("main.during", "main activity while worker awaits audit acknowledgement"); }
    calls.push(action); original(action, detail);
  };
  fs.writeFileSync(f.memory, "updated\n");
  const plan = await f.host.preview();
  const operation = f.host.apply(plan.id, {});
  f.service.audit("main.before", "main thread remains available");
  await operation;
  f.service.audit("main.after", "completed");
  const audit = f.service.verifyAudit();
  assert.equal(audit.valid, true, audit.error);
  assert.ok(calls.includes("repository.sync"), "the worker delegates its audit record to the main service");
  assert.ok(calls.includes("main.during"), "main-thread activity interleaves with worker work");
  assert.ok(audit.rows.some(row => row.action === "main.before"));
  assert.ok(audit.rows.some(row => row.action === "main.after"));
  assert.deepEqual(audit.rows.map(row => row.seq), audit.rows.map((_, i) => i + 1));
});

test("a main audit failure reaches the worker and rolls back both existing versions before rejecting apply", async t => {
  const f = await memoryFixture(t);
  fs.writeFileSync(f.memory, "local branch\n"); fs.writeFileSync(f.remote, "repository branch\n");
  const plan = await f.host.preview(); assert.equal(plan.files[0].conflict, true);
  const original = f.service.audit.bind(f.service);
  f.service.audit = (action, detail) => { if (action === "repository.sync") throw new Error("injected main audit failure"); original(action, detail); };
  await assert.rejects(f.host.apply(plan.id, { [plan.files[0].key]: { choice: "manual", text: "merged result\n" } }), /injected main audit failure/);
  assert.equal(fs.readFileSync(f.memory, "utf8"), "local branch\n");
  assert.equal(fs.readFileSync(f.remote, "utf8"), "repository branch\n");
  assert.equal(f.host.progress()?.state, "failed");
  const audit = f.service.verifyAudit(); assert.equal(audit.valid, true, audit.error);
  assert.ok(audit.rows.some(row => row.action === "repository.sync-failed" && row.detail.includes("2/2")), "the worker executes the original rollback path before the host rejects");
});

test("an automatic tick queued before pause cannot begin when it reaches the worker", async t => {
  const f = await memoryFixture(t); await f.host.automation({ ...auto });
  fs.writeFileSync(f.memory, "pending automatic update\n");
  const lastRun = f.host.taskStatus().lastRun;
  let allowed = true, decisions = 0;
  const checkpoint = f.host.commit();
  const scheduled = f.host.tick(Date.now() + 31000, () => { decisions++; return allowed; });
  allowed = false;
  await Promise.all([checkpoint, scheduled]);
  assert.equal(decisions, 2, "pause state is checked both at enqueue and at actual worker execution");
  assert.equal(fs.readFileSync(f.remote, "utf8"), "base\n");
  assert.equal(f.host.taskStatus().lastRun, lastRun);
});

test("automatic conflicts remain failed progress and preserve both file versions", async t => {
  const f = await memoryFixture(t);
  fs.writeFileSync(f.memory, "local conflict\n"); fs.writeFileSync(f.remote, "repository conflict\n");
  await f.host.automation({ ...auto }); await f.host.tick(Date.now() + 31000, () => true);
  assert.equal(f.host.taskStatus().issue, "conflict");
  assert.equal(f.host.progress()?.state, "failed");
  assert.match(f.host.progress()?.message || "", /冲突/);
  assert.equal(fs.readFileSync(f.memory, "utf8"), "local conflict\n");
  assert.equal(fs.readFileSync(f.remote, "utf8"), "repository conflict\n");
});

test("an ambiguous worker exit rejects the write once and all later operations fail closed", async t => {
  const f = workerFixture(t, root => `const { parentPort } = require('node:worker_threads');
const fs = require('node:fs');
parentPort.on('message', request => {
  if (request.method === 'apply') { fs.appendFileSync(${JSON.stringify(path.join(root, "write-attempts.txt"))}, 'attempt\\n'); process.exit(43); }
});`);
  const operation = f.host.apply("controlled-crash", {});
  await assert.rejects(operation, /后台线程已退出.*43/);
  assert.equal(f.host.progress()?.state, "failed");
  await assert.rejects(f.host.apply("controlled-crash", {}), /后台线程已退出/);
  await assert.rejects(f.host.preview(), /后台线程已退出/);
  assert.equal(fs.readFileSync(path.join(f.root, "write-attempts.txt"), "utf8"), "attempt\n", "the side-effecting request is never retried after losing its result");
  assert.match((await f.host.snapshot()).error || "", /后台线程已退出/);
});

test("a worker exit after persisting config closes the main mutation gate and preserves the newer disk config", async t => {
  const f = workerFixture(t, root => `const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs'); const path = require('node:path');
parentPort.on('message', request => {
  if (request.method !== 'choose') return;
  const config = request.config;
  config.repository = {root: request.args[0], agentIds: ['claude'], memoryFolders: {}, automation: {enabled: false, cleanupEnabled: false, intervalSeconds: 60, retentionDays: 30, minBackups: 20}};
  config.agents.claude = {memory: ${JSON.stringify(path.join(root, "persisted-after-worker-mutation.md"))}};
  fs.writeFileSync(path.join(workerData.storage, 'config.json'), JSON.stringify(config));
  process.exit(44);
});`);
  f.service.bind("claude", "memory", f.file("original/CLAUDE.md"));
  const original = JSON.stringify(f.service.config), central = f.dir("central");
  assert.equal(f.host.healthy, true); assert.doesNotThrow(() => f.host.assertHealthy());
  await assert.rejects(f.host.choose(central), /后台线程已退出.*44/);
  assert.equal(f.host.healthy, false);
  assert.equal(JSON.stringify(f.service.config), original, "the lost worker reply leaves the main config stale");
  const file = path.join(f.service.storage, "config.json"), persisted = fs.readFileSync(file, "utf8");
  assert.equal(JSON.parse(persisted).repository.root, central);
  assert.match(JSON.parse(persisted).agents.claude.memory, /persisted-after-worker-mutation\.md$/);
  assert.throws(() => { f.host.assertHealthy(); f.service.persistRepository(); }, /后台线程不可用|后台线程已退出/);
  assert.equal(fs.readFileSync(file, "utf8"), persisted, "a main mutation must not overwrite the newer disk config with its stale in-memory copy");
});

test("disabled automation does not queue a tick behind an outstanding console snapshot or report sync running", async t => {
  const f = workerFixture(t, root => `const { parentPort } = require('node:worker_threads'); const fs = require('node:fs');
parentPort.on('message', request => { fs.appendFileSync(${JSON.stringify(path.join(root, "received-methods.txt"))}, request.method + '\\n'); });`);
  f.service.config.repository = { root: f.dir("central"), agentIds: [], memoryFolders: {}, automation: { ...auto, enabled: false, cleanupEnabled: false } };
  const held = f.host.consoleSnapshot().then(() => undefined, error => error as Error);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const received = path.join(f.root, "received-methods.txt"), deadline = Date.now() + 5000;
    while (!fs.existsSync(received) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(fs.readFileSync(received, "utf8"), "consoleSnapshot\n");
    assert.equal(f.host.backgroundBusy, true);
    assert.equal(f.host.running, false);
    const completed = await Promise.race([
      f.host.tick(Date.now() + 31000, () => true).then(() => true),
      new Promise<boolean>(resolve => { timeout = setTimeout(() => resolve(false), 1000); }),
    ]);
    assert.equal(completed, true, "a disabled tick must return without waiting for the unrelated snapshot");
    assert.equal(f.host.running, false);
    assert.equal(fs.readFileSync(received, "utf8"), "consoleSnapshot\n");
  } finally {
    if (timeout) clearTimeout(timeout);
    await f.host.dispose(); await held;
  }
});

test("main config changes invalidate the repository snapshot cache even within its fifteen-second lifetime", async t => {
  const f = await memoryFixture(t);
  // Freeze only the host clock so both snapshots necessarily fall inside the
  // same cache lifetime even on slow CI machines. The real worker remains live.
  const now = Date.now(); t.mock.method(Date, "now", () => now);
  const before = await f.host.snapshot(false);
  assert.equal(before.members.find(member => member.id === "claude")?.memoryPath, f.memory);
  const replacement = f.file("replacement/CLAUDE.md", "new authorization\n");
  f.service.bind("claude", "memory", replacement);
  const after = await f.host.snapshot(false);
  assert.equal(after.members.find(member => member.id === "claude")?.memoryPath, replacement);
  assert.equal(after.root, f.central);
});

test("default snapshot immediately detects external repository files while readonly polling may reuse its cache", async t => {
  const f = await memoryFixture(t);
  const now = Date.now(); t.mock.method(Date, "now", () => now);
  const before = await f.host.snapshot(false);
  assert.equal(before.git?.dirty, 0);
  for (let i = 0; i < 4; i++) f.file(`central/skills/external/file-${i}.md`, `external change ${i}\n`);
  const polled = await f.host.snapshot(false);
  assert.equal(polled.git?.dirty, 0, "readonly UI polling can reuse its fifteen-second cache");
  const refreshed = await f.host.snapshot();
  assert.equal(refreshed.git?.dirty, 4, "default/manual refresh must immediately inspect the real repository");
  assert.equal((await f.host.snapshot(false)).git?.dirty, 4, "polling reuses the newly refreshed snapshot");
});
