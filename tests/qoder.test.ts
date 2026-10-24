import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import git from "isomorphic-git";
import { createAdapters } from "../electron/adapters";
import { qoderExecutableCandidates } from "../electron/qoder";
import { ConsoleService } from "../electron/service";
import { Processes } from "../electron/processes";
import { RepositoryService } from "../electron/repository-service";
import { fixture, peFixture } from "./helpers";
import type { AgentConfig, AgentId } from "../src/shared";

const read = (file: string) => fs.readFileSync(file, "utf8");

// Compare every byte and empty directory, including ignored files and Git metadata.
function tree(root: string): string[] {
  const result: string[] = [];
  const walk = (relative: string) => {
    for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const child = path.join(relative, entry.name);
      assert.equal(entry.isSymbolicLink(), false);
      if (entry.isDirectory()) { result.push(`dir:${child}`); walk(child); }
      else result.push(`file:${child}:${crypto.createHash("sha256").update(fs.readFileSync(path.join(root, child))).digest("hex")}`);
    }
  };
  walk(""); return result;
}

test("Qoder discovers documented skills, CLI static memory and either IDE executable without granting access", t => {
  const f = fixture(t), memory = f.file("home/.qoder/AGENTS.md", "# User instructions\n");
  const skill = f.file("home/.qoder/skills/review/SKILL.md", "# Review\n");
  const current = f.file("local/Programs/Qoder IDE/Qoder IDE.exe", peFixture());
  const previous = f.file("local/Programs/Qoder/Qoder.exe", peFixture());
  const adapter = f.service.adapter("qoder");
  assert.equal(adapter.integration, "documented"); assert.equal(adapter.mode, "desktop");
  assert.deepEqual(adapter.memory, [memory]); assert.deepEqual(adapter.skills, [path.dirname(path.dirname(skill))]);
  assert.match(adapter.note, /CLI.*静态/); assert.match(adapter.note, /IDE.*自动记忆/);
  let view = f.service.snapshot().agents.find(agent => agent.id === "qoder")!;
  assert.equal(view.memory.path, memory); assert.equal(view.memory.exists, true);
  assert.equal(view.skills.count, 1); assert.equal(view.executable, current);
  assert.equal(view.memoryApproved, false); assert.equal(view.skillsApproved, false); assert.equal(view.executableApproved, false);
  assert.deepEqual(f.service.settings("qoder"), {});
  assert.throws(() => new Processes(f.service).validate("qoder"), /授权/);
  fs.unlinkSync(current);
  view = f.service.snapshot().agents.find(agent => agent.id === "qoder")!;
  assert.equal(view.executable, previous); assert.equal(view.executableApproved, false);
});

test("Qoder detects Program Files and PATH bin-parent installations without interpreting command shims", t => {
  const f = fixture(t), local = f.dir("local"), programFiles = f.dir("program-files"), x86 = f.dir("program-files-x86");
  const bin = f.dir("custom IDE/bin");
  f.file("custom IDE/bin/qoder.cmd", "@echo This shim must never run\nexit /b 99\n");
  const executable = f.file("custom IDE/Qoder IDE.exe", peFixture());
  const environment = { ProgramFiles: programFiles, "ProgramFiles(x86)": x86, Path: `"${bin}"${path.delimiter}${bin}` };
  const candidates = qoderExecutableCandidates(local, environment);
  for (const expected of [
    path.join(local, "Programs/Qoder IDE/Qoder IDE.exe"), path.join(local, "Programs/Qoder/Qoder.exe"),
    path.join(programFiles, "Qoder IDE/Qoder IDE.exe"), path.join(x86, "Qoder/Qoder.exe"),
    path.join(bin, "Qoder.exe"), executable,
  ]) assert.ok(candidates.includes(expected), `missing candidate ${expected}`);
  assert.equal(candidates.length, new Set(candidates.map(value => process.platform === "win32" ? value.toLowerCase() : value)).size);
  assert.equal(candidates.some(candidate => candidate.endsWith(".cmd")), false);
  const service = new ConsoleService(f.dir("custom-storage"), createAdapters(path.join(f.root, "home"), local, environment));
  assert.equal(service.paths("qoder").executable, executable);
  assert.equal(service.snapshot().agents.find(agent => agent.id === "qoder")!.executableApproved, false);
});

