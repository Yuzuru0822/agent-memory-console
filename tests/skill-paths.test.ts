import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveSkillPath, scanSkills } from "../electron/skill-paths";
import { MAX_FILE } from "../electron/safety";

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-console-skills-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = (name: string) => {
    const target = path.join(root, name);
    fs.mkdirSync(target, { recursive: true });
    return target;
  };
  const file = (name: string, bytes: string | Buffer = "skill") => {
    const target = path.join(root, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes);
    return target;
  };
  const junction = (name: string, target: string) => {
    const alias = path.join(root, name);
    fs.mkdirSync(path.dirname(alias), { recursive: true });
    fs.symlinkSync(target, alias, process.platform === "win32" ? "junction" : "dir");
    return alias;
  };
  return { root, dir, file, junction };
}

test("skill roots and parent junctions resolve locally with link evidence", (t) => {
  const { dir, file, junction } = fixture(t);
  const actual = dir("actual/skills");
  const source = file("actual/skills/demo/SKILL.md");
  const parent = junction("alias", path.dirname(actual));
  const selected = path.join(parent, "skills");
  const resolved = resolveSkillPath(selected);
  assert.equal(resolved.real, actual);
  assert.deepEqual(resolved.links, [{ path: parent, target: path.dirname(actual), kind: "directory" }]);
  const scanned = scanSkills(selected);
  assert.equal(scanned.skills, 1);
  assert.deepEqual(scanned.links, resolved.links);
  assert.deepEqual(scanned.files, [{ logical: path.join(selected, "demo", "SKILL.md"), real: source, relative: path.join("demo", "SKILL.md") }]);
});

test("inner junctions and chained links preserve logical names and resolved destinations", (t) => {
  const { dir, file, junction } = fixture(t);
  const selected = dir("skills");
  const actual = dir("shared/demo");
  const source = file("shared/demo/SKILL.md", "external shared skill");
  const middle = junction("middle", actual);
  const alias = junction("skills/demo", middle);
  const scanned = scanSkills(selected);
  assert.equal(scanned.skills, 1);
  assert.equal(scanned.files[0].real, source);
  assert.equal(scanned.files[0].relative, path.join("demo", "SKILL.md"));
  assert.equal(scanned.links.length, 2);
  assert(scanned.links.some((link) => link.path === alias && link.target === actual));
  assert(scanned.links.some((link) => link.path === middle && link.target === actual));
});

test("new synchronization paths resolve through existing junctions without creating files", (t) => {
  const { dir, junction } = fixture(t);
  const actual = dir("actual");
  const alias = junction("skills", actual);
  const resolved = resolveSkillPath(path.join(alias, "new", "SKILL.md"));
  assert.equal(resolved.real, path.join(actual, "new", "SKILL.md"));
  assert.equal(resolved.links.length, 1);
  assert.equal(fs.existsSync(path.join(actual, "new")), false);
});

test("duplicate directories are inspected once while every encountered junction is reported", (t) => {
  const { dir, file, junction } = fixture(t);
  const selected = dir("skills");
  const actual = dir("shared");
  file("shared/SKILL.md");
  junction("skills/first", actual);
  junction("skills/second", actual);
  const scanned = scanSkills(selected, { inspection: true });
  assert.equal(scanned.skills, 1);
  assert.equal(scanned.files.length, 1);
  assert.equal(scanned.links.length, 2);
  assert.equal(scanned.skipped, 1);
  assert.equal(scanned.warnings.length, 0);
});

test("directory traversal cycles are warned during inspection and rejected during synchronization", (t) => {
  const { dir, file, junction } = fixture(t);
  const selected = dir("skills");
  file("skills/demo/SKILL.md");
  junction("skills/back", selected);
  const inspected = scanSkills(selected, { inspection: true });
  assert.equal(inspected.skills, 1);
  assert(inspected.warnings.some((warning) => warning.includes("循环")));
  assert.throws(() => scanSkills(selected), /循环/);
});

test("broken links are never interpreted as writable future directories", (t) => {
  const { dir, junction, root } = fixture(t);
  const selected = dir("skills");
  const alias = junction("skills/broken", path.join(root, "missing"));
  assert.throws(() => resolveSkillPath(path.join(alias, "SKILL.md")), /失效/);
  assert.throws(() => scanSkills(selected), /失效/);
  assert.equal(scanSkills(selected, { inspection: true }).warnings.length, 1);
});

test("self-referential link resolution is bounded", (t) => {
  const { root, junction } = fixture(t);
  const alias = path.join(root, "loop");
  junction("loop", alias);
  assert.throws(() => resolveSkillPath(alias), /循环/);
});

test("file symlinks resolve, are counted once and keep their logical relative path", (t) => {
  const { root, dir, file } = fixture(t);
  const selected = dir("skills");
  const actual = file("shared/definition.md");
  dir("skills/demo");
  const link = path.join(root, "skills/demo/SKILL.md");
  try {
    fs.symlinkSync(actual, link, "file");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") return t.skip("Windows does not grant file symlink creation");
    throw error;
  }
  fs.symlinkSync(actual, path.join(selected, "copy.md"), "file");
  const scanned = scanSkills(selected);
  assert.equal(scanned.skills, 1);
  assert.equal(scanned.files.length, 1);
  assert.equal(scanned.files[0].real, actual);
  assert.equal(scanned.links.length, 2);
  assert(scanned.links.every((item) => item.kind === "file"));
});

