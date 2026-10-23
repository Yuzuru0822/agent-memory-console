import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  discoverClaudeNpm,
  npmDiscoveryPaths,
  resolveClaudeNpm,
  validateClaudeNpm,
  type NpmDiscoveryOptions,
} from "../electron/claude-npm";

// These are format fixtures, never executable programs or a real user install.
function peFixture() {
  const bytes = Buffer.alloc(128);
  bytes.write("MZ");
  bytes.writeUInt32LE(64, 60);
  bytes.write("PE\0\0", 64);
  bytes.writeUInt16LE(0x8664, 68);
  bytes.writeUInt16LE(0x0002, 86);
  bytes.writeUInt16LE(0x20b, 88);
  return bytes;
}

function fixture(t: TestContext, layout: "native" | "node" = "native") {
  const temporary = path.resolve(os.tmpdir());
  const root = fs.mkdtempSync(path.join(temporary, "agent-console-npm-test-"));
  const file = (relative: string, content: string | Buffer) => {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
    return target;
  };
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), temporary);
    assert.ok(path.basename(root).startsWith("agent-console-npm-test-"));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const prefix = path.join(root, "npm prefix & (local) !");
  const packageRoot = path.join(prefix, "node_modules", "@anthropic-ai", "claude-code");
  const packageJson = path.join(packageRoot, "package.json");
  const metadata: Record<string, unknown> = {
    name: "@anthropic-ai/claude-code",
    version: "2.1.243",
    bin: { claude: layout === "native" ? "bin/claude.exe" : "cli.js" },
  };
  const writeMetadata = () => {
    fs.mkdirSync(packageRoot, { recursive: true });
    fs.writeFileSync(packageJson, JSON.stringify(metadata));
  };
  const marker = path.join(root, "SHOULD-NOT-EXIST.txt");
  const launcher = file(path.relative(root, path.join(prefix, "claude.cmd")), `@echo PWNED > "${marker}"\r\n`);
  writeMetadata();
  const entry = file(path.relative(root, path.join(packageRoot, layout === "native" ? "bin/claude.exe" : "cli.js")), layout === "native" ? peFixture() : "throw new Error('Discovery must never execute this CLI');\n");
  const node = file("runtime/node.exe", peFixture());
  const options: NpmDiscoveryOptions = { prefixes: [prefix], nodeCandidates: [node] };
  return { root, file, prefix, packageRoot, packageJson, metadata, writeMetadata, marker, launcher, entry, node, options };
}

test("npm native layout resolves custom prefix with spaces and metacharacters without invoking launcher", (t) => {
  const f = fixture(t);
  const installed = resolveClaudeNpm(f.launcher, f.options);
  assert.deepEqual(installed, {
    launcher: f.launcher,
    packageJson: f.packageJson,
    packageVersion: "2.1.243",
    entry: f.entry,
    kind: "native",
  });
  assert.equal(fs.existsSync(f.marker), false);
  assert.match(fs.readFileSync(f.launcher, "utf8"), /PWNED/);
});

test("legacy npm CLI accepts UTF-8 bundle larger than memory-file limit and a canonical Node runtime", (t) => {
  const f = fixture(t, "node");
  fs.writeFileSync(f.entry, `// ${"a".repeat(1024 * 1024)}\nconsole.log('中文');`);
  const installed = resolveClaudeNpm(f.launcher, f.options);
  assert.equal(installed.kind, "node");
  assert.equal(installed.node, fs.realpathSync(f.node));
  assert.equal(installed.entry, f.entry);
  assert.equal(fs.existsSync(f.marker), false);
});

test("legacy Node beside launcher has priority over explicit runtime candidates", (t) => {
  const f = fixture(t, "node");
  const adjacent = f.file(path.relative(f.root, path.join(f.prefix, "node.exe")), peFixture());
  assert.equal(resolveClaudeNpm(f.launcher, f.options).node, adjacent);
});

test("legacy npm CLI without a valid node.exe is rejected", (t) => {
  const f = fixture(t, "node");
  assert.throws(() => resolveClaudeNpm(f.launcher, { ...f.options, nodeCandidates: [] }), /node\.exe/);
  fs.writeFileSync(f.node, "not an executable");
  assert.throws(() => resolveClaudeNpm(f.launcher, f.options), /node\.exe/);
});

