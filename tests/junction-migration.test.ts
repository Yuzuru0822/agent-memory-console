import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import git from "isomorphic-git";
import { previewJunction, applyJunction, undoJunction } from "../electron/junction-migration";
import { digest, localPath, noLinks, within } from "../electron/safety";

function fixture(t: { after: (callback: () => void) => void }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-junction-test-"));
  const source = path.join(root, "agent", "skills"), target = path.join(root, "repository", "skills");
  fs.mkdirSync(source, { recursive: true }); fs.mkdirSync(target, { recursive: true });
  const check = (value: string) => {
    const full = noLinks(localPath(value));
    if (!within(root, full)) throw new Error("测试保护路径");
  };
  const put = (base: string, relative: string, data: string | Buffer) => {
    const file = path.join(base, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data); return file;
  };
  // All paths removed here are checked temporary fixture paths, never user data.
  t.after(() => { assert.equal(within(os.tmpdir(), root), true); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, source, target, check, put };
}

test("whole bundles include scripts, hidden assets and binary files and preserve originals", t => {
  const f = fixture(t);
  f.put(f.source, "review/SKILL.md", "# Review");
  f.put(f.source, "review/scripts/run.ps1", "Write-Error 'must never execute'");
  f.put(f.source, "review/assets/icon.bin", Buffer.from([0, 1, 254, 255]));
  f.put(f.source, "review/.settings/config.json", "{}");
  fs.mkdirSync(path.join(f.source, "review", "empty"));
  const plan = previewJunction("claude", f.source, f.target, f.check);
  assert.equal(plan.files.length, 4);
  assert.equal(plan.files.find(file => file.relative.endsWith("icon.bin"))?.agent?.textPreview, undefined);
  const result = applyJunction(plan, {}, f.check);
  assert.equal(result.backupPath, plan.backupPath); assert.equal(result.imported, 4);
  assert.equal(fs.lstatSync(f.source).isSymbolicLink(), true);
  assert.equal(fs.realpathSync(f.source), fs.realpathSync(f.target));
  assert.deepEqual(fs.readFileSync(path.join(f.target, "review/assets/icon.bin")), Buffer.from([0, 1, 254, 255]));
  assert.equal(fs.existsSync(path.join(f.target, "review/empty")), true);
  assert.equal(fs.readFileSync(path.join(result.backupPath, "review/SKILL.md"), "utf8"), "# Review");
  undoJunction(f.source, f.target, result.backupPath, f.check);
  assert.equal(fs.lstatSync(f.source).isDirectory(), true);
  assert.equal(fs.existsSync(path.join(f.target, "review/SKILL.md")), true);
});

test("conflicts require individual choices and overwritten repository bytes receive backups", t => {
  const f = fixture(t);
  f.put(f.source, "a/SKILL.md", "agent"); f.put(f.target, "a/SKILL.md", "repository");
  f.put(f.source, "b/SKILL.md", "other agent"); f.put(f.target, "b/SKILL.md", "other repository");
  f.put(f.source, "c/SKILL.md", "same"); f.put(f.target, "c/SKILL.md", "same");
  const plan = previewJunction("claude", f.source, f.target, f.check);
  assert.equal(plan.files.filter(file => file.conflict).length, 2);
  assert.throws(() => applyJunction(plan, {}, f.check), /请选择/);
  assert.equal(fs.lstatSync(f.source).isDirectory(), true);
  const result = applyJunction(plan, { [path.join("a", "SKILL.md")]: "agent", [path.join("b", "SKILL.md")]: "repository" }, f.check);
  assert.equal(result.imported, 1);
  assert.equal(fs.readFileSync(path.join(f.target, "a/SKILL.md"), "utf8"), "agent");
  assert.equal(fs.readFileSync(path.join(f.target, "b/SKILL.md"), "utf8"), "other repository");
  assert.equal(fs.readFileSync(path.join(result.repositoryBackupPath!, "a/SKILL.md"), "utf8"), "repository");
});

test("a changed source file invalidates preview before any imports", t => {
  const f = fixture(t); const file = f.put(f.source, "a/SKILL.md", "before");
  const plan = previewJunction("claude", f.source, f.target, f.check); fs.writeFileSync(file, "after");
  assert.throws(() => applyJunction(plan, {}, f.check), /预览失效/);
  assert.deepEqual(fs.readdirSync(f.target), []); assert.equal(fs.existsSync(plan.backupPath), false);
});

test("a new source file or replacement root invalidates the entire plan", t => {
  const f = fixture(t); f.put(f.source, "a/SKILL.md", "before");
  const plan = previewJunction("claude", f.source, f.target, f.check);
  f.put(f.source, "new.txt", "new"); assert.throws(() => applyJunction(plan, {}, f.check), /预览失效/);
  const plan2 = previewJunction("claude", f.source, f.target, f.check);
  fs.renameSync(f.source, `${f.source}-old`); fs.mkdirSync(f.source);
  f.put(f.source, "a/SKILL.md", "before"); f.put(f.source, "new.txt", "new");
  assert.throws(() => applyJunction(plan2, {}, f.check), /预览失效/);
});

test("retargeted junction with identical bytes invalidates preview", t => {
  const f = fixture(t); const first = path.join(f.root, "first"), second = path.join(f.root, "second");
  f.put(first, "SKILL.md", "identical"); f.put(second, "SKILL.md", "identical");
  const linked = path.join(f.source, "review"); fs.symlinkSync(first, linked, "junction");
  const plan = previewJunction("claude", f.source, f.target, f.check);
  fs.unlinkSync(linked); fs.symlinkSync(second, linked, "junction");
  assert.throws(() => applyJunction(plan, {}, f.check), /预览失效/);
  assert.deepEqual(fs.readdirSync(f.target), []);
});

test("root junction is preserved as a link in backup and restored exactly", t => {
  const f = fixture(t); const original = path.join(f.root, "old-shared"); f.put(original, "a/SKILL.md", "original");
  fs.rmdirSync(f.source); fs.symlinkSync(original, f.source, "junction");
  const raw = fs.readlinkSync(f.source), plan = previewJunction("claude", f.source, f.target, f.check);
  const result = applyJunction(plan, {}, f.check);
  assert.equal(fs.lstatSync(result.backupPath).isSymbolicLink(), true);
  assert.equal(fs.readlinkSync(result.backupPath), raw);
  undoJunction(f.source, f.target, result.backupPath, f.check);
  assert.equal(fs.readlinkSync(f.source), raw); assert.equal(fs.existsSync(path.join(original, "a/SKILL.md")), true);
});

test("broken and cyclic branches are warned, skipped and retained in original backup", t => {
  const f = fixture(t); f.put(f.source, "good/SKILL.md", "good");
  fs.symlinkSync(path.join(f.root, "absent"), path.join(f.source, "broken"), "junction");
  fs.symlinkSync(f.source, path.join(f.source, "loop"), "junction");
  const plan = previewJunction("claude", f.source, f.target, f.check);
  assert.equal(plan.warnings.length, 2); assert.equal(plan.files.length, 1);
  const result = applyJunction(plan, {}, f.check);
  assert.equal(fs.lstatSync(path.join(result.backupPath, "broken")).isSymbolicLink(), true);
  assert.equal(fs.lstatSync(path.join(result.backupPath, "loop")).isSymbolicLink(), true);
  assert.equal(fs.existsSync(path.join(f.target, "good/SKILL.md")), true);
});

test("failed junction creation rolls back imported files, conflicts and original directory", t => {
  const f = fixture(t); f.put(f.source, "a/SKILL.md", "new"); f.put(f.target, "a/SKILL.md", "old"); f.put(f.source, "b/SKILL.md", "new file");
  const plan = previewJunction("claude", f.source, f.target, f.check);
  const originalSymlink = fs.symlinkSync;
  fs.symlinkSync = (() => { throw new Error("injected junction failure"); }) as typeof fs.symlinkSync;
  try { assert.throws(() => applyJunction(plan, { [path.join("a", "SKILL.md")]: "agent" }, f.check), /injected junction failure/); }
  finally { fs.symlinkSync = originalSymlink; }
  assert.equal(fs.lstatSync(f.source).isDirectory(), true);
  assert.equal(fs.readFileSync(path.join(f.target, "a/SKILL.md"), "utf8"), "old");
  assert.equal(fs.existsSync(path.join(f.target, "b/SKILL.md")), false);
  assert.equal(fs.existsSync(plan.backupPath), false);
});

test("undo rejects a retargeted junction and leaves target contents intact", t => {
  const f = fixture(t); f.put(f.source, "a/SKILL.md", "keep");
  const result = applyJunction(previewJunction("claude", f.source, f.target, f.check), {}, f.check);
  const other = path.join(f.root, "other"); fs.mkdirSync(other); fs.unlinkSync(f.source); fs.symlinkSync(other, f.source, "junction");
  assert.throws(() => undoJunction(f.source, f.target, result.backupPath, f.check), /入口已经变化/);
  assert.equal(fs.realpathSync(f.source), fs.realpathSync(other));
  assert.equal(fs.existsSync(result.backupPath), true); assert.equal(fs.existsSync(path.join(f.target, "a/SKILL.md")), true);
});

test("already linked roots are idempotent and never renamed", t => {
  const f = fixture(t); f.put(f.target, "a/SKILL.md", "shared");
  fs.rmdirSync(f.source); fs.symlinkSync(f.target, f.source, "junction");
  const plan = previewJunction("claude", f.source, f.target, f.check);
  assert.equal(plan.alreadyLinked, true); assert.equal(plan.backupPath, "");
  assert.deepEqual(applyJunction(plan, {}, f.check), { alreadyLinked: true, backupPath: "", imported: 0 });
});

test("invalid Git directories, network paths, protected link targets and linked parents are refused", t => {
  const f = fixture(t); f.put(f.source, "a/.git/config", "not imported");
  assert.throws(() => previewJunction("claude", f.source, f.target, f.check), /\.git/);
  assert.throws(() => previewJunction("claude", "\\\\server\\share\\skills", f.target, f.check), /网络路径|绝对本地/);
  const alias = path.join(f.root, "alias"); fs.symlinkSync(path.dirname(f.source), alias, "junction");
  assert.throws(() => previewJunction("claude", path.join(alias, "skills"), f.target, f.check), /链接或 junction/);
  const protectedDir = path.join(f.root, "protected"), clean = path.join(f.root, "clean"); fs.mkdirSync(protectedDir); fs.mkdirSync(clean);
  fs.symlinkSync(protectedDir, path.join(clean, "linked"), "junction");
  assert.throws(() => previewJunction("claude", clean, f.target, value => { f.check(value); if (within(protectedDir, value)) throw new Error("protected target"); }), /protected target/);
});

test("source and repository may not overlap even through nested aliases", t => {
  const f = fixture(t); f.put(f.source, "a/SKILL.md", "one");
  assert.throws(() => previewJunction("claude", f.source, path.join(f.source, "nested"), f.check), /必须分离/);
  fs.symlinkSync(f.target, path.join(f.source, "alias"), "junction");
  assert.throws(() => previewJunction("claude", f.source, f.target, f.check), /必须分离/);
});

test("file-directory conflicts and changed repository content stop before mutations", t => {
  const f = fixture(t); f.put(f.source, "review", "file"); fs.mkdirSync(path.join(f.target, "review"));
  assert.throws(() => previewJunction("claude", f.source, f.target, f.check), /文件\/目录冲突/);
  fs.unlinkSync(path.join(f.source, "review")); f.put(f.source, "a/SKILL.md", "agent");
  const targetFile = f.put(f.target, "a/SKILL.md", "repo"), plan = previewJunction("claude", f.source, f.target, f.check);
  fs.writeFileSync(targetFile, "changed");
  assert.throws(() => applyJunction(plan, { [path.join("a", "SKILL.md")]: "agent" }, f.check), /预览失效/);
  assert.equal(fs.existsSync(plan.backupPath), false);
});

test("duplicate actual bundle paths are scanned only once", t => {
  const f = fixture(t); const shared = path.join(f.root, "shared"); f.put(shared, "SKILL.md", "shared");
  fs.symlinkSync(shared, path.join(f.source, "a"), "junction"); fs.symlinkSync(shared, path.join(f.source, "b"), "junction");
  const plan = previewJunction("claude", f.source, f.target, f.check);
  assert.equal(plan.files.length, 1); assert.equal(plan.links.length, 2); assert.equal(plan.skipped, 1);
});

test("single-file size limit is enforced before reading excessive data", t => {
  const f = fixture(t); const file = f.put(f.source, "huge.bin", "");
  fs.truncateSync(file, 32 * 1024 * 1024 + 1);
  assert.throws(() => previewJunction("claude", f.source, f.target, f.check), /32 MiB/);
});

test("aliases cannot smuggle Git internals into a skill bundle", t => {
  const f = fixture(t), git = path.join(f.root, "nested", ".git"); f.put(git, "config", "private metadata");
  fs.symlinkSync(git, path.join(f.source, "innocent-name"), "junction");
  assert.throws(() => previewJunction("claude", f.source, f.target, f.check), /\.git/);
});

async function realGit(directory: string, put: ReturnType<typeof fixture>["put"], label: string) {
  fs.mkdirSync(directory, { recursive: true });
  await git.init({ fs, dir: directory, defaultBranch: "main" });
  put(directory, "SKILL.md", `${label} first\n`); put(directory, ".gitignore", "ignored/\n");
  await git.add({ fs, dir: directory, filepath: ["SKILL.md", ".gitignore"] });
  const author = { name: "Migration Test", email: "migration@example.invalid", timestamp: 1_700_000_000, timezoneOffset: 0 };
  const first = await git.commit({ fs, dir: directory, message: `${label} first`, author });
  put(directory, "SKILL.md", `${label} second\n`); await git.add({ fs, dir: directory, filepath: "SKILL.md" });
  const second = await git.commit({ fs, dir: directory, message: `${label} second`, author: { ...author, timestamp: author.timestamp + 10 } });
  await git.branch({ fs, dir: directory, ref: "feature" }); await git.tag({ fs, dir: directory, ref: "v1" });
  put(directory, "ignored/preserved.bin", Buffer.from([0, 12, 255]));
  put(directory, ".git/hooks/post-commit", "#!/bin/sh\necho should-not-run > hook-executed.txt\n");
  put(directory, ".git/config", fs.readFileSync(path.join(directory, ".git/config"), "utf8") + '\n[remote "origin"]\n\turl = https://example.invalid/repository.git\n');
  fs.mkdirSync(path.join(directory, ".git/empty-metadata"));
  fs.mkdirSync(path.join(directory, "ignored/empty"));
  const objects = path.join(directory, ".git/objects"), oids: string[] = [];
  for (const prefix of fs.readdirSync(objects).filter(name => /^[a-f0-9]{2}$/.test(name)))
    for (const suffix of fs.readdirSync(path.join(objects, prefix))) if (/^[a-f0-9]{38}$/.test(suffix)) oids.push(prefix + suffix);
  const packed = await git.packObjects({ fs, dir: directory, oids, write: true });
  await git.indexPack({ fs, dir: directory, filepath: `.git/objects/pack/${packed.filename}` });
  for (const oid of oids) fs.unlinkSync(path.join(objects, oid.slice(0, 2), oid.slice(2)));
  for (const prefix of fs.readdirSync(objects).filter(name => /^[a-f0-9]{2}$/.test(name))) fs.rmdirSync(path.join(objects, prefix));
  assert.deepEqual((await git.log({ fs, dir: directory })).map(entry => entry.oid), [second, first]);
  return { first, second };
}

function treeBytes(root: string): string[] {
  const result: string[] = [];
  const walk = (folder: string) => {
    for (const name of fs.readdirSync(folder).sort()) {
      const file = path.join(folder, name), relative = path.relative(root, file).split(path.sep).join("/");
      if (fs.lstatSync(file).isDirectory()) { result.push(`directory:${relative}`); walk(file); }
      else result.push(`file:${relative}:${digest(fs.readFileSync(file))}`);
    }
  };
  walk(root); return result;
}

test("root and nested Git worktrees preserve packed history, refs, index, hooks, ignored assets and empty directories", async t => {
  const f = fixture(t), rootHistory = await realGit(f.source, f.put, "root"), nested = path.join(f.source, "review"), nestedHistory = await realGit(nested, f.put, "nested");
  const original = treeBytes(f.source), plan = previewJunction("claude", f.source, f.target, f.check);
  assert.ok(plan.warnings.some(warning => /Git 仓库 2 个/.test(warning)));
  assert.ok(plan.files.filter(file => file.relative.split(path.sep).includes(".git")).every(file => file.agent?.textPreview === undefined));
  const result = applyJunction(plan, {}, f.check);
  assert.deepEqual(treeBytes(f.target), original); assert.deepEqual(treeBytes(result.backupPath), original);
  assert.deepEqual((await git.log({ fs, dir: f.target })).map(entry => entry.oid), [rootHistory.second, rootHistory.first]);
  assert.deepEqual((await git.log({ fs, dir: path.join(f.target, "review") })).map(entry => entry.oid), [nestedHistory.second, nestedHistory.first]);
  assert.deepEqual(await git.listBranches({ fs, dir: f.target }), ["feature", "main"]);
  assert.deepEqual(await git.listTags({ fs, dir: f.target }), ["v1"]);
  assert.equal(fs.existsSync(path.join(f.target, "hook-executed.txt")), false);
  undoJunction(f.source, f.target, result.backupPath, f.check);
  assert.deepEqual(treeBytes(f.source), original); assert.deepEqual(treeBytes(f.target), original);
  assert.equal((await git.log({ fs, dir: f.source }))[0].oid, rootHistory.second);
});

test("junctions to complete Git worktrees are imported while the original link and working tree remain intact", async t => {
  const f = fixture(t), actual = path.join(f.root, "external-git-skill"), history = await realGit(actual, f.put, "external");
  const alias = path.join(f.source, "review"); fs.symlinkSync(actual, alias, "junction");
  const before = treeBytes(actual), plan = previewJunction("claude", f.source, f.target, f.check), result = applyJunction(plan, {}, f.check);
  assert.equal(fs.lstatSync(path.join(result.backupPath, "review")).isSymbolicLink(), true);
  assert.deepEqual(treeBytes(actual), before); assert.deepEqual(treeBytes(path.join(f.target, "review")), before);
  assert.equal((await git.log({ fs, dir: path.join(f.target, "review") }))[0].oid, history.second);
  undoJunction(f.source, f.target, result.backupPath, f.check);
  assert.equal(fs.realpathSync(path.join(f.source, "review")), fs.realpathSync(actual));
});

test("identical target Git metadata is reused and different history fails as one repository conflict before writes", async t => {
  const f = fixture(t); await realGit(path.join(f.source, "review"), f.put, "source");
  fs.cpSync(path.join(f.source, "review"), path.join(f.target, "review"), { recursive: true });
  let plan = previewJunction("claude", f.source, f.target, f.check);
  assert.equal(plan.files.some(file => file.conflict), false);
  f.put(f.target, "review/SKILL.md", "new repository commit\n"); await git.add({ fs, dir: path.join(f.target, "review"), filepath: "SKILL.md" });
  await git.commit({ fs, dir: path.join(f.target, "review"), message: "different history", author: { name: "Test", email: "test@example.invalid" } });
  const sourceBefore = treeBytes(f.source), targetBefore = treeBytes(f.target);
  assert.throws(() => previewJunction("claude", f.source, f.target, f.check), /Git 整仓库冲突.*双方均保留/);
  assert.throws(() => applyJunction(plan, {}, f.check), /Git 整仓库冲突|预览失效/);
  assert.deepEqual(treeBytes(f.source), sourceBefore); assert.deepEqual(treeBytes(f.target), targetBefore);
  assert.equal(fs.existsSync(plan.backupPath), false);
});

test("Git metadata differences include extra refs and empty directories, never per-file metadata merges", async t => {
  const f = fixture(t); await realGit(f.source, f.put, "source"); fs.cpSync(f.source, f.target, { recursive: true });
  const plan = previewJunction("claude", f.source, f.target, f.check); assert.equal(plan.files.some(file => file.conflict), false);
  fs.mkdirSync(path.join(f.target, ".git/new-empty-directory"));
  assert.throws(() => previewJunction("claude", f.source, f.target, f.check), /Git 整仓库冲突/);
  fs.rmdirSync(path.join(f.target, ".git/new-empty-directory")); f.put(f.target, ".git/refs/heads/extra", "0123456789012345678901234567890123456789\n");
  assert.throws(() => previewJunction("claude", f.source, f.target, f.check), /Git 整仓库冲突/);
});

test("adding or changing Git metadata after preview invalidates migration before any mutation", async t => {
  const f = fixture(t); await realGit(f.source, f.put, "source");
  let plan = previewJunction("claude", f.source, f.target, f.check);
  f.put(f.source, ".git/refs/heads/new-ref", "0123456789012345678901234567890123456789\n");
  assert.throws(() => applyJunction(plan, {}, f.check), /预览失效/); assert.deepEqual(fs.readdirSync(f.target), []);
  plan = previewJunction("claude", f.source, f.target, f.check); fs.appendFileSync(path.join(f.source, ".git/config"), "\n# changed after preview\n");
  assert.throws(() => applyJunction(plan, {}, f.check), /预览失效/); assert.equal(fs.existsSync(plan.backupPath), false);
});

test("a failure after importing Git metadata rolls back the target and retains the exact original history", async t => {
  const f = fixture(t); await realGit(f.source, f.put, "source"); const before = treeBytes(f.source), plan = previewJunction("claude", f.source, f.target, f.check);
  const originalSymlink = fs.symlinkSync; fs.symlinkSync = (() => { throw new Error("injected after Git import"); }) as typeof fs.symlinkSync;
  try { assert.throws(() => applyJunction(plan, {}, f.check), /injected after Git import/); }
  finally { fs.symlinkSync = originalSymlink; }
  assert.deepEqual(treeBytes(f.source), before); assert.deepEqual(fs.readdirSync(f.target), []); assert.equal(fs.existsSync(plan.backupPath), false);
  assert.equal((await git.log({ fs, dir: f.source })).length, 2);
});

test("failure during Git object copying leaves neither a partial metadata tree nor missing originals", async t => {
  const f = fixture(t); await realGit(f.source, f.put, "source"); const before = treeBytes(f.source), plan = previewJunction("claude", f.source, f.target, f.check);
  const originalRename = fs.renameSync;
  fs.renameSync = ((from, to) => {
    if (String(to).startsWith(path.join(f.target, ".git/objects/pack")) && String(to).endsWith(".pack")) throw new Error("injected Git pack write failure");
    originalRename(from, to);
  }) as typeof fs.renameSync;
  try { assert.throws(() => applyJunction(plan, {}, f.check), /injected Git pack write failure/); }
  finally { fs.renameSync = originalRename; }
  assert.deepEqual(treeBytes(f.source), before); assert.deepEqual(fs.readdirSync(f.target), []); assert.equal(fs.existsSync(plan.backupPath), false);
});

test("external worktree pointers, Git external dependencies, locks and metadata links are explicitly refused", async t => {
  const f = fixture(t); await realGit(f.source, f.put, "source");
  for (const marker of ["commondir", "gitdir", "objects/info/alternates", "objects/info/http-alternates", "index.lock"]) {
    const file = f.put(f.source, `.git/${marker}`, "../external\n");
    assert.throws(() => previewJunction("claude", f.source, f.target, f.check), /外部|工作树|Git 操作/); fs.unlinkSync(file);
  }
  const config = path.join(f.source, ".git/config"), originalConfig = fs.readFileSync(config);
  for (const addition of ['\n[core]\nworktree = "../external"\n', '\n[include]\npath = ../outside.conf\n', '\n[includeIf "gitdir:*"]\npath = ../outside.conf\n', '\n[core]\nhooksPath = ../hooks\n', '\n[extensions]\npartialClone = origin\n']) {
    fs.writeFileSync(config, Buffer.concat([originalConfig, Buffer.from(addition)]));
    assert.throws(() => previewJunction("claude", f.source, f.target, f.check), /Git 配置|部分克隆/);
  }
  fs.writeFileSync(config, originalConfig);
  const linked = path.join(f.source, ".git/linked-meta"); fs.symlinkSync(f.target, linked, "junction");
  assert.throws(() => previewJunction("claude", f.source, f.target, f.check), /Git 元数据不能包含链接/); fs.unlinkSync(linked);
  fs.renameSync(path.join(f.source, ".git"), path.join(f.root, "external-metadata")); f.put(f.source, ".git", "gitdir: ../external-metadata\n");
  assert.throws(() => previewJunction("claude", f.source, f.target, f.check), /\.git 文件.*外置工作树/);
  assert.deepEqual(fs.readdirSync(f.target), []);
});

test("Git pack files can exceed the ordinary 32 MiB limit but not 128 MiB", async t => {
  const f = fixture(t); await realGit(f.source, f.put, "source");
  const large = f.put(f.source, ".git/objects/pack/large.pack", ""); fs.truncateSync(large, 33 * 1024 * 1024);
  const plan = previewJunction("claude", f.source, f.target, f.check);
  assert.equal(plan.files.find(file => file.agent?.path === large)?.agent?.size, 33 * 1024 * 1024);
  fs.truncateSync(large, 128 * 1024 * 1024 + 1);
  assert.throws(() => previewJunction("claude", f.source, f.target, f.check), /128 MiB/);
});

test("Git comments ending with a backslash cannot conceal following worktree or include settings", async t => {
  const f = fixture(t); await realGit(f.source, f.put, "source");
  const config = path.join(f.source, ".git/config"), original = fs.readFileSync(config);
  for (const addition of [
    '[core]\n# comment \\\nworktree = ../outside\n',
    '[core]\n; comment \\\nworktree = ../outside\n',
    '[core]\nignorecase = true # comment \\\nworktree = ../outside\n',
    '[core]\nignorecase = true ; comment \\\nworktree = ../outside\n',
    '# comment \\\n[include]\npath = ../outside.conf\n',
    '; comment \\\n[includeIf "gitdir:*"]\npath = ../outside.conf\n',
  ]) {
    fs.writeFileSync(config, Buffer.concat([original, Buffer.from(`\n${addition}`)]));
    assert.throws(() => previewJunction("claude", f.source, f.target, f.check), /Git 配置.*worktree|Git 配置包含外部 include/);
  }
  assert.deepEqual(fs.readdirSync(f.target), []);
});

test("Git lexer preserves valid quoted comment characters, escaped quotes and multiline values", async t => {
  const f = fixture(t); await realGit(f.source, f.put, "source");
  const config = path.join(f.source, ".git/config");
  fs.appendFileSync(config, '\n[user]\nname = "first # ; \\\nlast \\"quoted\\"" # actual comment \\\nemail = test@example.invalid\n');
  const expected = fs.readFileSync(config), plan = previewJunction("claude", f.source, f.target, f.check);
  applyJunction(plan, {}, f.check);
  assert.deepEqual(fs.readFileSync(path.join(f.target, ".git/config")), expected);
});

test("replacing the target during source rename fails and never deletes the replacement directory", async t => {
  const f = fixture(t); await realGit(f.source, f.put, "source");
  fs.rmdirSync(f.target); // Also cover a target root created by this migration.
  const original = treeBytes(f.source), plan = previewJunction("claude", f.source, f.target, f.check), displaced = `${f.target}-moved`;
  const rename = fs.renameSync;
  fs.renameSync = ((from, to) => {
    if (String(from) === f.source && String(to) === plan.backupPath) {
      rename(f.target, displaced); fs.mkdirSync(f.target);
    }
    rename(from, to);
  }) as typeof fs.renameSync;
  try { assert.throws(() => applyJunction(plan, {}, f.check), error => /目录身份发生变化/.test(String(error)) && String(error).includes(displaced) && /未清理/.test(String(error))); }
  finally { fs.renameSync = rename; }
  assert.equal(fs.lstatSync(f.source).isDirectory(), true); assert.deepEqual(treeBytes(f.source), original);
  assert.equal(fs.existsSync(f.target), true); assert.deepEqual(fs.readdirSync(f.target), []);
  assert.deepEqual(treeBytes(displaced), original); assert.equal(fs.existsSync(plan.backupPath), false);
});

test("a target moved immediately after junction creation restores the source without following the dangling link", t => {
  const f = fixture(t); f.put(f.source, "review/SKILL.md", "keep");
  const original = treeBytes(f.source), plan = previewJunction("claude", f.source, f.target, f.check), displaced = `${f.target}-moved`;
  const symlink = fs.symlinkSync;
  fs.symlinkSync = ((target, link, type) => {
    symlink(target, link, type);
    if (String(link) === f.source) fs.renameSync(f.target, displaced);
  }) as typeof fs.symlinkSync;
  try { assert.throws(() => applyJunction(plan, {}, f.check), /目录身份发生变化.*未清理/); }
  finally { fs.symlinkSync = symlink; }
  assert.equal(fs.lstatSync(f.source).isDirectory(), true); assert.deepEqual(treeBytes(f.source), original);
  assert.equal(fs.existsSync(f.target), false); assert.deepEqual(treeBytes(displaced), original); assert.equal(fs.existsSync(plan.backupPath), false);
});

test("changes to pre-existing target Git metadata during source rename preserve the target and stop linking", async t => {
  const f = fixture(t); await realGit(f.target, f.put, "existing target"); f.put(f.source, "extra/SKILL.md", "new skill");
  const sourceBefore = treeBytes(f.source), plan = previewJunction("claude", f.source, f.target, f.check), rename = fs.renameSync;
  fs.renameSync = ((from, to) => {
    rename(from, to);
    if (String(from) === f.source && String(to) === plan.backupPath) fs.appendFileSync(path.join(f.target, ".git/config"), "\n# external change during rename\n");
  }) as typeof fs.renameSync;
  try { assert.throws(() => applyJunction(plan, {}, f.check), /Git 元数据在写入期间变化.*未清理/); }
  finally { fs.renameSync = rename; }
  assert.deepEqual(treeBytes(f.source), sourceBefore); assert.equal(fs.lstatSync(f.source).isDirectory(), true);
  assert.match(fs.readFileSync(path.join(f.target, ".git/config"), "utf8"), /external change during rename/);
  assert.equal(fs.readFileSync(path.join(f.target, "extra/SKILL.md"), "utf8"), "new skill");
  assert.equal((await git.log({ fs, dir: f.target })).length, 2);
});

test("written target file changes during source rename are detected and retained for recovery", t => {
  const f = fixture(t); f.put(f.source, "review/SKILL.md", "source version");
  const plan = previewJunction("claude", f.source, f.target, f.check), rename = fs.renameSync;
  fs.renameSync = ((from, to) => {
    rename(from, to);
    if (String(from) === f.source && String(to) === plan.backupPath) fs.writeFileSync(path.join(f.target, "review/SKILL.md"), "external edit");
  }) as typeof fs.renameSync;
  try { assert.throws(() => applyJunction(plan, {}, f.check), /目标内容在写入期间变化.*未清理/); }
  finally { fs.renameSync = rename; }
  assert.equal(fs.lstatSync(f.source).isDirectory(), true);
  assert.equal(fs.readFileSync(path.join(f.source, "review/SKILL.md"), "utf8"), "source version");
  assert.equal(fs.readFileSync(path.join(f.target, "review/SKILL.md"), "utf8"), "external edit");
});

test("moving the target parent during migration preserves both the displaced tree and its replacement", t => {
  const f = fixture(t); f.put(f.source, "review/SKILL.md", "source version");
  const parent = path.dirname(f.target), displacedParent = `${parent}-moved`, movedTarget = path.join(displacedParent, path.basename(f.target));
  const plan = previewJunction("claude", f.source, f.target, f.check), rename = fs.renameSync;
  fs.renameSync = ((from, to) => {
    if (String(from) === f.source && String(to) === plan.backupPath) { rename(parent, displacedParent); fs.mkdirSync(f.target, { recursive: true }); }
    rename(from, to);
  }) as typeof fs.renameSync;
  try { assert.throws(() => applyJunction(plan, {}, f.check), error => /目录身份发生变化/.test(String(error)) && String(error).includes(movedTarget)); }
  finally { fs.renameSync = rename; }
  assert.equal(fs.lstatSync(f.source).isDirectory(), true); assert.deepEqual(fs.readdirSync(f.target), []);
  assert.equal(fs.readFileSync(path.join(movedTarget, "review/SKILL.md"), "utf8"), "source version");
});

test("Git metadata aliases are refused during preview before any skill migration", t => {
  const f = fixture(t); f.put(f.source, "review/git~1/config", "metadata alias");
  assert.throws(() => previewJunction("claude", f.source, f.target, f.check), /\.git 别名/);
  assert.deepEqual(fs.readdirSync(f.target), []); assert.equal(fs.lstatSync(f.source).isDirectory(), true);
});
