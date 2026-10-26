import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import git from "isomorphic-git";
import { fixture } from "./helpers";
import { McpShareService } from "../electron/mcp-share";
import { parseManifest, renderTemplate, strictJson } from "../electron/mcp-share-format";
import { RepositoryService } from "../electron/repository-service";
import { commitRepository, readRevision, repositoryStatus } from "../electron/repository-git";
import type { SecretCodec } from "../electron/private-store";
import type { McpBridgeDefinition, McpManifest } from "../src/mcp-types";

function codec(): SecretCodec {
  const key = crypto.randomBytes(32);
  return {
    seal(text) { const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv("aes-256-gcm", key, iv); const bytes = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), bytes]).toString("base64"); },
    open(encoded) { const bytes = Buffer.from(encoded, "base64"), decipher = crypto.createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12)); decipher.setAuthTag(bytes.subarray(12, 28)); return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8"); },
  };
}
const manifest = (servers: McpManifest["servers"]) => JSON.stringify({ version: 1, servers });
const template = { transport: "http" as const, url: "https://service.example/mcp", headers: { Authorization: "Bearer ${SERVICE_TOKEN}" } };
async function setup(t: TestContext) {
  const f = fixture(t), crypt = codec(), repository = new RepositoryService(f.service), repo = f.dir("repository");
  await repository.choose(repo);
  let now = Date.now();
  const share = new McpShareService(f.service, crypt, () => now);
  const target = f.file("client/config.json", JSON.stringify({ theme: "dark", mcpServers: { personal: { command: "private-client.exe" } } }));
  share.bind("claude", "claude", target);
  await share.saveTemplates(manifest({ shared: template }));
  share.setVariable("SERVICE_TOKEN", "private-value-never-in-git");
  return { ...f, crypt, repository, repo, share, target, advance: (ms: number) => { now += ms; } };
}

test("MCP merge preserves unrelated settings and servers, encrypts backups and rolls back exact bytes", async t => {
  const f = await setup(t), before = fs.readFileSync(f.target, "utf8");
  const plan = f.share.preview("claude", ["shared"]);
  assert.equal(plan.items[0].action, "add");
  assert.ok(!JSON.stringify(plan).includes("private-value"));
  f.share.apply(plan.id, []);
  const deployed = JSON.parse(fs.readFileSync(f.target, "utf8"));
  assert.equal(deployed.theme, "dark"); assert.deepEqual(deployed.mcpServers.personal, { command: "private-client.exe" });
  assert.equal(deployed.mcpServers.shared.type, "http");
  assert.equal(deployed.mcpServers.shared.headers.Authorization, "Bearer private-value-never-in-git");
  const privateBytes = fs.readFileSync(path.join(f.service.storage, "mcp-private.enc"), "utf8");
  assert.ok(!privateBytes.includes("private-value-never-in-git")); assert.ok(!privateBytes.includes("private-client.exe"));
  const snapshot = f.share.snapshot();
  assert.ok(!JSON.stringify(snapshot).includes("private-value-never-in-git")); assert.deepEqual(snapshot.variableNames, ["SERVICE_TOKEN"]);
  const reloaded = new McpShareService(f.service, f.crypt), saved = reloaded.getDeployment(snapshot.deployments[0].id);
  assert.ok(!("before" in saved)); assert.ok(!("afterHash" in saved));
  reloaded.rollback(saved.id); assert.equal(fs.readFileSync(f.target, "utf8"), before);
  assert.equal(reloaded.getDeployment(saved.id).rolledBack, true);
  assert.throws(() => reloaded.rollback(saved.id), /已经回滚/);
});

test("same-name conflicts remain unchanged unless individually selected; omitted servers are never deleted", async t => {
  const f = await setup(t);
  fs.writeFileSync(f.target, JSON.stringify({ other: 7, mcpServers: { shared: { url: "https://old.example/mcp" }, private: { env: { SECRET: "existing-private-secret" } } } }));
  await f.share.saveTemplates(manifest({ shared: template, additional: { transport: "stdio", command: "local-mcp.exe", args: ["--safe"] } }));
  let plan = f.share.preview("claude", ["shared", "additional"]);
  assert.deepEqual(plan.items.map(i => i.action), ["conflict", "add"]);
  assert.throws(() => f.share.apply(plan.id, ["additional"]), /覆盖列表/);
  f.share.apply(plan.id, []);
  let data = JSON.parse(fs.readFileSync(f.target, "utf8"));
  assert.equal(data.mcpServers.shared.url, "https://old.example/mcp"); assert.equal(data.mcpServers.additional.command, "local-mcp.exe");
  assert.equal(data.mcpServers.private.env.SECRET, "existing-private-secret");
  plan = f.share.preview("claude", ["shared"]); f.share.apply(plan.id, ["shared"]);
  data = JSON.parse(fs.readFileSync(f.target, "utf8")); assert.equal(data.other, 7); assert.ok(data.mcpServers.additional);
  assert.equal(data.mcpServers.shared.url, template.url);
  const same = f.share.preview("claude", ["shared"]), count = f.share.snapshot().deployments.length;
  assert.equal(same.items[0].action, "same"); f.share.apply(same.id, []); assert.equal(f.share.snapshot().deployments.length, count);
  await f.share.saveTemplates(manifest({})); assert.ok(JSON.parse(fs.readFileSync(f.target, "utf8")).mcpServers.shared);
});

