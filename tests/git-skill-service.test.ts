import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import git from "isomorphic-git";
import { fixture } from "./helpers";
import { RepositoryService } from "../electron/repository-service";
import { inventory } from "../electron/repository-files";
import { readRevision } from "../electron/repository-git";

async function skillRepository(root: string, text = "# Fixture skill\n") {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "SKILL.md"), text);
  await git.init({ fs, dir: root, defaultBranch: "skill-main" });
  await git.add({ fs, dir: root, filepath: "SKILL.md" });
  const oid = await git.commit({ fs, dir: root, message: "Original skill history", author: { name: "Fixture", email: "fixture@example.invalid" } });
  await git.setConfig({ fs, dir: root, path: "remote.origin.url", value: "https://example.invalid/fixture.git" });
  fs.mkdirSync(path.join(root, ".git", "hooks"), { recursive: true });
  fs.writeFileSync(path.join(root, ".git", "hooks", "post-checkout"), "throw 'never execute this fixture'\n");
  return oid;
}
function metadata(root: string) {
  const result: Record<string, string> = {};
  function walk(relative: string) {
    const file = path.join(root, relative), stat = fs.lstatSync(file);
    assert.equal(stat.isSymbolicLink(), false);
    if (stat.isDirectory()) { result[relative] = "directory"; for (const name of fs.readdirSync(file).sort()) walk(path.join(relative, name)); }
    else result[relative] = fs.readFileSync(file).toString("base64");
  }
  walk(".git"); return result;
}

test("working-file inventory accepts Git skills but never traverses or merges their metadata", async t => {
  const f = fixture(t), root = f.dir("skills");
  await skillRepository(root); await skillRepository(f.dir("skills/nested"));
  assert.deepEqual(inventory(root).map(file => file.relative).sort(), ["SKILL.md", "nested/SKILL.md"].sort());
  const alias = path.join(root, "metadata-alias");
  fs.symlinkSync(path.join(root, "nested", ".git"), alias, "junction");
  assert.throws(() => inventory(root, { links: true }), /Git|\.git/);
});

test("service migrates root and nested Git skills, keeps central history separate, auto-syncs and restores originals", async t => {
  const f = fixture(t), root = f.dir("skills"), nested = f.dir("skills/nested");
  const rootOid = await skillRepository(root), nestedOid = await skillRepository(nested);
  const rootBefore = metadata(root), nestedBefore = metadata(nested);
  f.file("skills/nested/untracked.bin", Buffer.from([0, 255, 18]));
  const repository = new RepositoryService(f.service), central = f.dir("central");
  await repository.choose(central); repository.members(["claude"]); f.service.bind("claude", "skills", root);
  const plan = repository.linkPreview("claude");
  assert.ok(plan.files.some(file => /(^|[\\/])\.git[\\/]/.test(file.relative)));
  await repository.linkApply(plan.id, {});
  const shared = path.join(central, "skills"), sharedNested = path.join(shared, "nested");
  assert.equal(fs.lstatSync(root).isSymbolicLink(), true);
  assert.deepEqual(metadata(shared), rootBefore); assert.deepEqual(metadata(sharedNested), nestedBefore);
  assert.equal((await git.log({ fs, dir: shared }))[0].oid, rootOid);
  assert.equal((await git.log({ fs, dir: sharedNested }))[0].oid, nestedOid);
  assert.deepEqual(fs.readFileSync(path.join(sharedNested, "untracked.bin")), Buffer.from([0, 255, 18]));
  const centralFiles = await git.listFiles({ fs, dir: central });
  assert.ok(centralFiles.includes("skills/nested/SKILL.md"));
  assert.equal(centralFiles.some(file => file.split("/").includes(".git")), false);
  assert.equal((await repository.preview()).files.length, 0);
  repository.automation({ enabled: true, intervalSeconds: 30, cleanupEnabled: false, retentionDays: 30, minBackups: 20 });
  fs.writeFileSync(path.join(root, "nested", "SKILL.md"), "# Edited through junction\n");
  await repository.tick(Date.now() + 31000);
  const snapshot = await repository.snapshot(); assert.equal(snapshot.error, undefined); assert.equal(snapshot.git?.dirty, 0);
  assert.equal((await readRevision(central, snapshot.history[0].oid, "skills/nested/SKILL.md")).toString(), "# Edited through junction\n");
  assert.deepEqual(metadata(shared), rootBefore); assert.deepEqual(metadata(sharedNested), nestedBefore);
  await repository.unlink("claude");
  assert.equal(fs.lstatSync(root).isDirectory(), true);
  assert.deepEqual(metadata(root), rootBefore); assert.deepEqual(metadata(nested), nestedBefore);
  assert.equal(fs.readFileSync(path.join(nested, "SKILL.md"), "utf8"), "# Fixture skill\n");
  assert.equal(fs.readFileSync(path.join(sharedNested, "SKILL.md"), "utf8"), "# Edited through junction\n");
});

test("independent Git skill copies synchronize working files without merging either repository metadata", async t => {
  const f = fixture(t), local = f.dir("skills/review"), central = f.dir("central");
  await skillRepository(local, "# Local\n");
  const repository = new RepositoryService(f.service); await repository.choose(central); repository.members(["claude"]);
  const remote = path.join(central, "skills", "review"); await skillRepository(remote, "# Remote\n");
  const localBefore = metadata(local), remoteBefore = metadata(remote);
  f.service.bind("claude", "skills", path.dirname(local));
  const plan = await repository.preview(); assert.equal(plan.files.length, 1); assert.equal(plan.files[0].conflict, true);
  await repository.apply(plan.id, { [plan.files[0].key]: { choice: "agent" } });
  assert.equal(fs.readFileSync(path.join(remote, "SKILL.md"), "utf8"), "# Local\n");
  assert.deepEqual(metadata(local), localBefore); assert.deepEqual(metadata(remote), remoteBefore);
  repository.automation({ enabled: true, intervalSeconds: 30, cleanupEnabled: false, retentionDays: 30, minBackups: 20 });
  fs.writeFileSync(path.join(remote, "SKILL.md"), "# Changed in repository\n");
  await repository.tick(Date.now() + 31000);
  assert.equal(fs.readFileSync(path.join(local, "SKILL.md"), "utf8"), "# Changed in repository\n");
  assert.deepEqual(metadata(local), localBefore); assert.deepEqual(metadata(remote), remoteBefore);
  assert.equal((await repository.snapshot()).error, undefined);
});

test("migration refuses a different existing Git history without changing either working tree", async t => {
  const f = fixture(t), local = f.dir("skills/review"), central = f.dir("central");
  await skillRepository(local, "# Local\n");
  const repository = new RepositoryService(f.service); await repository.choose(central); repository.members(["claude"]);
  const remote = path.join(central, "skills", "review"); await skillRepository(remote, "# Remote\n");
  f.service.bind("claude", "skills", path.dirname(local));
  const localBefore = metadata(local), remoteBefore = metadata(remote);
  assert.throws(() => repository.linkPreview("claude"), /Git|git|仓库/);
  assert.equal(fs.lstatSync(path.dirname(local)).isDirectory(), true);
  assert.deepEqual(metadata(local), localBefore); assert.deepEqual(metadata(remote), remoteBefore);
  assert.equal(fs.readFileSync(path.join(local, "SKILL.md"), "utf8"), "# Local\n");
  assert.equal(fs.readFileSync(path.join(remote, "SKILL.md"), "utf8"), "# Remote\n");
});
