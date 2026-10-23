import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fixture } from "./helpers";
import { RepositoryService } from "../electron/repository-service";
import { digest } from "../electron/safety";
import type { RepositoryAutomation } from "../src/repository-types";

const auto = (changes: Partial<RepositoryAutomation> = {}): RepositoryAutomation => ({ enabled: true, intervalSeconds: 30, cleanupEnabled: false, retentionDays: 30, minBackups: 20, ...changes });
async function configured(t: TestContext) {
  const f = fixture(t), repository = new RepositoryService(f.service), root = f.dir("central");
  await repository.choose(root); repository.members(["claude"]);
  return { ...f, repository, repoRoot: root };
}
const read = (file: string) => fs.readFileSync(file, "utf8");
function backups(f: Awaited<ReturnType<typeof configured>>) {
  return path.join(f.service.storage, "repository-data", digest(f.repoRoot).slice(0, 24), "backups");
}

test("initialization creates an independent owned Git repository and refuses populated/protected paths", async t => {
  const f = fixture(t), repository = new RepositoryService(f.service);
  const occupied = f.file("occupied/user.txt", "keep");
  await assert.rejects(repository.choose(path.dirname(occupied)), /不是本应用管理/);
  assert.equal(read(occupied), "keep"); assert.equal(fs.existsSync(path.join(path.dirname(occupied), ".git")), false);
  await assert.rejects(repository.choose(f.dir("protected/repository")), /不能写入/);
  const memory = f.file("agent/CLAUDE.md", "memory"); f.service.bind("claude", "memory", memory);
  await assert.rejects(repository.choose(path.dirname(memory)), /独立/);
  const root = f.dir("central"); await repository.choose(root);
  const snapshot = await repository.snapshot();
  assert.equal(snapshot.git?.branch, "main"); assert.equal(snapshot.git?.dirty, 0); assert.equal(snapshot.history.length, 1);
  assert.equal(fs.existsSync(path.join(root, "skills")), true); assert.equal(fs.existsSync(path.join(root, "memories")), true);
  await repository.choose(root); assert.equal((await repository.snapshot()).history.length, 1);
});

test("central repository cannot hide inside an existing skill junction's actual tree", async t => {
  const f = fixture(t), repository = new RepositoryService(f.service), actual = f.dir("actual-skills");
  const alias = path.join(f.root, "skills-alias"); fs.symlinkSync(actual, alias, "junction"); f.service.bind("claude", "skills", alias);
  const proposed = path.join(actual, "central");
  await assert.rejects(repository.choose(proposed), /独立|重叠|嵌套/);
  assert.equal(fs.existsSync(path.join(proposed, ".git")), false);
});

test("rebinding a memory file into the repository cannot create a self-referential import", async t => {
  const f = await configured(t), inside = f.file("central/skills/review/SKILL.md", "keep");
  f.service.bind("claude", "memory", inside);
  await assert.rejects(f.repository.preview(), /独立|重叠|嵌套/);
  assert.equal(read(inside), "keep"); assert.equal(fs.existsSync(path.join(f.repoRoot, "memories/claude/SKILL.md")), false);
});

test("multi-file memories and complete skill bundles import to separate repository areas", async t => {
  const f = await configured(t), memories = f.dir("agent-memory"), skills = f.dir("agent-skills");
  f.file("agent-memory/CLAUDE.md", "root memory"); f.file("agent-memory/projects/context.md", "project memory");
  f.file("agent-memory/ignored.exe", Buffer.from([0, 1]));
  f.file("agent-skills/review/SKILL.md", "# review"); f.file("agent-skills/review/scripts/run.ps1", "Write-Error 'not executed'");
  f.file("agent-skills/review/assets/image.bin", Buffer.from([0, 1, 254]));
  f.file("agent-skills/review/dist/runtime.js", "// required bundled runtime");
  f.repository.memoryFolder("claude", memories); f.service.bind("claude", "skills", skills);
  const plan = await f.repository.preview(); assert.equal(plan.files.length, 6);
  assert.equal(plan.files.find(file => file.relative.endsWith("image.bin"))?.binary, true);
  assert.equal(await f.repository.apply(plan.id), 6);
  assert.equal(read(path.join(f.repoRoot, "memories/claude/projects/context.md")), "project memory");
  assert.equal(fs.existsSync(path.join(f.repoRoot, "memories/claude/ignored.exe")), false);
  assert.deepEqual(fs.readFileSync(path.join(f.repoRoot, "skills/review/assets/image.bin")), Buffer.from([0, 1, 254]));
  assert.equal(read(path.join(f.repoRoot, "skills/review/scripts/run.ps1")), "Write-Error 'not executed'");
  assert.equal(read(path.join(f.repoRoot, "skills/review/dist/runtime.js")), "// required bundled runtime");
  assert.equal((await f.repository.preview()).files.length, 0);
  const snapshot = await f.repository.snapshot(); assert.equal(snapshot.git?.dirty, 0); assert.ok(snapshot.history.length >= 2);
});