test("binding an absent JSON does not create it; explicit rollback removes only the unchanged newly created file", async t => {
  const f = await setup(t), target = path.join(f.dir("new-client"), "config.json");
  f.share.bind("workbuddy", "workbuddy", target); assert.equal(fs.existsSync(target), false);
  const plan = f.share.preview("workbuddy", ["shared"]); f.share.apply(plan.id, []);
  assert.equal(JSON.parse(fs.readFileSync(target, "utf8")).mcpServers.shared.type, "streamableHttp");
  f.share.rollback(f.share.snapshot().deployments[0].id); assert.equal(fs.existsSync(target), false);
});

test("external edits invalidate native-confirmation metadata and deployment without overwriting", async t => {
  const f = await setup(t), plan = f.share.preview("claude", ["shared"]), changed = '{"changed":true}';
  fs.writeFileSync(f.target, changed);
  assert.throws(() => f.share.getPlan(plan.id), /预览后已变化/);
  assert.throws(() => f.share.apply(plan.id, []), /预览后已变化/);
  assert.equal(fs.readFileSync(f.target, "utf8"), changed); assert.equal(f.share.snapshot().deployments.length, 0);
});

test("template changes, variables, binding changes, expiry and explicit invalidation stale previews", async t => {
  const f = await setup(t);
  let plan = f.share.preview("claude", ["shared"]); f.share.setVariable("SERVICE_TOKEN", "rotated");
  assert.throws(() => f.share.getPlan(plan.id), /过期/);
  plan = f.share.preview("claude", ["shared"]); f.advance(120001); assert.throws(() => f.share.apply(plan.id, []), /过期/);
  plan = f.share.preview("claude", ["shared"]); f.share.invalidatePlans(); assert.throws(() => f.share.apply(plan.id, []), /过期/);
  plan = f.share.preview("claude", ["shared"]);
  fs.writeFileSync(path.join(f.repo, "mcp", "servers.json"), manifest({ shared: { ...template, url: "https://changed.example/mcp" } }));
  assert.throws(() => f.share.getPlan(plan.id), /已变化/);
  plan = f.share.preview("claude", ["shared"]); f.share.bind("claude", "generic", f.target); assert.throws(() => f.share.getPlan(plan.id), /过期/);
});

test("rollback refuses concurrent client changes, retaining current file and encrypted original", async t => {
  const f = await setup(t), plan = f.share.preview("claude", ["shared"]); f.share.apply(plan.id, []);
  const item = f.share.snapshot().deployments[0], changed = '{"laterChange":true}'; fs.writeFileSync(f.target, changed);
  assert.throws(() => f.share.rollback(item.id), /后续操作修改/);
  assert.equal(fs.readFileSync(f.target, "utf8"), changed); assert.equal(f.share.getDeployment(item.id).rolledBack, false);
});

test("MCP target cannot be inside private storage, repository, protected roots, junctions or hardlinks", async t => {
  const f = await setup(t);
  for (const file of [path.join(f.service.storage, "bad.json"), path.join(f.repo, "bad.json"), path.join(f.dir("protected"), "bad.json")])
    assert.throws(() => f.share.bind("claude", "claude", file), /不能|仓库外/);
  assert.throws(() => f.share.bind("claude", "claude", path.join(f.root, "missing", "x.json")), /ENOENT|父目录/);
  assert.throws(() => f.share.bind("claude", "claude", f.file("x.txt", "{}")), /\.json/);
  const link = path.join(f.root, "link"); fs.symlinkSync(path.dirname(f.target), link, process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => f.share.bind("claude", "claude", path.join(link, "config.json")), /链接|junction/);
  const hard = path.join(path.dirname(f.target), "hard.json"); fs.linkSync(f.target, hard);
  assert.throws(() => f.share.bind("claude", "claude", hard), /硬链接/);
  assert.throws(() => f.share.preview("claude", ["shared"]), /硬链接/);
});

