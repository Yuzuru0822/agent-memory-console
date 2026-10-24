import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
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

function metadataSnapshot(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (directory: string) => {
    for (const name of fs.readdirSync(directory).sort()) {
      const file = path.join(directory, name);
      if (fs.statSync(file).isDirectory()) walk(file);
      else files[path.relative(root, file).split(path.sep).join("/")] = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    }
  };
  walk(root);
  return files;
}

for (const destination of ["skills", "skills/imported-bundle"]) {
  test(`central Git tracks work files and preserves opaque metadata for a copied ${destination}/.git repository`, async t => {
    const { dir, file, root: fixtureRoot } = fixture(t), root = dir("repository"), source = dir("source-skill");
    await initRepository(root);
    await git.init({ fs, dir: source, defaultBranch: "main" });
    const text = "# Local Git skill\r\nKeep exact working-tree bytes.\r\n";
    const asset = Buffer.from([0, 255, 128, 17]);
    file("source-skill/SKILL.md", text);
    file("source-skill/assets/icon.bin", asset);
    file("source-skill/.gitignore", "*.bin\n");
    await git.add({ fs, dir: source, filepath: ["SKILL.md", "assets/icon.bin", ".gitignore"], force: true });
    const innerOid = await git.commit({ fs, dir: source, message: "Original skill history", author: { name: "Fixture", email: "fixture@example.invalid" } });
    const sentinel = path.join(fixtureRoot, "hook-must-never-run.txt");
    file("source-skill/.git/hooks/pre-commit", `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'executed');\n`);
    // Deliberately include inner settings which must never affect central Git.
    fs.appendFileSync(path.join(source, ".git", "config"), "\n[core]\n\tautocrlf = true\n\thooksPath = .git/hooks\n");
    const target = path.join(root, destination);
    // Model the migration's preserved ordinary-directory copy. Migration itself
    // has independent junction tests; this verifies the resulting Git boundary.
    fs.cpSync(source, target, { recursive: true });
    const metadata = path.join(target, ".git"), original = metadataSnapshot(metadata);
    const originalOpen = fs.openSync;
    const guard = t.mock.method(fs, "openSync", (...args: Parameters<typeof fs.openSync>) => {
      if (typeof args[0] === "string") {
        const relative = path.relative(metadata, path.resolve(args[0]));
        assert.ok(relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative), "central Git must not open any inner metadata file");
      }
      return originalOpen(...args);
    });
    assert.equal((await repositoryStatus(root)).dirty, 3);
    const imported = await commitRepository(root, "Import skill work files only");
    assert.equal(imported.changed, true);
    assert.deepEqual(await repositoryStatus(root), { branch: "main", dirty: 0 });
    assert.equal((await readRevision(root, imported.oid, `${destination}/SKILL.md`)).toString(), text);
    assert.deepEqual(await readRevision(root, imported.oid, `${destination}/assets/icon.bin`), asset);
    const tracked = await git.listFiles({ fs, dir: root, ref: imported.oid });
    assert.ok(tracked.includes(`${destination}/SKILL.md`));
    assert.ok(tracked.includes(`${destination}/assets/icon.bin`));
    assert.ok(tracked.every(name => !name.split("/").some(part => part.toLowerCase() === ".git")));
    const tree = await git.readTree({ fs, dir: root, oid: imported.oid, filepath: destination });
    assert.ok(tree.tree.some(entry => entry.path === "SKILL.md" && entry.type === "blob"));
    assert.ok(tree.tree.every(entry => entry.type !== "commit"), "inner repositories must not become gitlinks");
    await assert.rejects(readRevision(root, imported.oid, `${destination}/.git/config`), /路径无效/);
    await initRepository(root);
    fs.writeFileSync(path.join(target, "SKILL.md"), "# Edited work file\n");
    const edited = await commitRepository(root, "Update imported work file");
    assert.equal((await readRevision(root, edited.oid, `${destination}/SKILL.md`)).toString(), "# Edited work file\n");
    assert.equal((await repositoryHistory(root)).length, 3);
    guard.mock.restore();
    assert.deepEqual(metadataSnapshot(metadata), original, "HEAD, config, refs, index, objects, hooks all remain byte-for-byte unchanged");
    assert.equal(fs.existsSync(sentinel), false);

    fs.appendFileSync(path.join(metadata, "config"), "\n# Inner-only metadata change\n");
    fs.writeFileSync(path.join(metadata, "refs", "heads", "inner-only"), `${innerOid}\n`);
    const modifiedMetadata = metadataSnapshot(metadata);
    assert.deepEqual(await repositoryStatus(root), { branch: "main", dirty: 0 });
    assert.deepEqual(await commitRepository(root, "Metadata should not be committed"), { oid: edited.oid, changed: false });
    assert.deepEqual(metadataSnapshot(metadata), modifiedMetadata);
    assert.equal(fs.existsSync(sentinel), false);
  });
}

test("inner Git pointer files, junctions and metadata aliases are not hidden as ordinary skill repositories", async t => {
  const { dir, file } = fixture(t), root = dir("repository"), outside = dir("outside-metadata");
  await initRepository(root);
  const pointer = file("repository/skills/linked-worktree/.git", "gitdir: ../../outside-metadata\n");
  await assert.rejects(repositoryStatus(root), /完整普通目录|worktree/);
  fs.unlinkSync(pointer);
  fs.symlinkSync(outside, pointer, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(commitRepository(root, "reject inner metadata junction"), /链接|junction/);
  fs.unlinkSync(pointer);
  fs.mkdirSync(pointer);
  const nestedLink = path.join(pointer, "objects");
  fs.symlinkSync(outside, nestedLink, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(repositoryStatus(root), /链接|junction/);
  fs.unlinkSync(nestedLink);
  const alias = file("repository/skills/git~1/config", "not a valid import");
  await assert.rejects(repositoryStatus(root), /别名/);
  fs.unlinkSync(alias);
  fs.rmdirSync(path.dirname(alias));
  assert.deepEqual(await repositoryStatus(root), { branch: "main", dirty: 0 });
});
