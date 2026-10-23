import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  atomicWrite,
  hashFile,
  localPath,
  MAX_FILE,
  nativeExecutable,
  noLinks,
  readText,
  textTree,
  within,
} from "../electron/safety";
import { fixture, peFixture } from "./helpers";

test("local paths reject relative, root, network, device, and ADS paths", (t) => {
  const { root } = fixture(t);
  assert.equal(
    localPath(path.join(root, "file.md")),
    path.join(root, "file.md"),
  );
  for (const p of [
    "relative.md",
    "",
    path.parse(root).root,
    "\\\\server\\share\\file",
    "//server/share/file",
    "\\\\?\\C:\\file",
  ])
    assert.throws(() => localPath(p));
  if (process.platform === "win32")
    for (const p of ["C:\\file:secret", "C:\\file\0.md"])
      assert.throws(() => localPath(p));
});

test("containment rejects sibling prefix and parent traversal", (t) => {
  const { root } = fixture(t);
  const base = path.join(root, "skills");
  assert.equal(within(base, path.join(base, "nested", "SKILL.md")), true);
  assert.equal(within(base, base), true);
  assert.equal(
    within(base, path.join(root, "skills-other", "SKILL.md")),
    false,
  );
  assert.equal(within(base, path.join(base, "..", "secret.md")), false);
});

test("junctions are rejected at every existing path component and during traversal", (t) => {
  const { dir, file, root } = fixture(t);
  const actual = dir("actual");
  file("actual/SKILL.md", "safe");
  const junction = path.join(root, "linked");
  fs.symlinkSync(
    actual,
    junction,
    process.platform === "win32" ? "junction" : "dir",
  );
  assert.throws(() => noLinks(junction), /链接|junction/);
  assert.throws(
    () => readText(path.join(junction, "SKILL.md")),
    /链接|junction/,
  );
  assert.throws(
    () => noLinks(path.join(junction, "future", "new.md")),
    /链接|junction/,
  );
  assert.throws(() => textTree(root), /链接|junction/);
  assert.equal(fs.readFileSync(path.join(actual, "SKILL.md"), "utf8"), "safe");
});

test("UTF-8 text limits reject binary, invalid encoding, directory and oversized files", (t) => {
  const { file, dir } = fixture(t);
  assert.equal(readText(file("valid.md", "中文 😀")).toString(), "中文 😀");
  assert.throws(() => readText(file("binary.md", Buffer.from([65, 0, 66]))));
  assert.throws(() => readText(file("invalid.md", Buffer.from([0xc3, 0x28]))));
  assert.throws(() =>
    readText(file("huge.md", Buffer.alloc(MAX_FILE + 1, 65))),
  );
  assert.throws(() => readText(dir("folder")));
});

test("skills include supported text only, skip hidden and generated files", (t) => {
  const { file, dir } = fixture(t);
  const skills = dir("skills");
  file("skills/demo/SKILL.md", "skill");
  file("skills/demo/config.json", "{}");
  file("skills/demo/run.ps1", "Write-Host unsafe");
  file("skills/.secret/a.md");
  file("skills/node_modules/a.md");
  file("skills/image.png", Buffer.from([0, 1, 2]));
  const result = textTree(skills);
  assert.equal(result.skills, 1);
  assert.equal(result.files.length, 2);
  assert.equal(result.skipped, 4);
});

test("skills traversal has a bounded file count", (t) => {
  const { file, dir } = fixture(t);
  const skills = dir("skills");
  for (let n = 0; n < 201; n++) file(`skills/${n}.md`, "x");
  assert.throws(() => textTree(skills), /200/);
});

test("atomic writes replace destination and leave no temporary files", (t) => {
  const { file, root } = fixture(t);
  const target = file("target.md", "before");
  atomicWrite(target, "after");
  assert.equal(fs.readFileSync(target, "utf8"), "after");
  assert.equal(
    fs.readdirSync(root).some((name) => name.endsWith(".tmp")),
    false,
  );
  assert.equal(hashFile(path.join(root, "missing.md")), null);
});

test("failed atomic rename preserves original file and removes temporary file", (t) => {
  const { file, root } = fixture(t);
  const target = file("target.md", "before");
  const original = fs.renameSync;
  const mock = t.mock.method(fs, "renameSync", ((
    oldPath: fs.PathLike,
    newPath: fs.PathLike,
  ) => {
    if (String(newPath) === target) throw new Error("injected rename failure");
    return original(oldPath, newPath);
  }) as typeof fs.renameSync);
  assert.throws(() => atomicWrite(target, "after"), /injected/);
  mock.mock.restore();
  assert.equal(fs.readFileSync(target, "utf8"), "before");
  assert.equal(
    fs.readdirSync(root).some((name) => name.endsWith(".tmp")),
    false,
  );
});

test("native executable checks PE headers and rejects renamed scripts and DLLs", (t) => {
  const { file } = fixture(t);
  nativeExecutable(file("format-only.exe", peFixture()));
  assert.throws(
    () => nativeExecutable(file("fake.exe", "MZnot a program")),
    /PE/,
  );
  assert.throws(() => nativeExecutable(file("script.cmd", peFixture())), /exe/);
  const dll = peFixture();
  dll.writeUInt16LE(0x2002, 86);
  assert.throws(() => nativeExecutable(file("library.exe", dll)), /PE/);
});