test("Qoder PATH discovery stops at 128 entries and excludes relative, network and device paths", t => {
  const f = fixture(t), local = f.dir("local");
  const entries = Array.from({ length: 129 }, (_, i) => path.join(f.root, `install-${i}`));
  const candidates = qoderExecutableCandidates(local, { PATH: entries.join(path.delimiter) });
  assert.ok(candidates.includes(path.join(entries[127], "Qoder.exe")));
  assert.equal(candidates.includes(path.join(entries[128], "Qoder.exe")), false);
  const defaults = qoderExecutableCandidates(local, {});
  const rejected = ["relative/bin", "", "\\\\server\\share\\bin", "\\\\?\\C:\\device\\bin"];
  assert.deepEqual(qoderExecutableCandidates(local, { PATH: rejected.join(path.delimiter) }), defaults);
});

test("legacy six-agent version-1 configurations reload unchanged with Qoder initially unapproved", t => {
  const f = fixture(t), ids: AgentId[] = ["workbuddy", "trae", "claude", "qwen", "zcode", "deepseek"];
  const agents: Partial<Record<AgentId, AgentConfig>> = {};
  for (const id of ids) agents[id] = { memory: f.file(`legacy/${id}/MEMORY.md`, `${id} original`), workspace: f.dir(`legacy/${id}/workspace`) };
  const raw = JSON.stringify({ version: 1, agents }, null, 2), config = f.file("legacy-storage/config.json", raw);
  f.file("home/.qoder/AGENTS.md", "newly discovered");
  const service = new ConsoleService(path.dirname(config), createAdapters(path.join(f.root, "home"), path.join(f.root, "local")));
  for (const id of ids) assert.deepEqual(service.settings(id), agents[id]);
  const snapshot = service.snapshot(); assert.equal(snapshot.agents.length, 7);
  assert.deepEqual(service.settings("qoder"), {}); assert.equal(service.config.agents.qoder, undefined);
  const qoder = snapshot.agents.find(agent => agent.id === "qoder")!;
  assert.equal(qoder.memory.exists, true); assert.equal(qoder.memoryApproved, false); assert.equal(qoder.skillsApproved, false);
  assert.equal(read(config), raw);
});

test("Qoder authorized memory folders sync multiple documents and preserve either side after deletion", async t => {
  const f = fixture(t), repository = new RepositoryService(f.service), central = f.dir("central");
  const memories = f.dir("project/.qoder-memory");
  const instructions = f.file("project/.qoder-memory/AGENTS.md", "project instructions\n");
  const rule = f.file("project/.qoder-memory/rules/review.md", "review rules\n");
  const context = f.file("project/.qoder-memory/context.json", '{"project":"qoder"}\n');
  f.file("project/.qoder-memory/ignored.exe", peFixture());
  const unrelated = f.file("home/.qoder/AGENTS.md", "CLI static instructions remain separate\n");
  await repository.choose(central); repository.members(["qoder"]); repository.memoryFolder("qoder", memories);
  const plan = await repository.preview(); assert.equal(plan.files.length, 3);
  assert.ok(plan.files.every(file => file.agent === "qoder" && file.kind === "memory"));
  assert.equal(await repository.apply(plan.id), 3);
  const remoteRoot = path.join(central, "memories/qoder"), remoteRule = path.join(remoteRoot, "rules/review.md");
  assert.equal(read(path.join(remoteRoot, "AGENTS.md")), read(instructions)); assert.equal(read(remoteRule), read(rule));
  assert.equal(read(path.join(remoteRoot, "context.json")), read(context)); assert.equal(fs.existsSync(path.join(remoteRoot, "ignored.exe")), false);
  fs.unlinkSync(rule); await repository.apply((await repository.preview()).id);
  assert.equal(read(rule), "review rules\n"); assert.equal(read(remoteRule), "review rules\n");
  fs.unlinkSync(path.join(remoteRoot, "context.json")); await repository.apply((await repository.preview()).id);
  assert.equal(read(path.join(remoteRoot, "context.json")), read(context));
  fs.writeFileSync(remoteRule, "updated centrally\n"); await repository.apply((await repository.preview()).id);
  assert.equal(read(rule), "updated centrally\n"); assert.equal(read(unrelated), "CLI static instructions remain separate\n");
  assert.equal((await repository.preview()).files.length, 0);
});

