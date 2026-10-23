import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fixture } from "./helpers";
import { MAX_FILE } from "../electron/safety";
import { ConsoleService } from "../electron/service";

// These are real temporary directory links, not mocked resolution results.
function junction(target: string, link: string): string {
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
  return link;
}

function retarget(link: string, target: string): void {
  // Remove only the link; never recursively remove the linked directory.
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
  fs.unlinkSync(link);
  junction(target, link);
}

test("linked skill inspection counts large libraries without reading file contents or granting access", (t) => {
  const { dir, file, root, service } = fixture(t);
  const actual = dir("library"), skills = dir("home/.claude/skills");
  for (let n = 0; n < 205; n++) file(`library/skill-${n}/SKILL.md`, "skill");
  file("library/oversized.md", Buffer.alloc(MAX_FILE + 1));
  junction(actual, path.join(skills, "library"));

  const info = service.skillsInfo(skills);
  assert.equal(info.error, undefined);
  assert.equal(info.linked, true);
  assert.equal(info.count, 205);
  assert.equal(info.files, 206);
  assert.equal(info.truncated, false);
  assert.equal(info.links?.length, 1);
  assert.equal(info.links?.[0].target, path.join(root, "library"));
  const claude = service.snapshot().agents.find((a) => a.id === "claude")!;
  assert.equal(claude.skillsApproved, false);
  assert.equal(service.settings("claude").skills, undefined);
});

test("authorization rejects a junction changed while its captured mapping was awaiting approval", (t) => {
  const { dir, file, root, service } = fixture(t);
  const first = dir("first"), second = dir("second");
  file("first/SKILL.md", "same");
  file("second/SKILL.md", "same");
  const link = junction(first, path.join(root, "skills"));
  const captured = service.prepareSkills(link);
  retarget(link, second);
  assert.throws(() => service.bindSkills("claude", captured), /变化|链接|junction|授权/);
  assert.equal(service.settings("claude").skills, undefined);
  service.bindSkills("claude", service.prepareSkills(link));
  assert.equal(service.settings("claude").skillsAccess?.realRoot, second);
});

test("sync and restore write through an approved junction while preserving its logical backup mapping", (t) => {
  const { dir, file, root, service } = fixture(t);
  const source = dir("source"), target = dir("target"), actual = dir("library");
  file("source/demo/SKILL.md", "updated skill");
  const realFile = file("library/SKILL.md", "original skill");
  const link = junction(actual, path.join(target, "demo"));
  const logicalFile = path.join(link, "SKILL.md");
  service.bind(null, "canonicalSkills", source);
  service.bind("claude", "skills", target);
  const plan = service.preview("skills", ["claude"]);
  assert.equal(plan.items.length, 1);
  assert.equal(plan.items[0].target, realFile);
  assert.equal(plan.items[0].targetLogical, logicalFile);
  assert.equal(service.apply(plan.id), 1);
  assert.equal(fs.readFileSync(realFile, "utf8"), "updated skill");
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
  const backup = service.backups()[0];
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "storage/backups", backup.id, "manifest.json"), "utf8"));
  assert.equal(manifest.entries[0].target, realFile);
  assert.equal(manifest.entries[0].logicalTarget, logicalFile);
  assert.equal(service.apply(service.restore(backup.id).id), 1);
  assert.equal(fs.readFileSync(logicalFile, "utf8"), "original skill");
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
  assert.equal(service.verifyAudit().valid, true);
});

test("an explicitly approved skill root junction supports new files without replacing the junction", (t) => {
  const { dir, file, root, service } = fixture(t);
  const source = dir("source"), actual = dir("library");
  file("source/demo/SKILL.md", "new skill");
  const link = junction(actual, path.join(root, "skills"));
  service.bind(null, "canonicalSkills", source);
  service.bind("claude", "skills", link);
  assert.equal(service.settings("claude").skills, link);
  assert.equal(service.settings("claude").skillsAccess?.realRoot, actual);
  const plan = service.preview("skills", ["claude"]);
  assert.equal(plan.items[0].target, path.join(actual, "demo/SKILL.md"));
  service.apply(plan.id);
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
  assert.equal(fs.readFileSync(path.join(actual, "demo/SKILL.md"), "utf8"), "new skill");
});

