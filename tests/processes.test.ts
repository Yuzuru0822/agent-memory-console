import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Processes } from "../electron/processes";
import { fixture, peFixture } from "./helpers";

test("process launch requires explicitly approved executable and workspace", (t) => {
  const { file, service } = fixture(t);
  file("home/.local/bin/claude.exe", peFixture());
  const processes = new Processes(service);
  assert.throws(() => processes.validate("claude", "hello"), /授权/);
  assert.deepEqual(processes.active(), []);
});

test("CLI task validation rejects blank and oversized input", (t) => {
  const { file, dir, service } = fixture(t);
  service.bind("claude", "executable", file("claude.exe", peFixture()));
  service.bind("claude", "workspace", dir("workspace"));
  const processes = new Processes(service);
  for (const prompt of [undefined, "", "   ", "x".repeat(16001)])
    assert.throws(() => processes.validate("claude", prompt), /1–16000/);
  assert.equal(
    processes.validate("claude", "A valid task").adapter.id,
    "claude",
  );
  assert.deepEqual(processes.active(), []);
});

test("executable format is revalidated after path authorization", (t) => {
  const { file, dir, service } = fixture(t);
  const exe = file("claude.exe", peFixture());
  service.bind("claude", "executable", exe);
  service.bind("claude", "workspace", dir("workspace"));
  fs.writeFileSync(exe, "replaced with a script");
  assert.throws(() => new Processes(service).validate("claude", "hello"), /PE/);
});

test("stop cannot target unowned processes", (t) => {
  const { service } = fixture(t);
  const processes = new Processes(service);
  assert.throws(() => processes.stop("claude"), /控制台所属/);
  assert.deepEqual(processes.active(), []);
});

test("npm discovery grants nothing; approval selects safe entry and revocation removes it", (t) => {
  const { file, dir, service } = fixture(t);
  const base = "home/AppData/Roaming/npm";
  const cmd = file(base + "/claude.cmd", "@echo NEVER EXECUTE THIS & exit 99");
  file(base + "/node_modules/@anthropic-ai/claude-code/package.json", JSON.stringify({name:"@anthropic-ai/claude-code",version:"2.1.243",bin:{claude:"bin/claude.exe"}}));
  const entry = file(base + "/node_modules/@anthropic-ai/claude-code/bin/claude.exe", peFixture());
  assert.equal(service.npmCandidate()?.entry, entry);
  assert.equal(service.snapshot().agents.find(a=>a.id==="claude")!.executableApproved, false);
  const manager = new Processes(service);
  assert.throws(()=>manager.validate("claude","hello"), /授权/);
  service.bind("claude","executable",cmd);
  service.bind("claude","workspace",dir("workspace"));
  const launch = manager.validate("claude","hello & calc.exe");
  assert.equal(launch.executable,entry);
  assert.deepEqual(launch.args,["-p"]);
  assert.equal(service.settings("claude").executable,undefined);
  service.clear("claude","executable");
  assert.equal(service.settings("claude").claudeNpm,undefined);
  assert.throws(()=>manager.validate("claude","hello"), /授权/);
  assert.throws(()=>service.bind("trae","executable",cmd), /\.exe/);
  service.bind("claude","executable",cmd);
  service.bind("claude","executable",file("native.exe",peFixture()));
  assert.equal(service.settings("claude").claudeNpm,undefined);
});

test("legacy npm launch pins Node and script, and rejects changed package entry", (t) => {
  const { file, dir, service } = fixture(t);
  const cmd = file("npm path & spaces/claude.cmd", "not executed");
  const pkg = "npm path & spaces/node_modules/@anthropic-ai/claude-code/";
  const metadata = file(pkg+"package.json", JSON.stringify({name:"@anthropic-ai/claude-code",version:"1.0.0",bin:{claude:"cli.js"}}));
  const entry = file(pkg+"cli.js", "console.log('fixture');");
  const node = file("npm path & spaces/node.exe",peFixture());
  service.bind("claude","executable",cmd);
  service.bind("claude","workspace",dir("workspace"));
  const manager = new Processes(service);
  const launch = manager.validate("claude","hello");
  assert.equal(launch.executable,node);
  assert.deepEqual(launch.args,[entry,"-p"]);
  file(pkg+"bin/claude.exe",peFixture());
  fs.writeFileSync(metadata,JSON.stringify({name:"@anthropic-ai/claude-code",version:"2.0.0",bin:{claude:"bin/claude.exe"}}));
  assert.throws(()=>manager.validate("claude","hello"), /授权|变化|改变/);
  // A manifest cannot turn arbitrary script content into a command line.
  fs.writeFileSync(metadata,JSON.stringify({name:"@anthropic-ai/claude-code",version:"2.0.0",bin:{claude:"../../calc.exe"}}));
  assert.throws(()=>manager.validate("claude","hello"));
});
