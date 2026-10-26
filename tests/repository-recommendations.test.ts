import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { RepositoryService } from "../electron/repository-service";
import type { RepositoryPlan, RepositoryResolution } from "../src/repository-types";
import { fixture } from "./helpers";

const older = 1700000000000, newer = older + 10000;
const stamp = (file: string, milliseconds: number) => fs.utimesSync(file, milliseconds / 1000, milliseconds / 1000);
const read = (file: string) => fs.readFileSync(file, "utf8");
const choices = (plan: RepositoryPlan): Record<string, RepositoryResolution> => Object.fromEntries(plan.files.filter(file=>file.recommendation).map(file=>[file.key, { choice: "agent", sourceKey: file.recommendation!.sourceKey }]));

async function competing(t: TestContext, repositoryContent?: string) {
  const f = fixture(t), repository = new RepositoryService(f.service), central = f.dir("central");
  const claude = f.file("claude-skills/demo/SKILL.md", "claude version\n");
  const trae = f.file("trae-skills/demo/SKILL.md", "trae version\n");
  f.service.bind("claude", "skills", f.dir("claude-skills"));
  f.service.bind("trae", "skills", f.dir("trae-skills"));
  await repository.choose(central); repository.members(["trae", "claude"]);
  const target = path.join(central, "skills/demo/SKILL.md");
  if (repositoryContent !== undefined) f.file("central/skills/demo/SKILL.md", repositoryContent);
  stamp(claude, older); stamp(trae, newer);
  return { ...f, repository, claude, trae, target };
}

test("an empty shared repository recommends the newest Agent for every competing row without resolving the conflict", async t => {
  const f = await competing(t), plan = await f.repository.preview();
  assert.equal(plan.files.length, 2);
  const source = plan.files.find(file=>file.agent === "trae")!;
  for (const file of plan.files) {
    assert.equal(file.conflict, true);
    assert.equal(file.repositoryExists, false);
    assert.equal(file.repositoryModifiedMs, undefined);
    assert.equal(file.localModifiedMs, file.agent === "trae" ? newer : older);
    assert.deepEqual(file.recommendation, { sourceKey: source.key, reason: "repository-missing", tied: false });
  }
  await assert.rejects(f.repository.apply(plan.id), /未解决/);
  assert.equal(fs.existsSync(f.target), false);
  const selected = await f.repository.preview();
  await f.repository.apply(selected.id, choices(selected));
  for (const file of [f.claude, f.trae, f.target]) assert.equal(read(file), "trae version\n");
});

test("an older repository recommends one newest Agent source for all participants", async t => {
  const f = await competing(t, "repository version\n"); stamp(f.target, older + 5000);
  const plan = await f.repository.preview(), source = plan.files.find(file=>file.agent === "trae")!;
  for (const file of plan.files) {
    assert.equal(file.repositoryModifiedMs, older + 5000);
    assert.deepEqual(file.recommendation, { sourceKey: source.key, reason: "agent-newer", tied: false });
  }
  await f.repository.apply(plan.id, choices(plan));
  assert.equal(read(f.target), "trae version\n");
});

for (const repositoryTime of [newer, newer + 5000]) {
  test(`a repository timestamp ${repositoryTime === newer ? "equal to" : "newer than"} the newest Agent keeps conflicts unselected`, async t => {
    const f = await competing(t, "repository version\n"); stamp(f.target, repositoryTime);
    const plan = await f.repository.preview();
    assert.equal(plan.files.length, 2);
    assert.ok(plan.files.every(file=>file.conflict && file.recommendation === undefined));
    await assert.rejects(f.repository.apply(plan.id), /未解决/);
    assert.equal(read(f.target), "repository version\n");
  });
}