test("linked source skills are copied as ordinary text files and never reproduce source links or scripts", (t) => {
  const { dir, file, service } = fixture(t);
  const source = dir("source"), actual = dir("library"), target = dir("target");
  file("library/SKILL.md", "linked skill");
  file("library/run.ps1", "unsafe script");
  junction(actual, path.join(source, "demo"));
  service.bind(null, "canonicalSkills", source);
  service.bind("claude", "skills", target);
  const plan = service.preview("skills", ["claude"]);
  assert.equal(plan.items.length, 1);
  assert.equal(plan.items[0].source, path.join(actual, "SKILL.md"));
  assert.equal(plan.items[0].sourceLogical, path.join(source, "demo/SKILL.md"));
  service.apply(plan.id);
  assert.equal(fs.lstatSync(path.join(target, "demo")).isSymbolicLink(), false);
  assert.equal(fs.readFileSync(path.join(target, "demo/SKILL.md"), "utf8"), "linked skill");
  assert.equal(fs.existsSync(path.join(target, "demo/run.ps1")), false);
});

test("legacy path grants keep plain folders usable but never silently authorize added junctions", (t) => {
  const { dir, file, service } = fixture(t);
  const source = dir("source"), target = dir("target"), actual = dir("library");
  file("source/demo/SKILL.md", "new");
  file("target/demo/SKILL.md", "old");
  const realFile = file("library/SKILL.md", "old");
  service.bind(null, "canonicalSkills", source);
  service.config.agents.claude = { skills: target };
  assert.equal(service.preview("skills", ["claude"]).items.length, 1);
  fs.renameSync(path.join(target, "demo"), path.join(target, "former-demo"));
  junction(actual, path.join(target, "demo"));
  assert.throws(() => service.preview("skills", ["claude"]), /授权|链接|junction|变化/);
  assert.equal(fs.readFileSync(realFile, "utf8"), "old");
  assert.equal(service.settings("claude").skillsAccess, undefined);
  service.bind("claude", "skills", target);
  service.apply(service.preview("skills", ["claude"]).id);
  assert.equal(fs.readFileSync(realFile, "utf8"), "new");
});

for (const changed of ["source", "target"] as const)
  test(`${changed} junction redirection after preview is rejected even when both destinations have identical bytes`, (t) => {
    const { dir, file, service } = fixture(t);
    const source = dir("source"), target = dir("target");
    const first = dir("first"), second = dir("second");
    const data = changed === "source" ? "new" : "old";
    file("first/SKILL.md", data);
    file("second/SKILL.md", data);
    const link = junction(first, path.join(changed === "source" ? source : target, "demo"));
    file(changed === "source" ? "target/demo/SKILL.md" : "source/demo/SKILL.md", changed === "source" ? "old" : "new");
    service.bind(null, "canonicalSkills", source);
    service.bind("claude", "skills", target);
    const plan = service.preview("skills", ["claude"]);
    retarget(link, second);
    assert.throws(() => service.apply(plan.id), /变化|链接|junction|授权/);
    assert.equal(fs.readFileSync(path.join(first, "SKILL.md"), "utf8"), data);
    assert.equal(fs.readFileSync(path.join(second, "SKILL.md"), "utf8"), data);
    assert.equal(fs.readFileSync(path.join(target, "demo/SKILL.md"), "utf8"), "old");
    assert.equal(service.backups().length, 0);
  });

