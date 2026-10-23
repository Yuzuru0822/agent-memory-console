import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fixture } from "./helpers";

test("discovery is read-only and grants no write authorization", (t) => {
  const { file, service } = fixture(t);
  file("home/.claude/CLAUDE.md", "discovered");
  service.bind(null, "canonicalMemory", file("shared.md", "shared"));
  const claude = service.snapshot().agents.find((a) => a.id === "claude")!;
  assert.equal(claude.memory.exists, true);
  assert.equal(claude.memoryApproved, false);
  const plan = service.preview("memory", ["claude"]);
  assert.equal(plan.items.length, 0);
  assert.match(plan.skipped[0], /授权/);
  assert.throws(() => service.backup("claude"), /授权/);
});

test("memory synchronization previews changes, backs up, writes and restores", (t) => {
  const { file, service } = fixture(t);
  const source = file("shared.md", "shared 中文"),
    target = file("claude/CLAUDE.md", "original");
  service.bind(null, "canonicalMemory", source);
  service.bind("claude", "memory", target);
  const plan = service.preview("memory", ["claude"]);
  assert.equal(plan.items.length, 1);
  assert.equal(plan.items[0].oldText, "original");
  assert.equal(plan.items[0].newText, "shared 中文");
  assert.equal(fs.readFileSync(target, "utf8"), "original");
  assert.equal(service.apply(plan.id), 1);
  assert.equal(fs.readFileSync(target, "utf8"), "shared 中文");
  const backup = service.backups()[0];
  assert.equal(backup.files, 1);
  const restore = service.restore(backup.id);
  assert.equal(restore.items[0].newText, "original");
  assert.equal(service.apply(restore.id), 1);
  assert.equal(fs.readFileSync(target, "utf8"), "original");
  assert.equal(service.verifyAudit().valid, true);
});

for (const changed of ["source", "target"] as const)
  test(`${changed} edit after preview aborts synchronization before writes`, (t) => {
    const { file, service } = fixture(t);
    const source = file("shared.md", "new"),
      target = file("target.md", "old");
    service.bind(null, "canonicalMemory", source);
    service.bind("claude", "memory", target);
    const plan = service.preview("memory", ["claude"]);
    fs.writeFileSync(changed === "source" ? source : target, "external edit");
    assert.throws(() => service.apply(plan.id), /预览后发生变化/);
    assert.equal(
      fs.readFileSync(target, "utf8"),
      changed === "target" ? "external edit" : "old",
    );
    assert.equal(service.backups().length, 0);
  });

test("preflight checks the entire batch before the first target write", (t) => {
  const { file, service } = fixture(t);
  const first = file("first.md", "first"),
    second = file("second.md", "second");
  service.bind(null, "canonicalMemory", file("shared.md", "new"));
  service.bind("claude", "memory", first);
  service.bind("trae", "memory", second);
  const plan = service.preview("memory", ["claude", "trae"]);
  fs.writeFileSync(second, "external edit");
  assert.throws(() => service.apply(plan.id), /变化/);
  assert.equal(fs.readFileSync(first, "utf8"), "first");
});

test("revoked authorization invalidates outstanding previews", (t) => {
  const { file, service } = fixture(t);
  const target = file("target.md", "old");
  service.bind(null, "canonicalMemory", file("shared.md", "new"));
  service.bind("claude", "memory", target);
  const plan = service.preview("memory", ["claude"]);
  service.clear("claude", "memory");
  assert.throws(() => service.apply(plan.id), /失效/);
  assert.equal(fs.readFileSync(target, "utf8"), "old");
});

test("a preview is single-use and generating another preview invalidates it", (t) => {
  const { file, service } = fixture(t);
  service.bind(null, "canonicalMemory", file("shared.md", "new"));
  service.bind("claude", "memory", file("target.md", "old"));
  const old = service.preview("memory", ["claude"]),
    current = service.preview("memory", ["claude"]);
  assert.throws(() => service.apply(old.id), /失效/);
  service.apply(current.id);
  assert.throws(() => service.apply(current.id), /失效/);
});

test("multiple agents cannot overwrite the same destination", (t) => {
  const { file, service } = fixture(t);
  const target = file("target.md", "old");
  service.bind(null, "canonicalMemory", file("shared.md", "new"));
  service.bind("claude", "memory", target);
  service.bind("trae", "memory", target);
  assert.throws(
    () => service.preview("memory", ["claude", "trae"]),
    /相同目标/,
  );
});

