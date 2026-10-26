import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { RepositoryService, type RepositoryProgress } from "../electron/repository-service";
import { fixture } from "./helpers";

async function sharedFiles(t: TestContext, count: number, onProgress?: (progress: RepositoryProgress) => void) {
  const f = fixture(t), repository = new RepositoryService(f.service, onProgress), central = f.dir("central");
  for (let i = 0; i < count; i++) {
    for (const agent of ["claude", "trae"] as const) f.file(`${agent}/demo/file-${i.toString().padStart(4, "0")}.md`, "shared contents\n");
  }
  for (const agent of ["claude", "trae"] as const) f.service.bind(agent, "skills", f.dir(agent));
  await repository.choose(central); repository.members(["claude", "trae"]);
  return { ...f, repository, central };
}

test("shared repository files are scanned/read once per preview and identical baselines are written/read once", async t => {
  let comparing = false;
  const f = await sharedFiles(t, 40, progress => {
    if (progress.phase === "检查仓库") comparing = false;
    if (progress.phase === "扫描目录") comparing = true;
  });
  let baselineWrites = 0;
  const originalRename = fs.renameSync;
  t.mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
    if (String(to).includes(`${path.sep}bases${path.sep}`) && String(to).endsWith(".bin")) baselineWrites++;
    return originalRename(from, to);
  });
  const initial = await f.repository.preview();
  assert.equal(initial.files.length, 80);
  assert.equal(await f.repository.apply(initial.id), 40);
  assert.equal(baselineWrites, 1, "80 Agent/file baselines share a single immutable blob write");

  const skills = path.join(f.central, "skills"), repositoryOpens = new Map<string, number>();
  let repositoryScans = 0, baselineReads = 0;
  const originalOpen = fs.openSync, originalDirectory = fs.opendirSync;
  t.mock.method(fs, "openSync", (file: fs.PathLike, flags: string | number, mode?: fs.Mode) => {
    const name = String(file);
    if (comparing && name.startsWith(skills + path.sep) && name.endsWith(".md")) repositoryOpens.set(name, (repositoryOpens.get(name) || 0) + 1);
    if (name.includes(`${path.sep}bases${path.sep}`) && name.endsWith(".bin")) baselineReads++;
    return originalOpen(file, flags, mode);
  });
  t.mock.method(fs, "opendirSync", (...args: Parameters<typeof fs.opendirSync>) => {
    if (comparing && String(args[0]) === skills) repositoryScans++;
    return originalDirectory(...args);
  });
  assert.equal((await f.repository.preview()).files.length, 0);
  assert.equal(repositoryScans, 1, "the central skill inventory is reused across selected Agents");
  assert.equal(repositoryOpens.size, 40);
  assert.ok([...repositoryOpens.values()].every(count => count === 1), "each central file is opened once, rather than once per Agent");
  assert.equal(baselineReads, 1, "the common baseline blob is read once rather than 80 times");
});

test("preview content caches expire between operations and changed targets still invalidate the plan", async t => {
  const f = await sharedFiles(t, 2);
  await f.repository.apply((await f.repository.preview()).id);
  const first = await f.repository.preview(), target = path.join(f.central, "skills/demo/file-0000.md");
  fs.writeFileSync(target, "external edit\n");
  await assert.rejects(f.repository.apply(first.id), /预览后文件/);
  const next = await f.repository.preview();
  assert.equal(next.files.length, 2);
  assert.ok(next.files.every(file => file.repositoryText === "external edit\n"));
  await f.repository.apply(next.id);
  assert.equal(fs.readFileSync(path.join(f.root, "claude/demo/file-0000.md"), "utf8"), "external edit\n");
});

test("multi-file preview/apply reports bounded progress through backup, write and baseline completion", async t => {
  const events: (RepositoryProgress & { at: number })[] = [];
  const originalNow = Date.now; let clockRead = originalNow();
  // Capture the clock value used to emit each event. Recording another clock
  // read inside the callback could include unrelated OS scheduling latency.
  t.mock.method(Date, "now", () => { clockRead = originalNow(); return clockRead; });
  const f = await sharedFiles(t, 100, progress => events.push({ ...progress, at: clockRead }));
  const plan = await f.repository.preview();
  assert.equal(plan.files.length, 200);
  await f.repository.apply(plan.id);
  const phases = new Set(events.map(event => event.phase));
  for (const phase of ["检查仓库", "扫描目录", "比对文件", "汇总共享技能", "预览完成", "执行前校验", "保存同步前 Git 记录", "再次校验文件", "备份原文件", "写入文件", "保存同步后 Git 记录", "保存同步基线", "同步完成"]) assert.ok(phases.has(phase), phase);
  for (const phase of ["预览完成", "执行前校验", "再次校验文件", "保存同步基线"]) assert.ok(events.some(event => event.phase === phase && event.completed === 200 && event.total === 200), phase);
  for (const phase of ["备份原文件", "写入文件", "同步完成"]) assert.ok(events.some(event => event.phase === phase && event.completed === 100 && event.total === 100), phase);
  for (let i = 1; i < events.length; i++) {
    const previous = events[i - 1], current = events[i];
    // Stage transitions and completed totals are deliberately emitted at once.
    // Slow file I/O may legitimately produce one event per file, so validate
    // the interval rather than impose a hardware-dependent event count.
    if (current.phase === previous.phase && current.completed !== current.total) {
      assert.ok(current.at - previous.at >= 75, `${current.phase} progress repeated after ${current.at - previous.at} ms`);
    }
  }
  assert.equal((await f.repository.preview()).files.length, 0);
});

test("an observer throwing does not interrupt synchronization", async t => {
  const f = await sharedFiles(t, 3, () => { throw new Error("unavailable UI observer"); });
  assert.equal(await f.repository.apply((await f.repository.preview()).id), 3);
  assert.equal((await f.repository.preview()).files.length, 0);
});

test("write failures preserve complete before-images and report rollback progress", async t => {
  const events: RepositoryProgress[] = [], f = await sharedFiles(t, 3, progress => events.push(progress));
  const plan = await f.repository.preview(), failTarget = path.join(f.central, "skills/demo/file-0001.md");
  let rejected = false;
  const originalRename = fs.renameSync;
  t.mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
    if (!rejected && String(to) === failTarget) { rejected = true; throw new Error("injected write failure"); }
    return originalRename(from, to);
  });
  await assert.rejects(f.repository.apply(plan.id), /已回退 1\/1/);
  assert.equal(fs.existsSync(path.join(f.central, "skills/demo/file-0000.md")), false);
  assert.equal(fs.existsSync(failTarget), false);
  assert.equal(fs.readFileSync(path.join(f.root, "claude/demo/file-0000.md"), "utf8"), "shared contents\n");
  assert.ok(events.some(event => event.phase === "备份原文件" && event.completed === 3));
  assert.ok(events.some(event => event.phase === "回滚文件" && event.completed === 1 && event.total === 1));
  assert.ok(events.some(event => event.phase === "同步失败"));
});
