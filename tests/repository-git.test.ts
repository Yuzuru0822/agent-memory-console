import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import git from "isomorphic-git";
import { fixture } from "./helpers";
import { commitRepository, initRepository, readRevision, REPOSITORY_MARKER, repositoryHistory, repositoryStatus } from "../electron/repository-git";

test("owned Git repository initializes, reopens and records binary and script bundles", async t => {
  const { dir, file } = fixture(t), root = dir("repository");
  await initRepository(root);
  assert.deepEqual(await repositoryStatus(root), { branch: "main", dirty: 0 });
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, REPOSITORY_MARKER), "utf8")).version, 1);
  assert.ok(fs.statSync(path.join(root, "memories")).isDirectory());
  assert.ok(fs.statSync(path.join(root, "skills")).isDirectory());
  await initRepository(root);
  const bytes = Buffer.from([0, 255, 2, 128, 10]);
  file("repository/skills/demo/assets/icon.bin", bytes);
  file("repository/skills/demo/run.ps1", "throw 'never execute this script'\n");
  file("repository/memories/claude.md", "remember me\n");
  assert.equal((await repositoryStatus(root)).dirty, 3);
  const commit = await commitRepository(root, "Import memory and full skill bundle");
  assert.equal(commit.changed, true);
  assert.match(commit.oid, /^[a-f0-9]{40}$/);
  assert.deepEqual(await readRevision(root, commit.oid, "skills/demo/assets/icon.bin"), bytes);
  assert.equal((await readRevision(root, commit.oid, "skills/demo/run.ps1")).toString(), "throw 'never execute this script'\n");
  assert.deepEqual(await repositoryStatus(root), { branch: "main", dirty: 0 });
  assert.deepEqual(await commitRepository(root, "No changes"), { oid: commit.oid, changed: false });
  const history = await repositoryHistory(root);
  assert.equal(history.length, 2);
  assert.equal(history[0].message, "Import memory and full skill bundle");
  assert.ok(history[0].timestamp > Date.now() - 60_000);
});

test("Git records edits and repository-local deletion while preserving older revision content", async t => {
  const { dir, file } = fixture(t), root = dir("repository");
  await initRepository(root);
  const target = file("repository/memories/claude.md", "first");
  const first = await commitRepository(root, "first");
  fs.writeFileSync(target, "second");
  await commitRepository(root, "second");
  fs.unlinkSync(target);
  const removed = await commitRepository(root, "record removed working file");
  assert.equal(removed.changed, true);
  assert.equal((await readRevision(root, first.oid, "memories/claude.md")).toString(), "first");
  assert.equal((await repositoryHistory(root, 2)).length, 2);
  assert.equal((await repositoryStatus(root)).dirty, 0);
});

test("nonempty directories and unmanaged Git repositories are not adopted", async t => {
  const { dir, file } = fixture(t);
  file("unrelated/important.md", "keep this");
  await assert.rejects(initRepository(dir("unrelated")), /不是本应用/);
  const unmanaged = dir("unmanaged");
  await git.init({ fs, dir: unmanaged, defaultBranch: "main" });
  await assert.rejects(initRepository(unmanaged), /不是本应用/);
  assert.equal(fs.readFileSync(path.join(unmanaged, ".git", "HEAD"), "utf8"), "ref: refs/heads/main\n");
});

test("unrelated working files remain untouched and untracked", async t => {
  const { dir, file } = fixture(t), root = dir("repository");
  await initRepository(root);
  file("repository/private.txt", "do not publish");
  file("repository/memories/a.md", "memory");
  await commitRepository(root, "allowed paths only");
  assert.ok(!(await git.listFiles({ fs, dir: root })).includes("private.txt"));
  assert.equal(fs.readFileSync(path.join(root, "private.txt"), "utf8"), "do not publish");
  await git.add({ fs, dir: root, filepath: "private.txt" });
  await assert.rejects(commitRepository(root, "reject unexpected index"), /管理范围外/);
});

test("ignored assets are still included as part of complete skill bundles", async t => {
  const { dir, file } = fixture(t), root = dir("repository");
  await initRepository(root);
  file("repository/skills/demo/.gitignore", "*.bin\n");
  file("repository/skills/demo/asset.bin", Buffer.from([0, 1, 2]));
  const result = await commitRepository(root, "full bundle");
  assert.deepEqual(await readRevision(root, result.oid, "skills/demo/asset.bin"), Buffer.from([0, 1, 2]));
});

