import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { TestContext } from "node:test";
import { RepositoryService } from "../electron/repository-service";
import { fixture } from "./helpers";

async function shared(t: TestContext, content: string | Buffer, relative = "demo/SKILL.md") {
  const f = fixture(t), repository = new RepositoryService(f.service), central = f.dir("central");
  const claude = f.file(`claude-skills/${relative}`, content);
  const trae = f.file(`trae-skills/${relative}`, content);
  f.service.bind("claude", "skills", f.dir("claude-skills"));
  f.service.bind("trae", "skills", f.dir("trae-skills"));
  await repository.choose(central);
  repository.members(["claude", "trae"]);
  await repository.apply((await repository.preview()).id);
  return { ...f, repository, claude, trae, centralFile: path.join(central, "skills", relative) };
}

const enable = (r: RepositoryService) => r.automation({ enabled: true, intervalSeconds: 30, cleanupEnabled: false, retentionDays: 30, minBackups: 20 });
const read = (file: string) => fs.readFileSync(file, "utf8");

test("a single Agent's shared-skill edit propagates to the repository and unchanged peers", async t => {
  const f = await shared(t, "old\n");
  fs.writeFileSync(f.claude, "new\n");
  const plan = await f.repository.preview();
  assert.equal(plan.files.some(file => file.conflict), false, "an unchanged peer is not a competing edit");
  await f.repository.apply(plan.id);
  for (const file of [f.claude, f.trae, f.centralFile]) assert.equal(read(file), "new\n");
  assert.equal((await f.repository.preview()).files.length, 0);
});

test("a single Agent's binary asset edit propagates without requiring a manual text merge", async t => {
  const before = Buffer.from([0, 1, 2, 255]), after = Buffer.from([0, 3, 4, 128]);
  const f = await shared(t, before, "demo/assets/icon.bin");
  fs.writeFileSync(f.claude, after);
  const plan = await f.repository.preview();
  assert.equal(plan.files.some(file => file.conflict), false);
  await f.repository.apply(plan.id);
  for (const file of [f.claude, f.trae, f.centralFile]) assert.deepEqual(fs.readFileSync(file), after);
});

test("independent edits from two Agents merge using the shared repository version", async t => {
  const base = "title\nfirst\nmiddle\nlast\nfooter\n";
  const f = await shared(t, base);
  fs.writeFileSync(f.claude, "title\nFIRST\nmiddle\nlast\nfooter\n");
  fs.writeFileSync(f.trae, "title\nfirst\nmiddle\nLAST\nfooter\n");
  const plan = await f.repository.preview();
  assert.equal(plan.files.some(file => file.conflict), false);
  await f.repository.apply(plan.id);
  for (const file of [f.claude, f.trae, f.centralFile]) assert.equal(read(file), "title\nFIRST\nmiddle\nLAST\nfooter\n");
  assert.equal((await f.repository.preview()).files.length, 0);
});

test("overlapping edits from two Agents suspend automatic sync without writing any version", async t => {
  const f = await shared(t, "base\n");
  enable(f.repository);
  fs.writeFileSync(f.claude, "claude choice\n");
  fs.writeFileSync(f.trae, "trae choice\n");
  await f.repository.tick(Date.now() + 31_000);
  assert.equal(read(f.claude), "claude choice\n");
  assert.equal(read(f.trae), "trae choice\n");
  assert.equal(read(f.centralFile), "base\n");
  assert.match((await f.repository.snapshot()).lastMessage || "", /冲突/);
  const plan = await f.repository.preview();
  assert.equal(plan.files.filter(file => file.conflict).length, 2);
  await assert.rejects(f.repository.apply(plan.id), /未解决|冲突/);
  assert.equal(read(f.centralFile), "base\n");
});

test("automatic ticks preserve an outstanding manual preview until explicitly cancelled", async t => {
  const f = await shared(t, "base\n");
  enable(f.repository);
  fs.writeFileSync(f.claude, "pending edit\n");
  const manual = await f.repository.preview();
  const now = Date.now();
  await f.repository.tick(now + 31_000);
  assert.equal(f.repository.review(manual.id).id, manual.id);
  assert.equal(read(f.centralFile), "base\n", "a background run must not write while the user reviews a plan");
  assert.equal(read(f.trae), "base\n");
  f.repository.cancelPreview();
  assert.throws(() => f.repository.review(manual.id), /过期|失效|预览/);
  await f.repository.tick(now + 62_000);
  for (const file of [f.claude, f.trae, f.centralFile]) assert.equal(read(file), "pending edit\n");
});

test("a selected Agent version resolves a shared binary conflict for every participant", async t => {
  const f = await shared(t, Buffer.from([0, 1]), "demo/assets/icon.bin");
  const winner = Buffer.from([0, 2, 255]);
  fs.writeFileSync(f.claude, winner);
  fs.writeFileSync(f.trae, Buffer.from([0, 3, 128]));
  const plan = await f.repository.preview();
  assert.equal(plan.files.filter(file => file.conflict).length, 2);
  const sourceKey = plan.files.find(file => file.agent === "claude")!.key;
  await f.repository.apply(plan.id, Object.fromEntries(plan.files.map(file => [file.key, { choice: "agent" as const, sourceKey }])));
  for (const file of [f.claude, f.trae, f.centralFile]) assert.deepEqual(fs.readFileSync(file), winner);
  assert.equal((await f.repository.preview()).files.length, 0);
});