test("plans recheck links and repository containment after binding", async t => {
  const f = await setup(t), plan = f.share.preview("claude", ["shared"]), outside = f.dir("external");
  fs.renameSync(path.dirname(f.target), path.join(f.root, "original-client"));
  fs.symlinkSync(outside, path.dirname(f.target), process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => f.share.apply(plan.id, []), /链接|junction/);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test("one client config cannot represent two independent agent identities", async t => {
  const f = await setup(t); assert.throws(() => f.share.bind("workbuddy", "workbuddy", f.target), /已绑定另一个/);
});

test("strict JSON rejects duplicates, prototype keys, JSONC, nonobject roots and malformed mcpServers", async t => {
  const f = await setup(t);
  for (const source of ['{"a":1,"a":2}', '{"a":{"x":1,"x":2}}', '{"__proto__":{}}', '{"x":1,}', '{/*comment*/"x":1}']) assert.throws(() => strictJson(source), /JSON/);
  for (const source of ["[]", '{"mcpServers":[]}']) {
    fs.writeFileSync(f.target, source); assert.throws(() => f.share.bind("claude", "claude", f.target), /对象/);
  }
  assert.deepEqual(strictJson('{"a":[{"x":1},{"x":2}],"b":"quoted \\\" test"}'), { a: [{ x: 1 }, { x: 2 }], b: 'quoted " test' });
});

test("private references are mandatory in env/headers and resolved without exposing them in plans", async t => {
  const f = await setup(t);
  await assert.rejects(f.share.saveTemplates(manifest({ bad: { ...template, headers: { Authorization: "Bearer real-secret" } } })), /私有变量/);
  await assert.rejects(f.share.saveTemplates(manifest({ bad: { transport: "stdio", command: "node", env: { SECRET: "literal" } } })), /私有变量/);
  f.share.setVariable("SERVICE_TOKEN", ""); assert.throws(() => f.share.preview("claude", ["shared"]), /SERVICE_TOKEN/);
  assert.throws(() => f.share.setVariable("lower", "value"), /大写/);
  assert.throws(() => f.share.setVariable("TOKEN", "line\r\nInjected: true"), /单行/);
  assert.ok(!f.share.snapshot().variableNames.includes("SERVICE_TOKEN"));
});

test("common credential query keys and command flags require private references while normal arguments remain supported", () => {
  for (const key of ["token", "key", "api_key", "api-key", "APIKey", "access_token", "clientSecret", "password", "auth", "authorization", "x-api-key", "api%5Fkey"]) {
    assert.throws(() => parseManifest(manifest({ bad: { transport: "http", url: `https://service.example/mcp?${key}=literal-secret` } })), /私有变量引用/);
  }
  for (const args of [["--api-key", "literal-secret"], ["--token=literal-secret"], ["--password", "literal-secret"],
    ["--client-secret=literal-secret"], ["--access_token", "literal-secret"], ["--x-api-key=literal-secret"], ["--auth"], ["-password=literal-secret"]]) {
    assert.throws(() => parseManifest(manifest({ bad: { transport: "stdio", command: "server.exe", args } })), /私有变量引用/);
  }
  const variables = { API_KEY: "local-only-credential", TOKEN: "local-only-token" };
  const http = { transport: "http" as const, url: "https://service.example/mcp?version=2&region=cn&api_key=${API_KEY}&auth=Bearer%20${TOKEN}" };
  const stdio = { transport: "stdio" as const, command: "server.exe", args: ["--port", "8080", "--mode=readonly", "--api-key", "${API_KEY}", "--token=${TOKEN}", "--verbose"] };
  const parsed = parseManifest(manifest({ http, stdio }));
  assert.equal(renderTemplate(parsed.servers.http, "claude", variables).url, "https://service.example/mcp?version=2&region=cn&api_key=local-only-credential&auth=Bearer%20local-only-token");
  assert.deepEqual(renderTemplate(parsed.servers.stdio, "claude", variables).args, ["--port", "8080", "--mode=readonly", "--api-key", "local-only-credential", "--token=local-only-token", "--verbose"]);
});

test("public template save and Git commit both reject common literal credential arguments", async t => {
  const f = await setup(t), file = path.join(f.repo, "mcp", "servers.json"), before = fs.readFileSync(file, "utf8");
  const unsafe = manifest({ bad: { transport: "http", url: "https://service.example/mcp?api_key=literal-secret" } });
  await assert.rejects(f.share.saveTemplates(unsafe), /私有变量引用/); assert.equal(fs.readFileSync(file, "utf8"), before);
  for (const source of [unsafe, manifest({ bad: { transport: "stdio", command: "server.exe", args: ["--token=literal-secret"] } })]) {
    fs.writeFileSync(file, source);
    await assert.rejects(commitRepository(f.repo, "must reject credential literals"), /私有变量引用/);
  }
});

test("profile rendering maps transport dialects and rejects generic shell/unsafe URL/header input", () => {
  for (const [profile, expected] of [["claude", "http"], ["workbuddy", "streamableHttp"], ["qoder-ide", "sse"], ["qoder-cli", "http"], ["generic", "http"], ["trae", undefined]] as const)
    assert.equal(renderTemplate(template, profile, { SERVICE_TOKEN: "private" }).type, expected);
  assert.equal(renderTemplate({ transport: "sse", url: "https://example.com/sse" }, "workbuddy", {}).type, "sse");
  assert.throws(() => renderTemplate({ transport: "stdio", command: "C:\\Program Files\\node.exe" }, "trae", {}), /空格/);
  assert.throws(() => renderTemplate({ transport: "stdio", command: "${HOST}" }, "claude", { HOST: "pwsh.exe" }), /shell/);
  for (const url of ["file:///private", "http://remote.example/mcp", "https://user:password@example.com/mcp", "https://example.com/mcp#secret"])
    assert.throws(() => parseManifest(manifest({ bad: { transport: "http", url } })), /URL|HTTPS/);
  assert.throws(() => parseManifest(manifest({ bad: { ...template, headers: { Host: "${HOST}" } } })), /传输层/);
  assert.throws(() => parseManifest(manifest({ bad: { transport: "stdio", command: "cmd.exe", args: ["/c", "danger"] } })), /shell/);
  assert.throws(() => parseManifest(manifest({ bad: { ...template, extra: true } as never })), /不支持/);
  assert.throws(() => parseManifest(manifest({ "agent-console-user": template })), /保留/);
});

test("private bridge deploys without a repository and never becomes a shared template", t => {
  const f = fixture(t), share = new McpShareService(f.service, codec()), target = f.file("client/config.json", "{}");
  share.bind("claude", "claude", target);
  const bridge: McpBridgeDefinition = { id: "agent-console-bridge", template: { transport: "http", url: "http://127.0.0.1:43881/mcp", headers: { Authorization: "${BRIDGE_AUTH}" } }, variables: { BRIDGE_AUTH: "Bearer bridge-secret" } };
  const plan = share.preview("claude", [], bridge); assert.ok(!JSON.stringify(plan).includes("bridge-secret")); share.apply(plan.id, []);
  assert.equal(JSON.parse(fs.readFileSync(target, "utf8")).mcpServers[bridge.id].headers.Authorization, "Bearer bridge-secret");
  assert.deepEqual(share.snapshot().servers, []); assert.deepEqual(share.snapshot().variableNames, []); assert.ok(!share.snapshot().templatesJson.includes("bridge"));
});

test("only explicit public MCP template is tracked, and malformed/credential-bearing edited templates cannot commit", async t => {
  const f = await setup(t); f.file("repository/mcp/private.json", '{"SECRET":"never-track"}');
  assert.equal((await repositoryStatus(f.repo)).dirty, 1);
  const commit = await commitRepository(f.repo, "MCP templates");
  const tracked = await git.listFiles({ fs, dir: f.repo });
  assert.ok(tracked.includes("mcp/servers.json")); assert.ok(!tracked.includes("mcp/private.json"));
  const stored = (await readRevision(f.repo, commit.oid, "mcp/servers.json")).toString();
  assert.ok(stored.includes("${SERVICE_TOKEN}")); assert.ok(!stored.includes("private-value-never-in-git"));
  fs.writeFileSync(path.join(f.repo, "mcp", "servers.json"), manifest({ bad: { ...template, headers: { Authorization: "literal-secret" } } }));
  await assert.rejects(commitRepository(f.repo, "must fail"), /私有变量/);
  assert.ok(f.share.snapshot().error); assert.deepEqual(f.share.snapshot().servers, []);
});

test("encryption failure occurs before client mutation and audit corruption blocks deployment", async t => {
  const f = await setup(t), before = fs.readFileSync(f.target, "utf8");
  let available = true;
  const crypt: SecretCodec = { open: f.crypt.open, seal: text => { if (!available) throw new Error("encryption unavailable"); return f.crypt.seal(text); } };
  const share = new McpShareService(f.service, crypt), plan = share.preview("claude", ["shared"]); available = false;
  assert.throws(() => share.apply(plan.id, []), /encryption unavailable/); assert.equal(fs.readFileSync(f.target, "utf8"), before);
  available = true;
  const next = share.preview("claude", ["shared"]); const original = f.service.verifyAudit.bind(f.service);
  f.service.verifyAudit = () => ({ valid: false, error: "tampered" });
  assert.throws(() => share.apply(next.id, []), /台账/); assert.equal(fs.readFileSync(f.target, "utf8"), before); f.service.verifyAudit = original;
});

test("private persistence rejects tampering and unsupported plaintext rather than resetting authorization", async t => {
  const f = await setup(t), file = path.join(f.service.storage, "mcp-private.enc"); fs.writeFileSync(file, '{"variables":{"SECRET":"plain"}}');
  const share = new McpShareService(f.service, f.crypt);
  assert.match(share.snapshot().error!, /无法读取或解密/);
  assert.throws(() => share.setVariable("SECRET", "replacement"), /无法读取或解密/);
  assert.throws(() => share.bind("claude", "claude", f.target), /无法读取或解密/);
  assert.equal(fs.readFileSync(file, "utf8"), '{"variables":{"SECRET":"plain"}}');
});

test("rollback checks encryption before external changes and can acknowledge a previously restored preimage", async t => {
  const f = await setup(t), original = fs.readFileSync(f.target, "utf8");
  f.share.apply(f.share.preview("claude", ["shared"]).id, []);
  const id = f.share.snapshot().deployments[0].id, deployed = fs.readFileSync(f.target, "utf8");
  let available = false;
  const share = new McpShareService(f.service, { open: f.crypt.open, seal: value => { if (!available) throw new Error("encryption unavailable"); return f.crypt.seal(value); } });
  assert.throws(() => share.rollback(id), /encryption unavailable/); assert.equal(fs.readFileSync(f.target, "utf8"), deployed);
  fs.writeFileSync(f.target, original); available = true; share.rollback(id);
  assert.equal(share.getDeployment(id).rolledBack, true); assert.equal(fs.readFileSync(f.target, "utf8"), original);
});

test("rollback rechecks after encryption before restoring, deleting or acknowledging a preimage", async t => {
  for (const mode of ["restore", "delete-new", "acknowledge-preimage"] as const) {
    const f = await setup(t), original = fs.readFileSync(f.target, "utf8");
    if (mode === "delete-new") fs.unlinkSync(f.target);
    f.share.apply(f.share.preview("claude", ["shared"]).id, []);
    const id = f.share.snapshot().deployments[0].id, privateFile = path.join(f.service.storage, "mcp-private.enc"), saved = fs.readFileSync(privateFile);
    if (mode === "acknowledge-preimage") fs.writeFileSync(f.target, original);
    const changed = JSON.stringify({ changedDuringEncryption: mode });
    const share = new McpShareService(f.service, { open: f.crypt.open, seal: value => { fs.writeFileSync(f.target, changed); return f.crypt.seal(value); } });
    assert.throws(() => share.rollback(id), /回滚准备期间已变化/);
    assert.equal(fs.readFileSync(f.target, "utf8"), changed); assert.deepEqual(fs.readFileSync(privateFile), saved);
    assert.equal(share.getDeployment(id).rolledBack, false);
    assert.equal(new McpShareService(f.service, f.crypt).getDeployment(id).rolledBack, false);
  }
});

test("shared template junctions and private-store hardlinks fail without touching external files", async t => {
  const f = await setup(t), outside = f.dir("outside"), sentinel = f.file("outside/servers.json", "never write here");
  fs.renameSync(path.join(f.repo, "mcp"), path.join(f.repo, "mcp-original"));
  fs.symlinkSync(outside, path.join(f.repo, "mcp"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(f.share.saveTemplates(manifest({})), /链接|junction/);
  assert.equal(fs.readFileSync(sentinel, "utf8"), "never write here");
  const privateFile = path.join(f.service.storage, "mcp-private.enc"), original = fs.readFileSync(privateFile);
  fs.linkSync(privateFile, path.join(f.root, "private-copy"));
  assert.throws(() => f.share.setVariable("SECRET", "changed"), /硬链接/);
  assert.deepEqual(fs.readFileSync(privateFile), original);
});