test("source and target skills cannot be identical or nested in either direction", (t) => {
  const { dir, file, service } = fixture(t);
  const source = dir("skills");
  const nested = dir("skills/nested");
  file("skills/SKILL.md", "new");
  service.bind(null, "canonicalSkills", source);
  for (const target of [source, nested]) {
    service.bind("claude", "skills", target);
    assert.throws(() => service.preview("skills", ["claude"]), /互相嵌套/);
  }
  service.bind(null, "canonicalSkills", nested);
  service.bind("claude", "skills", source);
  assert.throws(() => service.preview("skills", ["claude"]), /互相嵌套/);
});

test("overlapping skills targets with duplicate file destinations are rejected", (t) => {
  const { dir, file, service } = fixture(t);
  const source = dir("source"),
    first = dir("target"),
    second = dir("target/nested");
  file("source/SKILL.md", "root");
  file("source/nested/SKILL.md", "nested");
  service.bind(null, "canonicalSkills", source);
  service.bind("claude", "skills", first);
  service.bind("trae", "skills", second);
  assert.throws(
    () => service.preview("skills", ["claude", "trae"]),
    /相同目标/,
  );
});

test("skills copy text only and leave unrelated target files unchanged", (t) => {
  const { dir, file, service } = fixture(t);
  const source = dir("source"),
    target = dir("target");
  file("source/demo/SKILL.md", "new skill");
  file("source/demo/script.ps1", "unsafe");
  file("target/unrelated.md", "keep");
  service.bind(null, "canonicalSkills", source);
  service.bind("claude", "skills", target);
  const plan = service.preview("skills", ["claude"]);
  assert.equal(plan.items.length, 1);
  assert.match(plan.skipped[0], /排除/);
  service.apply(plan.id);
  assert.equal(
    fs.readFileSync(path.join(target, "demo/SKILL.md"), "utf8"),
    "new skill",
  );
  assert.equal(fs.existsSync(path.join(target, "demo/script.ps1")), false);
  assert.equal(
    fs.readFileSync(path.join(target, "unrelated.md"), "utf8"),
    "keep",
  );
});

test("a destination directory swapped for a junction after preview is rejected", (t) => {
  const { dir, file, root, service } = fixture(t);
  const source = dir("source"),
    target = dir("target"),
    outside = dir("outside");
  file("source/demo/SKILL.md", "new");
  file("target/demo/SKILL.md", "old");
  file("outside/SKILL.md", "outside");
  service.bind(null, "canonicalSkills", source);
  service.bind("claude", "skills", target);
  const plan = service.preview("skills", ["claude"]);
  fs.renameSync(path.join(target, "demo"), path.join(root, "original-demo"));
  fs.symlinkSync(
    outside,
    path.join(target, "demo"),
    process.platform === "win32" ? "junction" : "dir",
  );
  assert.throws(() => service.apply(plan.id), /junction|链接/);
  assert.equal(
    fs.readFileSync(path.join(outside, "SKILL.md"), "utf8"),
    "outside",
  );
});

test("protected data and application paths cannot be authorized as writable targets", (t) => {
  const { file, dir, service } = fixture(t);
  assert.throws(
    () => service.bind("claude", "memory", file("protected/memory.md")),
    /不能写入/,
  );
  assert.throws(
    () => service.bind("claude", "skills", dir("storage/skills")),
    /不能写入/,
  );
});

test("tampered backup content prevents restore", (t) => {
  const { file, service } = fixture(t);
  service.bind("claude", "memory", file("target.md"));
  service.backup("claude");
  const backup = service.backups()[0];
  fs.writeFileSync(
    path.join(service.storage, "backups", backup.id, "0.txt"),
    "tampered",
  );
  assert.throws(() => service.restore(backup.id), /校验失败/);
});

test("backup restoration requires current authorization", (t) => {
  const { file, service } = fixture(t);
  service.bind("claude", "memory", file("target.md"));
  service.backup("claude");
  const backup = service.backups()[0];
  service.clear("claude", "memory");
  assert.throws(() => service.restore(backup.id), /授权/);
});

test("malformed backup metadata is omitted without breaking snapshots", (t) => {
  const { file, service } = fixture(t);
  service.bind("claude", "memory", file("target.md"));
  service.backup("claude");
  const backup = service.backups()[0];
  const manifest = path.join(
    service.storage,
    "backups",
    backup.id,
    "manifest.json",
  );
  const data = JSON.parse(fs.readFileSync(manifest, "utf8"));
  data.at = 123;
  fs.writeFileSync(manifest, JSON.stringify(data));
  assert.equal(service.snapshot().backups.length, 0);
  assert.throws(() => service.restore(backup.id), /清单损坏/);
});