test("saved baseline merges nonoverlapping local and repository memory edits", async t => {
  const f = await configured(t), local = f.file("agent/CLAUDE.md", "one\ntwo\nthree\nfour\n");
  f.service.bind("claude", "memory", local); await f.repository.apply((await f.repository.preview()).id);
  const remote = path.join(f.repoRoot, "memories/claude/CLAUDE.md");
  fs.writeFileSync(local, "LOCAL\ntwo\nthree\nfour\n"); fs.writeFileSync(remote, "one\ntwo\nthree\nREPO\n");
  const plan = await f.repository.preview(); assert.equal(plan.files.length, 1); assert.equal(plan.files[0].conflict, false);
  assert.equal(plan.files[0].baseText, "one\ntwo\nthree\nfour\n");
  await f.repository.apply(plan.id);
  assert.equal(read(local), "LOCAL\ntwo\nthree\nREPO\n"); assert.equal(read(remote), read(local));
});

test("conflicts never auto-write and explicit manual resolution establishes a new baseline", async t => {
  const f = await configured(t), local = f.file("agent/CLAUDE.md", "base\n");
  f.service.bind("claude", "memory", local); await f.repository.apply((await f.repository.preview()).id);
  const remote = path.join(f.repoRoot, "memories/claude/CLAUDE.md");
  fs.writeFileSync(local, "local\n"); fs.writeFileSync(remote, "repository\n");
  const conflict = await f.repository.preview(); assert.equal(conflict.files[0].conflict, true);
  await assert.rejects(f.repository.apply(conflict.id), /未解决/);
  assert.equal(read(local), "local\n"); assert.equal(read(remote), "repository\n");
  f.repository.automation(auto()); await f.repository.tick(Date.now() + 31_000);
  assert.match((await f.repository.snapshot()).lastMessage!, /冲突/);
  assert.equal(read(local), "local\n"); assert.equal(read(remote), "repository\n");
  const plan = await f.repository.preview();
  await f.repository.apply(plan.id, { [plan.files[0].key]: { choice: "manual", text: "resolved\n" } });
  assert.equal(read(local), "resolved\n"); assert.equal(read(remote), "resolved\n");
});

test("deletion on either side restores preserved content instead of propagating removal", async t => {
  const f = await configured(t), local = f.file("agent/CLAUDE.md", "keep\n");
  f.service.bind("claude", "memory", local); await f.repository.apply((await f.repository.preview()).id);
  const remote = path.join(f.repoRoot, "memories/claude/CLAUDE.md");
  fs.unlinkSync(local); let plan = await f.repository.preview(); assert.match(plan.files[0].description, /不传播删除/);
  await f.repository.apply(plan.id); assert.equal(read(local), "keep\n");
  fs.unlinkSync(remote); plan = await f.repository.preview(); await f.repository.apply(plan.id);
  assert.equal(read(remote), "keep\n"); assert.equal(read(local), "keep\n");
});

test("changed files and changed member scopes invalidate previews before writes", async t => {
  const f = await configured(t), local = f.file("agent/CLAUDE.md", "first"); f.service.bind("claude", "memory", local);
  let plan = await f.repository.preview(); fs.writeFileSync(local, "changed");
  await assert.rejects(f.repository.apply(plan.id), /变化/);
  assert.equal(fs.existsSync(path.join(f.repoRoot, "memories/claude/CLAUDE.md")), false);
  plan = await f.repository.preview(); f.repository.members([]);
  await assert.rejects(f.repository.apply(plan.id), /过期|授权/);
  assert.equal(fs.existsSync(path.join(f.repoRoot, "memories/claude/CLAUDE.md")), false);
});