test("npm locator rejects other scripts, relative paths, UNC paths, and command strings", (t) => {
  const f = fixture(t);
  for (const candidate of [
    path.join(f.prefix, "other.cmd"), "claude.cmd", "\\\\server\\share\\claude.cmd",
    `${f.launcher} & echo unsafe`,
  ]) assert.throws(() => resolveClaudeNpm(candidate, f.options));
  assert.equal(fs.existsSync(f.marker), false);
});

test("npm metadata requires exact package identity, supported bin layout and a version", (t) => {
  const f = fixture(t);
  for (const bad of [
    { name: "claude-code" },
    { name: "@other/claude-code" },
    { version: "" },
    { version: "latest" },
    { bin: "cli.js" },
    { bin: { claude: "../cli.js" } },
    { bin: { claude: "bin/../../claude.exe" } },
    { bin: { claude: f.node } },
    { bin: { claude: "cli.js --unsafe" } },
    { bin: { claude: "bin/claude.cmd" } },
    { bin: { claude: "other.js" } },
  ]) {
    fs.writeFileSync(f.packageJson, JSON.stringify({ ...f.metadata, ...bad }));
    assert.throws(() => resolveClaudeNpm(f.launcher, f.options));
  }
});

test("known bin paths permit one explicit current-directory prefix", (t) => {
  const f = fixture(t);
  f.metadata.bin = { claude: "./bin/claude.exe" };
  f.writeMetadata();
  assert.equal(resolveClaudeNpm(f.launcher, f.options).entry, f.entry);
  f.metadata.bin = { claude: "././bin/claude.exe" };
  f.writeMetadata();
  assert.throws(() => resolveClaudeNpm(f.launcher, f.options), /入口布局/);
});

test("bounded metadata rejects invalid JSON, oversized metadata and malformed UTF-8", (t) => {
  const f = fixture(t);
  for (const content of ["{", "null", "[]", " ".repeat(64 * 1024 + 1), Buffer.from([0xc3, 0x28])]) {
    fs.writeFileSync(f.packageJson, content);
    assert.throws(() => resolveClaudeNpm(f.launcher, f.options));
  }
});

test("legacy CLI rejects empty, binary, malformed UTF-8 and over-32-MiB entries", (t) => {
  const f = fixture(t, "node");
  for (const content of ["", Buffer.from([0]), Buffer.from([0xc3, 0x28])]) {
    fs.writeFileSync(f.entry, content);
    assert.throws(() => resolveClaudeNpm(f.launcher, f.options));
  }
  fs.truncateSync(f.entry, 32 * 1024 * 1024 + 1);
  assert.throws(() => resolveClaudeNpm(f.launcher, f.options), /大小/);
});

test("npm validation allows in-place version updates after rechecking the executable", (t) => {
  const f = fixture(t);
  const approved = resolveClaudeNpm(f.launcher, f.options);
  f.metadata.version = "2.1.244";
  f.writeMetadata();
  const updated = validateClaudeNpm(approved, f.options);
  assert.equal(updated.packageVersion, "2.1.244");
  fs.writeFileSync(f.entry, "replaced with a script");
  assert.throws(() => validateClaudeNpm(approved, f.options), /PE/);
});

test("npm validation rejects changed entry kind and changed selected Node runtime", (t) => {
  const f = fixture(t);
  const approved = resolveClaudeNpm(f.launcher, f.options);
  f.metadata.bin = { claude: "cli.js" };
  f.file(path.relative(f.root, path.join(f.packageRoot, "cli.js")), "console.log('test');");
  f.writeMetadata();
  assert.throws(() => validateClaudeNpm(approved, f.options), /重新选择/);
  const nodeApproval = resolveClaudeNpm(f.launcher, f.options);
  const otherNode = f.file("other-runtime/node.exe", peFixture());
  assert.throws(() => validateClaudeNpm(nodeApproval, { ...f.options, nodeCandidates: [otherNode] }), /重新选择/);
});