test("Qoder skills junction import and unlink preserve complete Git history, ignored assets and original bytes", async t => {
  const f = fixture(t), repository = new RepositoryService(f.service), central = f.dir("central");
  const skills = f.dir("home/.qoder/skills"), bundle = f.dir("home/.qoder/skills/review");
  await git.init({ fs, dir: bundle, defaultBranch: "main" });
  const skill = f.file("home/.qoder/skills/review/SKILL.md", "# Review version 1\n");
  const author = { name: "Fixture", email: "fixture@example.invalid" };
  await git.add({ fs, dir: bundle, filepath: "SKILL.md" });
  const first = await git.commit({ fs, dir: bundle, message: "initial skill", author });
  fs.writeFileSync(skill, "# Review version 2\n"); await git.add({ fs, dir: bundle, filepath: "SKILL.md" });
  const second = await git.commit({ fs, dir: bundle, message: "improve skill", author });
  f.file("home/.qoder/skills/review/.gitignore", "assets/ignored.bin\n");
  f.file("home/.qoder/skills/review/assets/ignored.bin", Buffer.from([0, 255, 12, 1]));
  f.file("home/.qoder/skills/review/scripts/run.ps1", "throw 'fixture must never execute'\n");
  f.file("home/.qoder/skills/review/.git/hooks/post-commit", "#!/bin/sh\nexit 99 # Preserve only; never execute.\n");
  f.dir("home/.qoder/skills/review/.git/empty-metadata"); f.dir("home/.qoder/skills/review/empty-assets");
  const before = tree(skills);
  f.service.bind("qoder", "skills", skills); await repository.choose(central); repository.members(["qoder"]);
  const plan = repository.linkPreview("qoder");
  assert.equal(plan.agent, "qoder"); assert.equal(plan.source, skills); assert.equal(plan.alreadyLinked, false);
  assert.ok(plan.files.some(file => file.relative.includes(".git") && file.localText === undefined));
  await repository.linkApply(plan.id, {});
  assert.equal(fs.lstatSync(skills).isSymbolicLink(), true);
  const target = path.join(central, "skills"); assert.equal(fs.realpathSync(skills), fs.realpathSync(target));
  assert.deepEqual(tree(target), before); assert.deepEqual(tree(plan.backupPath), before);
  assert.deepEqual((await git.log({ fs, dir: path.join(target, "review") })).map(commit => commit.oid), [second, first]);
  assert.equal(repository.unlinkReview("qoder").backupPath, plan.backupPath);
  assert.equal(f.service.snapshot().agents.find(agent => agent.id === "qoder")!.skillsApproved, true);
  await repository.unlink("qoder");
  assert.equal(fs.lstatSync(skills).isSymbolicLink(), false); assert.deepEqual(tree(skills), before); assert.deepEqual(tree(target), before);
  assert.deepEqual((await git.log({ fs, dir: bundle })).map(commit => commit.oid), [second, first]);
  assert.equal(fs.existsSync(plan.backupPath), false); assert.equal(f.service.settings("qoder").skillsAccess, undefined);
});

test("Qoder desktop validation requires approved native EXE and workspace, accepts no CLI flags, and rejects CMD", t => {
  const f = fixture(t), executable = f.file("local/Programs/Qoder IDE/Qoder IDE.exe", peFixture());
  const processes = new Processes(f.service);
  assert.throws(() => processes.validate("qoder"), /授权/);
  const cmd = f.file("qoder.cmd", "@echo never execute\n");
  assert.throws(() => f.service.bind("qoder", "executable", cmd), /\.exe/);
  assert.equal(f.service.settings("qoder").executable, undefined);
  f.service.bind("qoder", "executable", executable); assert.throws(() => processes.validate("qoder"), /授权/);
  const workspace = f.dir("workspace & spaces"); f.service.bind("qoder", "workspace", workspace);
  for (const prompt of [undefined, "", "--run-task & calc.exe"]) {
    const invocation = processes.validate("qoder", prompt);
    assert.equal(invocation.adapter.mode, "desktop"); assert.equal(invocation.executable, executable);
    assert.deepEqual(invocation.args, []); assert.equal(invocation.config.workspace, workspace);
  }
  fs.writeFileSync(executable, "not a PE executable anymore");
  assert.throws(() => processes.validate("qoder"), /PE/);
  assert.deepEqual(processes.active(), []); assert.deepEqual(processes.snapshot(), {});
});