test("an approved skill junction retargeted to identical bytes is refused", async t => {
  const f = await configured(t), skills = f.dir("skills"), a = f.dir("first"), b = f.dir("second");
  f.file("first/SKILL.md", "same"); f.file("second/SKILL.md", "same");
  const link = path.join(skills, "review"); fs.symlinkSync(a, link, "junction"); f.service.bind("claude", "skills", skills);
  const plan = await f.repository.preview(); fs.unlinkSync(link); fs.symlinkSync(b, link, "junction");
  await assert.rejects(f.repository.apply(plan.id), /链接|变化|授权/);
  assert.equal(fs.existsSync(path.join(f.repoRoot, "skills/review/SKILL.md")), false);
});

test("scope changes while Git checkpoint is pending revoke the in-flight write plan", async t => {
  const f = await configured(t), local = f.file("agent/CLAUDE.md", "pending sync"); f.service.bind("claude", "memory", local);
  const plan = await f.repository.preview();
  const pending = f.repository.apply(plan.id);
  f.repository.members([]);
  await assert.rejects(pending, /授权|范围|选择|变化|过期/);
  assert.equal(fs.existsSync(path.join(f.repoRoot, "memories/claude/CLAUDE.md")), false);
  assert.equal(read(local), "pending sync");
});

test("replacing an approved junction with a plain folder invalidates the physical write plan", async t => {
  const f = await configured(t), skills = f.dir("skills"), actual = f.dir("library"); f.file("library/SKILL.md", "same");
  const link = path.join(skills, "review"); fs.symlinkSync(actual, link, "junction"); f.service.bind("claude", "skills", skills);
  const plan = await f.repository.preview(); fs.unlinkSync(link); fs.mkdirSync(link); fs.writeFileSync(path.join(link, "SKILL.md"), "same");
  await assert.rejects(f.repository.apply(plan.id), /链接|变化|授权/);
  assert.equal(fs.existsSync(path.join(f.repoRoot, "skills/review/SKILL.md")), false);
});

test("automatic sync operates only selected agents and stops after authorization changes", async t => {
  const f = await configured(t); const claude = f.file("claude/CLAUDE.md", "selected"), trae = f.file("trae/memory.md", "unselected");
  f.service.bind("claude", "memory", claude); f.service.bind("trae", "memory", trae); f.repository.automation(auto());
  const now = Date.now() + 31_000; await f.repository.tick(now);
  assert.equal(read(path.join(f.repoRoot, "memories/claude/CLAUDE.md")), "selected");
  assert.equal(fs.existsSync(path.join(f.repoRoot, "memories/trae/memory.md")), false);
  fs.writeFileSync(claude, "changed while disabled"); f.repository.automation(auto({ enabled: false })); await f.repository.tick(now + 31_000);
  assert.equal(read(path.join(f.repoRoot, "memories/claude/CLAUDE.md")), "selected");
  f.repository.automation(auto()); f.service.clear("claude", "memory"); await f.repository.tick(now + 62_000);
  const snapshot = await f.repository.snapshot(); assert.equal(snapshot.automation.enabled, false); assert.match(snapshot.lastMessage!, /授权范围已变化/);
  assert.equal(read(path.join(f.repoRoot, "memories/claude/CLAUDE.md")), "selected");
});

test("choosing a new member set disables the existing automatic grant", async t => {
  const f = await configured(t); f.service.bind("claude", "memory", f.file("claude/CLAUDE.md", "one"));
  f.repository.automation(auto()); assert.equal(f.service.config.repository?.automation.enabled, true);
  f.repository.members(["claude", "trae"]);
  assert.equal(f.service.config.repository?.automation.enabled, false); assert.equal(f.service.config.repository?.autoGrant, undefined);
  assert.throws(() => f.repository.automation(auto({ intervalSeconds: 0 })), /参数无效/);
});