test("untrusted UNC link targets are rejected before any target filesystem lookup", (t) => {
  const { dir, junction } = fixture(t);
  const alias = junction("alias", dir("actual"));
  t.mock.method(fs, "readlinkSync", () => "\\\\server\\share\\SKILL.md");
  const original = fs.lstatSync;
  const lookedUp: string[] = [];
  t.mock.method(fs, "lstatSync", ((target: fs.PathLike, ...args: unknown[]) => {
    lookedUp.push(String(target));
    return (original as (...args: unknown[]) => fs.Stats)(target, ...args);
  }) as typeof fs.lstatSync);
  assert.throws(() => resolveSkillPath(alias), /网络|设备/);
  assert(lookedUp.every((target) => !target.startsWith("\\\\server")));
});

test("Windows device, UNC device, ADS and drive-root destinations remain rejected", (t) => {
  if (process.platform !== "win32") return t.skip("Windows path grammar");
  const { dir, junction } = fixture(t);
  const alias = junction("alias", dir("actual"));
  for (const target of ["\\\\?\\UNC\\server\\share", "\\\\.\\PhysicalDrive0", "C:\\file:secret", "C:\\"]) {
    const mock = t.mock.method(fs, "readlinkSync", () => target);
    assert.throws(() => resolveSkillPath(alias));
    mock.mock.restore();
  }
});

test("Windows OS-returned local junction prefixes can be normalized safely", (t) => {
  if (process.platform !== "win32") return t.skip("Windows junction prefixes");
  const { dir, junction } = fixture(t);
  const actual = dir("actual");
  const alias = junction("alias", actual);
  for (const prefix of ["\\\\?\\", "\\??\\"]) {
    const mock = t.mock.method(fs, "readlinkSync", () => `${prefix}${actual}`);
    assert.equal(resolveSkillPath(alias).real, actual);
    mock.mock.restore();
  }
});

test("inspection tolerates more than 200 text files without reading their contents", (t) => {
  const { dir, file } = fixture(t);
  const selected = dir("skills");
  for (let i = 0; i < 230; i++) file(`skills/demo${i}/SKILL.md`);
  const mock = t.mock.method(fs, "readFileSync", () => { throw new Error("inspection must not read file contents"); });
  const inspected = scanSkills(selected, { inspection: true });
  mock.mock.restore();
  assert.equal(inspected.skills, 230);
  assert.equal(inspected.files.length, 230);
  assert.equal(inspected.truncated, false);
  assert.throws(() => scanSkills(selected), /200/);
});

test("sync rejects oversized or binary text and limits total bytes; inspection remains metadata only", (t) => {
  const { dir, file } = fixture(t);
  const large = dir("large");
  file("large/SKILL.md", Buffer.alloc(MAX_FILE + 1, 65));
  assert.equal(scanSkills(large, { inspection: true }).skills, 1);
  assert.throws(() => scanSkills(large), /1 MiB/);
  const binary = dir("binary");
  file("binary/SKILL.md", Buffer.from([65, 0]));
  assert.throws(() => scanSkills(binary), /UTF-8/);
  const total = dir("total");
  for (let i = 0; i < 17; i++) file(`total/${i}.md`, Buffer.alloc(MAX_FILE, 65));
  assert.throws(() => scanSkills(total), /16 MiB/);
});

test("scripts, binaries, hidden and generated folders remain excluded", (t) => {
  const { dir, file, junction } = fixture(t);
  const selected = dir("skills");
  file("skills/demo/SKILL.md");
  file("skills/demo/run.ps1", "unsafe");
  file("skills/demo/image.png", Buffer.from([0]));
  file("skills/.hidden/SKILL.md");
  file("skills/node_modules/SKILL.md");
  const actual = dir("shared");
  file("shared/SKILL.md");
  junction("skills/.linked", actual);
  const scanned = scanSkills(selected);
  assert.equal(scanned.skills, 1);
  assert.equal(scanned.skipped, 5);
  assert.equal(scanned.links.length, 0);
});

test("deep trees are bounded and report incomplete inspection", (t) => {
  const { dir, file } = fixture(t);
  const selected = dir("skills");
  file(`skills/${Array(22).fill("nested").join("/")}/SKILL.md`);
  const inspected = scanSkills(selected, { inspection: true });
  assert.equal(inspected.truncated, true);
  assert.equal(inspected.skills, 0);
  assert(inspected.warnings.some((warning) => warning.includes("20 层")));
  assert.throws(() => scanSkills(selected), /20 层/);
});

test("entry scan limit truncates inspection and closes the bounded directory iterator", (t) => {
  const { dir } = fixture(t);
  const selected = dir("skills");
  let read = 0;
  let closed = false;
  t.mock.method(fs, "opendirSync", () => ({
    readSync: () => (++read <= 20_010 ? { name: `.hidden${read}` } : null),
    closeSync: () => { closed = true; },
  }) as unknown as fs.Dir);
  const inspected = scanSkills(selected, { inspection: true });
  assert.equal(read, 20_001);
  assert.equal(closed, true);
  assert.equal(inspected.truncated, true);
  assert.equal(inspected.warnings.length, 1);
});

test("excessive link chains are stopped without following indefinitely", (t) => {
  const { dir, junction } = fixture(t);
  let target = dir("actual");
  for (let i = 0; i < 41; i++) target = junction(`alias${i}`, target);
  assert.throws(() => resolveSkillPath(target), /40 层/);
});