test("a newly added link is not covered by an earlier folder approval", (t) => {
  const { dir, file, service } = fixture(t);
  const source = dir("source"), target = dir("target"), actual = dir("library");
  file("source/demo/SKILL.md", "new");
  const realFile = file("library/SKILL.md", "old");
  service.bind(null, "canonicalSkills", source);
  service.bind("claude", "skills", target);
  junction(actual, path.join(target, "demo"));
  assert.throws(() => service.preview("skills", ["claude"]), /变化|链接|junction|授权/);
  assert.equal(fs.readFileSync(realFile, "utf8"), "old");
  service.bind("claude", "skills", target);
  service.apply(service.preview("skills", ["claude"]).id);
  assert.equal(fs.readFileSync(realFile, "utf8"), "new");
});

test("different agent folder aliases cannot schedule duplicate writes to the same actual file", (t) => {
  const { dir, file, root, service } = fixture(t);
  const source = dir("source"), actual = dir("library");
  file("source/SKILL.md", "new");
  const original = file("library/SKILL.md", "old");
  const first = junction(actual, path.join(root, "claude-skills"));
  const second = junction(actual, path.join(root, "trae-skills"));
  service.bind(null, "canonicalSkills", source);
  service.bind("claude", "skills", first);
  service.bind("trae", "skills", second);
  assert.throws(() => service.preview("skills", ["claude", "trae"]), /相同目标|重复/);
  assert.equal(fs.readFileSync(original, "utf8"), "old");
});

test("source aliases cannot bypass identical or nested source and target rejection", (t) => {
  const { dir, file, root, service } = fixture(t);
  const actual = dir("library"), nested = dir("library/nested");
  file("library/SKILL.md", "root");
  file("library/nested/SKILL.md", "nested");
  const alias = junction(actual, path.join(root, "source-alias"));
  service.bind(null, "canonicalSkills", alias);
  for (const target of [actual, nested]) {
    service.bind("claude", "skills", target);
    assert.throws(() => service.preview("skills", ["claude"]), /互相嵌套|重叠/);
  }
  service.bind(null, "canonicalSkills", nested);
  service.bind("claude", "skills", alias);
  assert.throws(() => service.preview("skills", ["claude"]), /互相嵌套|重叠/);
});

test("a source file symlink into the target cannot bypass actual path overlap protection", (t) => {
  const { dir, file, service } = fixture(t);
  const source = dir("source"), target = dir("target");
  const original = file("target/original.md", "must remain unchanged");
  const sourceLink = path.join(dir("source/demo"), "SKILL.md");
  try {
    fs.symlinkSync(original, sourceLink, "file");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM")
      return t.skip("Windows does not grant file symlink creation");
    throw error;
  }
  service.bind(null, "canonicalSkills", source);
  service.bind("claude", "skills", target);
  assert.equal(service.config.canonicalSkillsAccess?.links[0].kind, "file");
  assert.throws(() => service.preview("skills", ["claude"]), /互相嵌套|重叠/);
  assert.equal(fs.readFileSync(original, "utf8"), "must remain unchanged");
  assert.equal(fs.existsSync(path.join(target, "demo")), false);
  assert.equal(service.backups().length, 0);
});

test("a protected root that is itself a junction also protects its canonical target", (t) => {
  const { dir, file, root, service } = fixture(t);
  const actual = dir("actual-application"), nested = dir("actual-application/skills");
  const original = file("actual-application/skills/SKILL.md", "application data");
  const protectedAlias = junction(actual, path.join(root, "application-alias"));
  const guarded = new ConsoleService(path.join(root, "guarded-storage"), service.adapters, [protectedAlias]);
  for (const selected of [actual, nested, protectedAlias])
    assert.throws(() => guarded.bind("claude", "skills", selected), /不能写入|受保护/);
  assert.equal(guarded.settings("claude").skills, undefined);
  assert.equal(guarded.settings("claude").skillsAccess, undefined);
  assert.equal(fs.readFileSync(original, "utf8"), "application data");
  assert.equal(fs.lstatSync(protectedAlias).isSymbolicLink(), true);
});