test("cleanup removes only old completed owned backups and retains minimum recent snapshots", async t => {
  const f = await configured(t), local = f.file("agent/CLAUDE.md", "one"); f.service.bind("claude", "memory", local);
  for (const content of ["one", "two", "three", "four"]) { fs.writeFileSync(local, content); await f.repository.apply((await f.repository.preview()).id); }
  const folder = backups(f), names = fs.readdirSync(folder), now = Date.now(); assert.equal(names.length, 4);
  names.forEach((name, i) => {
    const file = path.join(folder, name, "manifest.json"), data = JSON.parse(read(file)); data.at = new Date(now - (40 + i) * 86400000).toISOString();
    fs.writeFileSync(file, JSON.stringify(data));
  });
  const incomplete = names[2], extra = names[3];
  const incompleteFile = path.join(folder, incomplete, "manifest.json"), incompleteData = JSON.parse(read(incompleteFile));
  incompleteData.completed = false; fs.writeFileSync(incompleteFile, JSON.stringify(incompleteData));
  fs.writeFileSync(path.join(folder, extra, "unrecognized-user-file.txt"), "preserve");
  const original = f.dir(`agent/skills.agent-console-original-${crypto.randomUUID()}`); f.file(path.relative(f.root, path.join(original, "SKILL.md")), "original");
  const stranger = path.join(folder, crypto.randomUUID()); fs.mkdirSync(stranger);
  fs.writeFileSync(path.join(stranger, "manifest.json"), JSON.stringify({ version: 1, id: path.basename(stranger), root: f.dir("other-repository"), at: new Date(0).toISOString(), completed: true, files: [] }));
  f.repository.automation(auto({ enabled: false, cleanupEnabled: true, minBackups: 1 }));
  assert.equal(f.repository.cleanup(now), 1);
  assert.equal(fs.existsSync(path.join(folder, names[0])), true); assert.equal(fs.existsSync(path.join(folder, names[1])), false);
  assert.equal(fs.existsSync(path.join(folder, incomplete)), true); assert.equal(fs.existsSync(path.join(folder, extra)), true);
  assert.equal(fs.existsSync(stranger), true); assert.equal(read(path.join(original, "SKILL.md")), "original");
});

test("temporary cleanup is restricted to old managed files inside repository-data", async t => {
  const f = await configured(t), area = path.dirname(backups(f)), now = Date.now();
  const old = new Date(now - 48 * 60 * 60 * 1000), name = `.agent-console-${crypto.randomUUID()}.tmp`;
  const writeTemp = (folder: string, filename: string, age: Date) => {
    fs.mkdirSync(folder, { recursive: true }); const target = path.join(folder, filename); fs.writeFileSync(target, "preserve unless managed and old"); fs.utimesSync(target, age, age); return target;
  };
  const internal = writeTemp(area, name, old), oldBase = writeTemp(path.join(area, "bases"), `.agent-console-${crypto.randomUUID()}.tmp`, old);
  const recent = writeTemp(area, `.agent-console-${crypto.randomUUID()}.tmp`, new Date(now));
  const unrecognized = writeTemp(area, "user-important.tmp", old);
  const inRepository = writeTemp(f.repoRoot, name, old), inAgent = writeTemp(f.dir("agent-skills"), name, old);
  const original = writeTemp(f.dir(`agent-skills.agent-console-original-${crypto.randomUUID()}`), name, old);
  assert.equal(f.repository.cleanup(now), 0);
  assert.equal(fs.existsSync(internal), false); assert.equal(fs.existsSync(oldBase), false);
  for (const target of [recent, unrecognized, inRepository, inAgent, original]) assert.equal(fs.existsSync(target), true);
});

