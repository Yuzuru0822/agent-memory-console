import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
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
