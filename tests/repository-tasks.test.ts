import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { RepositoryService } from "../electron/repository-service";
import { digest } from "../electron/safety";
import { fixture } from "./helpers";

const auto = { enabled: true, intervalSeconds: 30, cleanupEnabled: false, retentionDays: 30, minBackups: 20 };
const stateFile = (storage: string, root: string) => path.join(storage, "repository-data", digest(root).slice(0, 24), "state.json");

test("task status is read-only metadata and does not initialize Git or scan configured skills", t => {
  const f = fixture(t), repository = new RepositoryService(f.service);
  assert.equal(repository.taskStatus().configured, false);
  const root = f.dir("repository-without-git");
  f.service.config.repository = { root, agentIds: ["claude"], memoryFolders: {}, automation: { ...auto }, autoGrant: "unused" };
  f.service.config.agents.claude = { skills: path.join(f.root, "nonexistent-skills") };
  const now = Date.parse("2026-10-24T03:00:00.000Z"), status = repository.taskStatus(now);
  assert.equal(status.configured, true); assert.equal(status.issue, undefined); assert.equal(status.nextCheck, new Date(now).toISOString());
  assert.equal(fs.existsSync(path.join(root, ".git")), false); assert.equal(fs.existsSync(path.join(f.service.storage, "repository-data")), false);
});

test("older state messages do not become guessed structured failures", t => {
  const f = fixture(t), repository = new RepositoryService(f.service), root = f.dir("central");
  f.service.config.repository = { root, agentIds: [], memoryFolders: {}, automation: { ...auto, enabled: false } };
  const file = stateFile(f.service.storage, root); fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ version: 1, bases: {}, links: {}, lastRun: "2026-10-24T03:00:00.000Z", lastMessage: "自动同步遇到冲突，自动同步已暂停" }));
  const status = repository.taskStatus(); assert.equal(status.issue, undefined); assert.equal(status.lastRun, "2026-10-24T03:00:00.000Z"); assert.equal(status.nextCheck, undefined);
  fs.writeFileSync(file, JSON.stringify({ version: 1, bases: {}, links: {}, lastIssue: "invented" })); assert.equal(repository.taskStatus().issue, "error");
});

test("automatic grant changes have a persistent structural issue even when sync is disabled", async t => {
  const f = fixture(t), repository = new RepositoryService(f.service), root = f.dir("central");
  await repository.choose(root); repository.members(["claude"]); repository.automation({ ...auto });
  f.service.config.repository!.autoGrant = "changed";
  const now = Date.now() + 31000; await repository.tick(now); const status = repository.taskStatus(now);
  assert.equal(status.issue, "grant"); assert.equal(status.syncEnabled, false); assert.equal(status.lastRun, new Date(now).toISOString());
  assert.equal(new RepositoryService(f.service).taskStatus(now).issue, "grant");
});

test("automatic conflicts retain both sides and clear structural issue after an explicit successful merge", async t => {
  const f = fixture(t), repository = new RepositoryService(f.service), root = f.dir("central"), memory = f.file("agent/CLAUDE.md", "base\n");
  await repository.choose(root); repository.members(["claude"]); f.service.bind("claude", "memory", memory);
  await repository.apply((await repository.preview()).id);
  const remote = path.join(root, "memories", "claude", "CLAUDE.md"); fs.writeFileSync(memory, "local\n"); fs.writeFileSync(remote, "repository\n");
  repository.automation({ ...auto }); const now = Date.now() + 31000; await repository.tick(now);
  assert.equal(repository.taskStatus(now).issue, "conflict"); assert.equal(fs.readFileSync(memory, "utf8"), "local\n"); assert.equal(fs.readFileSync(remote, "utf8"), "repository\n");
  const plan = await repository.preview(); await repository.apply(plan.id, { [plan.files[0].key]: { choice: "manual", text: "resolved\n" } });
  assert.equal(repository.taskStatus(now).issue, undefined); assert.equal(fs.readFileSync(memory, "utf8"), "resolved\n");
});

test("active plans expose expiry and canceling removes only the preview pause", async t => {
  const f = fixture(t), repository = new RepositoryService(f.service), root = f.dir("central");
  await repository.choose(root); repository.members(["claude"]); repository.automation({ ...auto });
  const now = Date.now(), next = repository.taskStatus(now).nextCheck!; assert.ok(Date.parse(next) > now);
  const plan = await repository.preview(); assert.equal(repository.taskStatus(now).previewUntil, plan.expiresAt);
  assert.equal(repository.taskStatus(Date.parse(plan.expiresAt)).previewUntil, undefined);
  repository.cancelPreview(); assert.equal(repository.taskStatus(now).previewUntil, undefined); assert.equal(repository.taskStatus(now).nextCheck, next);
});

test("automatic execution errors are structured and persist across restart", async t => {
  const f = fixture(t), repository = new RepositoryService(f.service), root = f.dir("central");
  await repository.choose(root); repository.members(["claude"]); repository.automation({ ...auto });
  repository.preview = async () => { throw new Error("synthetic read failure"); };
  await repository.tick(Date.now() + 31000); const status = new RepositoryService(f.service).taskStatus();
  assert.equal(status.issue, "error"); assert.match(status.lastMessage!, /synthetic read failure/);
});

test("pausing during an in-flight synchronization lets it finish but prevents the subsequent cleanup", async t => {
  const f = fixture(t), repository = new RepositoryService(f.service), root = f.dir("central"), memory = f.file("agent/CLAUDE.md", "keep this memory\n");
  await repository.choose(root); repository.members(["claude"]); f.service.bind("claude", "memory", memory);
  repository.automation({ ...auto, cleanupEnabled: true });
  let allowNextTask = true, cleanups = 0, release!: () => void, began!: () => void;
  const started = new Promise<void>(resolve => { began = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const apply = repository.apply.bind(repository), cleanup = repository.cleanup.bind(repository);
  repository.apply = async (id, choices) => {
    const inFlight = apply(id, choices);
    began(); await held;
    return inFlight;
  };
  repository.cleanup = now => { cleanups++; return cleanup(now); };
  const now = Date.now() + 31000, tick = repository.tick(now, () => allowNextTask);
  await started; allowNextTask = false; release(); await tick;
  assert.equal(cleanups, 0, "a separate automatic cleanup must not start after global pause");
  assert.equal(fs.readFileSync(memory, "utf8"), "keep this memory\n");
  assert.equal(fs.readFileSync(path.join(root, "memories", "claude", "CLAUDE.md"), "utf8"), "keep this memory\n");
  assert.equal(repository.running, false); assert.equal(repository.taskStatus(now).issue, undefined);
  allowNextTask = true; await repository.tick(now + 31000, () => allowNextTask); assert.equal(cleanups, 1);
});

test("skipping cleanup due to total pause does not clear a saved conflict", async t => {
  const f = fixture(t), repository = new RepositoryService(f.service), root = f.dir("central");
  await repository.choose(root); repository.automation({ ...auto, enabled: false, cleanupEnabled: true });
  const file = stateFile(f.service.storage, root); fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ version: 1, bases: {}, links: {}, lastIssue: "conflict", lastMessage: "needs merge" }));
  let called = false; repository.cleanup = () => { called = true; return 0; };
  await repository.tick(Date.now() + 31000, () => false);
  assert.equal(called, false); assert.equal(repository.taskStatus().issue, "conflict");
});