test("junction orchestration preserves broken original branches and can restore original entry", async t => {
  const f = await configured(t), skills = f.dir("agent-skills"); f.file("agent-skills/review/SKILL.md", "review");
  f.file("agent-skills/review/script.py", "raise Exception('not executed')");
  fs.symlinkSync(path.join(f.root, "absent"), path.join(skills, "broken"), "junction");
  // Existing installations can carry a legacy plain-root grant with a broken descendant.
  f.service.config.agents.claude = { skills }; f.service.persistRepository();
  const plan = f.repository.linkPreview("claude"); assert.equal(plan.warnings.length, 1);
  await f.repository.linkApply(plan.id, {});
  assert.equal(fs.realpathSync(skills), fs.realpathSync(path.join(f.repoRoot, "skills")));
  assert.equal(fs.lstatSync(path.join(plan.backupPath, "broken")).isSymbolicLink(), true);
  assert.equal(read(path.join(f.repoRoot, "skills/review/script.py")), "raise Exception('not executed')");
  assert.equal((await f.repository.snapshot()).members.find(member => member.id === "claude")?.originalBackup, plan.backupPath);
  assert.equal(f.service.settings("claude").skillsAccess?.realRoot, path.join(f.repoRoot, "skills"));
  await f.repository.unlink("claude");
  assert.equal(fs.lstatSync(skills).isDirectory(), true); assert.equal(fs.lstatSync(path.join(skills, "broken")).isSymbolicLink(), true);
  assert.equal(f.service.settings("claude").skillsAccess, undefined); assert.equal(fs.existsSync(path.join(f.repoRoot, "skills/review/SKILL.md")), true);
  assert.throws(() => f.repository.unlinkReview("claude"), /没有可恢复/);
});

test("a post-link Git failure retains a durable receipt and supports restoring the original directory", async t => {
  const f = await configured(t), skills = f.dir("agent-skills"); f.file("agent-skills/review/SKILL.md", "review");
  f.service.bind("claude", "skills", skills);
  const plan = f.repository.linkPreview("claude"), bind = f.service.bindSkills.bind(f.service);
  const invalidAlternate = path.join(f.repoRoot, ".git/objects/info/alternates");
  f.service.bindSkills = (id, access) => {
    bind(id, access);
    // Simulate a repository becoming invalid between linking and the final Git checkpoint.
    fs.mkdirSync(path.dirname(invalidAlternate), { recursive: true }); fs.writeFileSync(invalidAlternate, "invalid-external-object-store");
  };
  try { await assert.rejects(f.repository.linkApply(plan.id, {}), /连接已创建.*原目录保留/); }
  finally { f.service.bindSkills = bind; if (fs.existsSync(invalidAlternate)) fs.unlinkSync(invalidAlternate); }
  assert.equal(fs.lstatSync(skills).isSymbolicLink(), true); assert.equal(fs.existsSync(plan.backupPath), true);
  const reloaded = new RepositoryService(f.service);
  assert.equal(reloaded.unlinkReview("claude").backupPath, plan.backupPath);
  await reloaded.unlink("claude");
  assert.equal(fs.lstatSync(skills).isDirectory(), true); assert.equal(read(path.join(skills, "review/SKILL.md")), "review");
  assert.equal(read(path.join(f.repoRoot, "skills/review/SKILL.md")), "review");
});

test("multi-agent skill collisions require a common selected result", async t => {
  const f = await configured(t), one = f.dir("one"), two = f.dir("two"); f.file("one/review/SKILL.md", "first"); f.file("two/review/SKILL.md", "second");
  f.service.bind("claude", "skills", one); f.service.bind("trae", "skills", two); f.repository.members(["claude", "trae"]);
  let plan = await f.repository.preview(); assert.equal(plan.files.filter(file => file.conflict).length, 2);
  await assert.rejects(f.repository.apply(plan.id, Object.fromEntries(plan.files.map(file => [file.key, { choice: "agent" }]))), /同一个实际文件|统一冲突/);
  assert.equal(read(path.join(one, "review/SKILL.md")), "first"); assert.equal(read(path.join(two, "review/SKILL.md")), "second");
  plan = await f.repository.preview();
  await f.repository.apply(plan.id, Object.fromEntries(plan.files.map(file => [file.key, { choice: "manual", text: "combined" }])));
  assert.equal(read(path.join(one, "review/SKILL.md")), "combined"); assert.equal(read(path.join(two, "review/SKILL.md")), "combined");
  assert.equal(read(path.join(f.repoRoot, "skills/review/SKILL.md")), "combined");
});

test("approved aliases into Git internals are never imported as ordinary skill assets", async t => {
  const f = await configured(t), skills = f.dir("skills"), hiddenGit = f.dir("other/.git"); f.file("other/.git/config", "private Git configuration");
  fs.symlinkSync(hiddenGit, path.join(skills, "innocent-name"), "junction"); f.service.bind("claude", "skills", skills);
  await assert.rejects(f.repository.preview(), /\.git|Git/);
  assert.deepEqual(fs.readdirSync(path.join(f.repoRoot, "skills")), []);
});