test("a protected disk root allows service startup while rejecting writes anywhere on that disk", (t) => {
  const { dir, file, root, service } = fixture(t);
  const target = dir("skills"), original = file("skills/SKILL.md", "unchanged");
  const guarded = new ConsoleService(path.join(root, "disk-guarded-storage"), service.adapters, [path.parse(root).root]);
  assert.throws(() => guarded.bind("claude", "skills", target), /不能写入|受保护/);
  assert.throws(() => guarded.bind("claude", "memory", original), /不能写入|受保护/);
  assert.equal(guarded.settings("claude").skills, undefined);
  assert.equal(guarded.settings("claude").memory, undefined);
  assert.equal(fs.readFileSync(original, "utf8"), "unchanged");
});

test("root and child junctions cannot grant writes into protected application or storage directories", (t) => {
  const { dir, file, root, service } = fixture(t);
  const protectedRoot = dir("protected/skills"), target = dir("target");
  const original = file("protected/skills/SKILL.md", "protected");
  const rootAlias = junction(protectedRoot, path.join(root, "root-alias"));
  assert.throws(() => service.bind("claude", "skills", rootAlias), /不能写入|受保护/);
  junction(protectedRoot, path.join(target, "demo"));
  assert.throws(() => service.bind("claude", "skills", target), /不能写入|受保护/);
  assert.equal(fs.readFileSync(original, "utf8"), "protected");
  assert.equal(service.settings("claude").skills, undefined);
});

test("broken skill links are reported and cannot be authorized for writes", (t) => {
  const { dir, root, service } = fixture(t);
  const skills = dir("skills"), actual = dir("temporary-target");
  junction(actual, path.join(skills, "broken"));
  fs.rmdirSync(actual);
  const info = service.skillsInfo(skills);
  assert.ok(info.error || info.warnings?.length);
  assert.throws(() => service.bind("claude", "skills", skills));
  assert.equal(service.settings("claude").skills, undefined);
  assert.equal(fs.existsSync(path.join(root, "temporary-target")), false);
});

test("cyclic skill links terminate with a diagnostic and network paths cannot be authorized", (t) => {
  const { dir, file, service } = fixture(t);
  const skills = dir("skills");
  file("skills/SKILL.md", "safe");
  junction(skills, path.join(skills, "loop"));
  const info = service.skillsInfo(skills);
  assert.ok(info.error || info.warnings?.length);
  assert.throws(() => service.bind("claude", "skills", skills));
  assert.throws(() => service.prepareSkills("\\\\server\\share\\skills"));
  assert.equal(service.settings("claude").skills, undefined);
});

test("linked backups require current authorization for their original mapping after revoke or rebind", (t) => {
  const { dir, file, root, service } = fixture(t);
  const actual = dir("library"), other = dir("other-library");
  const original = file("library/SKILL.md", "original");
  const otherFile = file("other-library/SKILL.md", "other");
  const link = junction(actual, path.join(root, "skills"));
  service.bind("claude", "skills", link);
  service.backup("claude");
  const backupId = service.backups()[0].id;
  fs.writeFileSync(original, "modified");
  service.clear("claude", "skills");
  assert.equal(service.settings("claude").skillsAccess, undefined);
  assert.throws(() => service.restore(backupId), /授权/);
  retarget(link, other);
  service.bind("claude", "skills", link);
  assert.throws(() => service.restore(backupId), /授权|变化|不匹配|映射/);
  assert.equal(fs.readFileSync(original, "utf8"), "modified");
  assert.equal(fs.readFileSync(otherFile, "utf8"), "other");
  retarget(link, actual);
  service.bind("claude", "skills", link);
  service.apply(service.restore(backupId).id);
  assert.equal(fs.readFileSync(original, "utf8"), "original");
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
});