test("backup traversal entries and invalid identifiers are rejected", (t) => {
  const { file, service } = fixture(t);
  service.bind("claude", "memory", file("target.md"));
  service.backup("claude");
  const backup = service.backups()[0];
  const manifest = path.join(
    service.storage,
    "backups",
    backup.id,
    "manifest.json",
  );
  const data = JSON.parse(fs.readFileSync(manifest, "utf8"));
  data.entries[0].file = "../secret.md";
  fs.writeFileSync(manifest, JSON.stringify(data));
  assert.throws(() => service.restore(backup.id), /条目无效/);
  assert.throws(() => service.restore("../secret"), /ID/);
});

test("audit chain detects changed rows and blocks writes, backups and authorization changes", (t) => {
  const { file, service } = fixture(t);
  const target = file("target.md", "old"),
    second = file("second.md", "second");
  service.bind(null, "canonicalMemory", file("shared.md", "new"));
  service.bind("claude", "memory", target);
  const plan = service.preview("memory", ["claude"]);
  const configBefore = fs.readFileSync(
    path.join(service.storage, "config.json"),
    "utf8",
  );
  const log = path.join(service.storage, "activity.jsonl");
  const lines = fs.readFileSync(log, "utf8").trim().split("\n");
  const row = JSON.parse(lines[0]);
  row.detail = "tampered";
  lines[0] = JSON.stringify(row);
  fs.writeFileSync(log, lines.join("\n") + "\n");
  assert.equal(service.verifyAudit().valid, false);
  assert.equal(service.snapshot().auditValid, false);
  assert.throws(() => service.apply(plan.id), /台账/);
  assert.throws(() => service.backup("claude"), /台账/);
  assert.throws(() => service.bind("claude", "memory", second), /台账/);
  assert.throws(() => service.clear("claude", "memory"), /台账/);
  assert.equal(fs.readFileSync(target, "utf8"), "old");
  assert.equal(
    fs.readFileSync(path.join(service.storage, "config.json"), "utf8"),
    configBefore,
  );
  assert.equal(service.settings("claude").memory, target);
});

test("audit chain detects removed or reordered interior entries", (t) => {
  const { service } = fixture(t);
  service.audit("one", "1");
  service.audit("two", "2");
  service.audit("three", "3");
  const log = path.join(service.storage, "activity.jsonl"),
    lines = fs.readFileSync(log, "utf8").trim().split("\n");
  fs.writeFileSync(log, [lines[0], lines[2]].join("\n") + "\n");
  assert.equal(service.verifyAudit().valid, false);
  fs.writeFileSync(log, [lines[1], lines[0], lines[2]].join("\n") + "\n");
  assert.equal(service.verifyAudit().valid, false);
});

test("a multi-file failure retains complete pre-write snapshots and is recoverable", (t) => {
  const { file, dir, service } = fixture(t);
  const source = dir("source"),
    target = dir("target");
  file("source/a.md", "new a");
  file("source/b.md", "new b");
  const a = file("target/a.md", "old a"),
    b = file("target/b.md", "old b");
  service.bind(null, "canonicalSkills", source);
  service.bind("claude", "skills", target);
  const plan = service.preview("skills", ["claude"]);
  const original = fs.renameSync;
  const mock = t.mock.method(fs, "renameSync", ((
    oldPath: fs.PathLike,
    newPath: fs.PathLike,
  ) => {
    if (String(newPath) === b) throw new Error("injected second-file failure");
    return original(oldPath, newPath);
  }) as typeof fs.renameSync);
  assert.throws(() => service.apply(plan.id), /second-file failure/);
  mock.mock.restore();
  assert.equal(fs.readFileSync(a, "utf8"), "new a");
  assert.equal(fs.readFileSync(b, "utf8"), "old b");
  const backup = service.backups()[0];
  assert.equal(backup.files, 2);
  assert.equal(service.verifyAudit().rows.at(-1)?.action, "sync.failed");
  const restore = service.restore(backup.id);
  assert.equal(restore.items.length, 1);
  service.apply(restore.id);
  assert.equal(fs.readFileSync(a, "utf8"), "old a");
  assert.equal(fs.readFileSync(b, "utf8"), "old b");
  assert.equal(service.verifyAudit().valid, true);
});

test("restore clearly preserves files created after the snapshot", (t) => {
  const { file, dir, service } = fixture(t);
  const target = dir("target");
  const original = file("target/a.md", "old");
  service.bind("claude", "skills", target);
  service.backup("claude");
  const id = service.backups()[0].id;
  fs.writeFileSync(original, "modified");
  const added = file("target/new.md", "keep");
  const plan = service.restore(id);
  assert.match(plan.skipped[0], /不会删除/);
  service.apply(plan.id);
  assert.equal(fs.readFileSync(added, "utf8"), "keep");
});