test("junctions inside repository and .git are refused before any traversal", async t => {
  const { dir, file } = fixture(t), root = dir("repository");
  await initRepository(root);
  const outside = dir("outside");
  const sentinel = file("outside/untouched.txt", "do not change");
  const link = path.join(root, "skills", "linked");
  fs.symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(repositoryStatus(root), /链接|junction/);
  await assert.rejects(commitRepository(root, "reject link"), /链接|junction/);
  fs.unlinkSync(link);
  fs.symlinkSync(outside, path.join(root, ".git", "unsafe"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(repositoryHistory(root), /链接|junction/);
  assert.equal(fs.readFileSync(sentinel, "utf8"), "do not change");
});

test("a repository path itself cannot be a junction", async t => {
  const { dir, root } = fixture(t);
  const real = dir("actual"), alias = path.join(root, "alias");
  fs.symlinkSync(real, alias, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(initRepository(alias), /链接|junction/);
  assert.deepEqual(fs.readdirSync(real), []);
});

test("Git path traversal, remote locations and invalid revision arguments are rejected", async t => {
  const { dir } = fixture(t), root = dir("repository");
  await initRepository(root);
  const [{ oid }] = await repositoryHistory(root);
  for (const p of ["../secret", "memories/../../secret", "/absolute", "skills\\secret", "skills/../secret", "skills/.git/config", "skills/file:stream", "skills/CON", "private.txt"])
    await assert.rejects(readRevision(root, oid, p));
  await assert.rejects(readRevision(root, "HEAD", "README.md"));
  await assert.rejects(repositoryHistory(root, 0));
  await assert.rejects(repositoryHistory(root, 101));
  await assert.rejects(initRepository("\\\\server\\share\\repo"));
  await assert.rejects(commitRepository(root, ""));
});

test("malformed HEAD, marker and external object stores cannot be reused", async t => {
  const { dir, file } = fixture(t), root = dir("repository");
  await initRepository(root);
  file("repository/.git/HEAD", "ref: ../../outside\n");
  await assert.rejects(repositoryStatus(root), /HEAD/);
  file("repository/.git/HEAD", "ref: refs/heads/main\n");
  file("repository/.git/objects/info/alternates", "../../outside");
  await assert.rejects(repositoryStatus(root), /外部/);
  fs.unlinkSync(path.join(root, ".git", "objects", "info", "alternates"));
  file("repository/.agent-console-repository.json", "{bad");
  await assert.rejects(initRepository(root), /标识损坏/);
});

test("oversized skill files fail without adding a Git commit", async t => {
  const { dir } = fixture(t), root = dir("repository");
  await initRepository(root);
  const target = path.join(root, "skills", "oversized.bin");
  const fd = fs.openSync(target, "w");
  fs.ftruncateSync(fd, 32 * 1024 * 1024 + 1);
  fs.closeSync(fd);
  await assert.rejects(commitRepository(root, "oversized"), /大小上限/);
  fs.unlinkSync(target);
  assert.equal((await repositoryHistory(root)).length, 1);
});

test("simultaneous commits serialize per repository without redundant history", async t => {
  const { dir, file } = fixture(t), root = dir("repository");
  await initRepository(root);
  file("repository/memories/a.md", "a");
  const results = await Promise.all([commitRepository(root, "first"), commitRepository(root, "second")]);
  assert.equal(results.filter(result => result.changed).length, 1);
  assert.equal((await repositoryHistory(root)).length, 2);
});

test("missing main ref and a corrupt index cannot silently reset repository history", async t => {
  const { dir, file } = fixture(t), root = dir("repository");
  await initRepository(root);
  const ref = path.join(root, ".git", "refs", "heads", "main");
  const value = fs.readFileSync(ref);
  fs.unlinkSync(ref);
  await assert.rejects(commitRepository(root, "must not reset"), /引用丢失/);
  fs.writeFileSync(ref, value);
  file("repository/.git/index", "invalid index");
  await assert.rejects(commitRepository(root, "corrupt index"));
  assert.equal(fs.readFileSync(ref).toString(), value.toString());
});

test("an index containing a Git symlink is rejected even when no disk link exists", async t => {
  const { dir } = fixture(t), root = dir("repository");
  await initRepository(root);
  const oid = await git.writeBlob({ fs, dir: root, blob: Buffer.from("../../outside") });
  await git.updateIndex({ fs, dir: root, filepath: "skills/unsafe-link", oid, mode: 0o120000, add: true });
  await assert.rejects(commitRepository(root, "reject staged link"), /链接|非普通/);
});
