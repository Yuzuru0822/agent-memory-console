import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { previewJunction, applyJunction, undoJunction } from "../electron/junction-migration";
import { localPath, noLinks, within } from "../electron/safety";

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

test(".git entries, network paths, protected link targets and linked parents are refused", t => {
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