test("outer prefix and nvm Node junctions canonicalize while retaining the selected locator", (t) => {
  const f = fixture(t, "node");
  const prefixAlias = path.join(f.root, "npm alias");
  const nodeAlias = path.join(f.root, "nvm symlink");
  const linkType = process.platform === "win32" ? "junction" : "dir";
  fs.symlinkSync(f.prefix, prefixAlias, linkType);
  fs.symlinkSync(path.dirname(f.node), nodeAlias, linkType);
  const launcher = path.join(prefixAlias, "claude.cmd");
  const installation = resolveClaudeNpm(launcher, { prefixes: [prefixAlias], nodeCandidates: [path.join(nodeAlias, "node.exe")] });
  assert.equal(installation.launcher, launcher);
  assert.equal(installation.entry, f.entry);
  assert.equal(installation.node, f.node);
  assert.equal(validateClaudeNpm(installation, f.options).entry, f.entry);
});

test("package junctions are rejected even when they point to a valid package", (t) => {
  const f = fixture(t);
  const otherPrefix = path.join(f.root, "other prefix");
  const launcher = f.file("other prefix/claude.cmd", "@echo ignored\r\n");
  const scope = path.join(otherPrefix, "node_modules", "@anthropic-ai");
  fs.mkdirSync(scope, { recursive: true });
  fs.symlinkSync(f.packageRoot, path.join(scope, "claude-code"), process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => resolveClaudeNpm(launcher, f.options), /链接|junction/);
});

test("entry-directory junctions are rejected", (t) => {
  const f = fixture(t);
  const actual = path.join(f.root, "actual-bin");
  fs.mkdirSync(actual);
  fs.renameSync(f.entry, path.join(actual, "claude.exe"));
  fs.rmdirSync(path.dirname(f.entry));
  fs.symlinkSync(actual, path.dirname(f.entry), process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => resolveClaudeNpm(f.launcher, f.options), /链接|junction/);
});

test("validation detects a redirected outer prefix junction", (t) => {
  const f = fixture(t);
  const alias = path.join(f.root, "prefix link");
  const type = process.platform === "win32" ? "junction" : "dir";
  fs.symlinkSync(f.prefix, alias, type);
  const approved = resolveClaudeNpm(path.join(alias, "claude.cmd"), f.options);
  const replacement = path.join(f.root, "replacement prefix");
  fs.cpSync(f.prefix, replacement, { recursive: true });
  fs.unlinkSync(alias);
  fs.symlinkSync(replacement, alias, type);
  assert.throws(() => validateClaudeNpm(approved, f.options), /重新选择/);
});

test("environment candidate discovery is bounded and ignores unsafe or relative paths", (t) => {
  const f = fixture(t);
  const home = path.join(f.root, "home");
  const appdata = path.join(home, "AppData", "Roaming");
  const many = Array.from({ length: 130 }, (_, n) => path.join(f.root, `path-${n}`));
  const options = npmDiscoveryPaths(home, {
    npm_config_prefix: f.prefix,
    NPM_CONFIG_PREFIX: "relative-prefix",
    APPDATA: appdata,
    NVM_SYMLINK: path.join(f.root, "nvm"),
    PATH: ["relative", "\\\\server\\share", ...many].join(path.delimiter),
  });
  assert.equal(options.prefixes[0], f.prefix);
  assert.ok(options.prefixes.includes(path.join(appdata, "npm")));
  assert.ok(options.prefixes.length <= 131);
  assert.ok(!options.prefixes.includes(many[129]));
  assert.ok(options.prefixes.every((candidate) => path.isAbsolute(candidate) && !candidate.startsWith("\\\\")));
  assert.ok(options.nodeCandidates.every((candidate) => path.basename(candidate) === "node.exe"));
  assert.deepEqual(npmDiscoveryPaths(home, {}).prefixes, [path.join(home, "AppData", "Roaming", "npm")]);
});

test("discovery skips invalid candidates, returns a valid installation, and makes no writes or grants", (t) => {
  const f = fixture(t);
  const before = fs.readFileSync(f.launcher);
  const options = { ...f.options, prefixes: ["relative", path.join(f.root, "missing"), f.prefix] };
  const found = discoverClaudeNpm(options)!;
  assert.equal(found.entry, f.entry);
  assert.equal("approved" in found, false);
  assert.deepEqual(fs.readFileSync(f.launcher), before);
  assert.equal(fs.existsSync(f.marker), false);
  assert.equal(discoverClaudeNpm({ prefixes: [path.join(f.root, "missing")], nodeCandidates: [] }), undefined);
});
