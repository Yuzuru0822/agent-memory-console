import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import git from "isomorphic-git";
import { fixture } from "./helpers";
import { commitRepository, initRepository, readRevision, repositoryStatus } from "../electron/repository-git";

test("hundreds of skill edits and deletions rewrite the Git index per batch, preserving history and scope", async t => {
  const { dir, file } = fixture(t), root = dir("repository");
  await initRepository(root);
  for (let i = 0; i < 500; i++) file(`repository/skills/bundle/${i}.txt`, `original ${i}\n`);
  const metadata = file("repository/skills/bundle/.git/config", "[core]\n\tbare = false\n");
  const unrelated = file("repository/private.txt", "keep outside central Git");
  const originalWrite = fs.writeFileSync;
  let indexWrites = 0;
  t.mock.method(fs, "writeFileSync", (...args: Parameters<typeof fs.writeFileSync>) => {
    if (typeof args[0] === "string" && /[\\/]\.git[\\/]index(?:\.lock)?$/.test(args[0])) indexWrites++;
    return originalWrite(...args);
  });
  const imported = await commitRepository(root, "Import 500 skills in batches");
  assert.equal(indexWrites, 2, "500 tiny files need two index writes, not 500");
  assert.equal((await git.listFiles({ fs, dir: root })).length, 502);
  assert.equal((await repositoryStatus(root)).dirty, 0);

  // Another caller may change ordinary files between operations. No stale
  // content or index cache may hide these changes from the next commit.
  for (let i = 0; i < 200; i++) file(`repository/skills/bundle/${i}.txt`, `edited ${i}\n`);
  for (let i = 200; i < 400; i++) fs.unlinkSync(path.join(root, "skills", "bundle", `${i}.txt`));
  for (let i = 500; i < 600; i++) file(`repository/skills/bundle/${i}.txt`, `new ${i}\n`);
  indexWrites = 0;
  const changed = await commitRepository(root, "Record many edits, additions and local deletions");
  assert.equal(indexWrites, 3, "one removal and two bounded add batches");
  const tracked = await git.listFiles({ fs, dir: root });
  assert.equal(tracked.length, 402);
  assert.ok(!tracked.includes("skills/bundle/300.txt"));
  assert.ok(!tracked.includes("private.txt"));
  assert.ok(tracked.every(name => !name.split("/").includes(".git")));
  assert.equal((await readRevision(root, imported.oid, "skills/bundle/300.txt")).toString(), "original 300\n");
  assert.equal((await readRevision(root, changed.oid, "skills/bundle/1.txt")).toString(), "edited 1\n");
  assert.equal((await readRevision(root, changed.oid, "skills/bundle/599.txt")).toString(), "new 599\n");
  assert.equal(fs.readFileSync(metadata, "utf8"), "[core]\n\tbare = false\n");
  assert.equal(fs.readFileSync(unrelated, "utf8"), "keep outside central Git");
  assert.equal((await repositoryStatus(root)).dirty, 0);
  indexWrites = 0;
  assert.deepEqual(await commitRepository(root, "No redundant history"), { oid: changed.oid, changed: false });
  assert.equal(indexWrites, 0);
});

test("Git staging bounds batch bytes as well as file count", async t => {
  const { dir, file } = fixture(t), root = dir("repository");
  await initRepository(root);
  for (let i = 0; i < 9; i++) file(`repository/skills/assets/${i}.bin`, Buffer.alloc(2 * 1024 * 1024, i));
  const originalWrite = fs.writeFileSync;
  let indexWrites = 0;
  t.mock.method(fs, "writeFileSync", (...args: Parameters<typeof fs.writeFileSync>) => {
    if (typeof args[0] === "string" && /[\\/]\.git[\\/]index(?:\.lock)?$/.test(args[0])) indexWrites++;
    return originalWrite(...args);
  });
  const committed = await commitRepository(root, "Bound parallel binary content");
  assert.equal(indexWrites, 2, "18 MiB is staged in two batches of at most 16 MiB");
  assert.deepEqual(await readRevision(root, committed.oid, "skills/assets/8.bin"), Buffer.alloc(2 * 1024 * 1024, 8));
  assert.equal((await repositoryStatus(root)).dirty, 0);
});