test("different versions with tied newest timestamps choose a stable Agent and disclose the tie", async t => {
  const f = await competing(t); stamp(f.claude, newer);
  const first = await f.repository.preview();
  const sourceKey = first.files.find(file=>file.agent === "claude")!.key;
  assert.ok(first.files.every(file=>file.recommendation?.sourceKey === sourceKey && file.recommendation.tied));
  f.repository.members(["claude", "trae"]);
  const reordered = await f.repository.preview();
  assert.ok(reordered.files.every(file=>file.recommendation?.sourceKey === sourceKey && file.recommendation.tied));
  await f.repository.apply(reordered.id, choices(reordered));
  assert.equal(read(f.target), "claude version\n");
});

test("newest Agents with identical contents do not report an ambiguous tie", async t => {
  const f = await competing(t);
  const workbuddy = f.file("workbuddy-skills/demo/SKILL.md", "trae version\n");
  f.service.bind("workbuddy", "skills", f.dir("workbuddy-skills")); stamp(workbuddy, newer);
  f.repository.members(["workbuddy", "claude", "trae"]);
  const plan = await f.repository.preview();
  assert.equal(plan.files.length, 3);
  assert.ok(plan.files.every(file=>file.recommendation?.sourceKey === "trae:skills:demo/SKILL.md" && !file.recommendation.tied));
});

test("a missing repository file from only one Agent remains an ordinary import", async t => {
  const f = await competing(t); f.repository.members(["claude"]);
  const plan = await f.repository.preview();
  assert.equal(plan.files[0].conflict, false); assert.equal(plan.files[0].recommendation, undefined);
  await f.repository.apply(plan.id); assert.equal(read(f.target), "claude version\n");
});

test("timestamp-only changes in either competing Agent invalidate the whole recommended preview", async t => {
  for (const changedAgent of ["claude", "trae"] as const) {
    const f = await competing(t), plan = await f.repository.preview();
    stamp(f[changedAgent], newer + 5000);
    await assert.rejects(f.repository.apply(plan.id, choices(plan)), /修改时间发生变化.*重新预览/);
    assert.equal(read(f.claude), "claude version\n"); assert.equal(read(f.trae), "trae version\n");
    assert.equal(fs.existsSync(f.target), false);
  }
});

test("a timestamp-only repository update invalidates an outdated recommendation before writes", async t => {
  const f = await competing(t, "repository version\n"); stamp(f.target, older);
  const plan = await f.repository.preview(); stamp(f.target, newer + 5000);
  await assert.rejects(f.repository.apply(plan.id, choices(plan)), /修改时间发生变化.*重新预览/);
  assert.equal(read(f.target), "repository version\n"); assert.equal(read(f.claude), "claude version\n");
});

test("memory conflicts recommend an explicitly selectable self source when the Agent is newer", async t => {
  const f = fixture(t), repository = new RepositoryService(f.service), central = f.dir("central");
  const local = f.file("agent/CLAUDE.md", "local memory\n"); f.service.bind("claude", "memory", local);
  await repository.choose(central); repository.members(["claude"]);
  const target = f.file("central/memories/claude/CLAUDE.md", "repository memory\n"); stamp(local, newer); stamp(target, older);
  const plan = await repository.preview();
  assert.deepEqual(plan.files[0].recommendation, { sourceKey: plan.files[0].key, reason: "agent-newer", tied: false });
  await repository.apply(plan.id, choices(plan)); assert.equal(read(target), "local memory\n");
});

test("automatic synchronization never adopts a recommendation without the manual preview choices", async t => {
  const f = await competing(t);
  const plan = await f.repository.preview(); assert.ok(plan.files.every(file=>file.recommendation));
  f.repository.cancelPreview();
  f.repository.automation({ enabled: true, intervalSeconds: 30, cleanupEnabled: false, retentionDays: 30, minBackups: 20 });
  await f.repository.tick(Date.now() + 31000);
  assert.equal(f.repository.taskStatus().issue, "conflict");
  assert.equal(read(f.claude), "claude version\n"); assert.equal(read(f.trae), "trae version\n");
  assert.equal(fs.existsSync(f.target), false);
});
