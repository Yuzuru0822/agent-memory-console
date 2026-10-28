import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { ConsoleService } from "./service";
import type { SecretCodec } from "./private-store";
import { atomicWrite, digest, localPath, noLinks, readText, within } from "./safety";
import { REPOSITORY_MARKER, repositoryStatus } from "./repository-git";
import { EMPTY_MANIFEST, PROFILES, SERVER_ID, VARIABLE, json, object, parseManifest, renderTemplate, strictJson, templateVariables } from "./mcp-share-format";
import type { AgentId, Result } from "../src/shared";
import type { McpBinding, McpBridgeDefinition, McpDeployment, McpManifest, McpPlan, McpProfile, McpSnapshot } from "../src/mcp-types";

interface SavedDeployment extends McpDeployment { before: string | null; afterHash: string }
interface PrivateState { version: 1; variables: Record<string, string>; bindings: McpBinding[]; deployments: SavedDeployment[] }
interface StoredPlan {
  view: McpPlan;
  original: string | null;
  beforeHash: string | null;
  definitions: Record<string, Record<string, unknown>>;
  stateHash: string;
  root?: string;
  templateHash?: string;
}
const MAX_PRIVATE_BYTES = 24 * 1024 * 1024;
const emptyState = (): PrivateState => ({ version: 1, variables: {}, bindings: [], deployments: [] });
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const hash = (value: string | null): string | null => value === null ? null : digest(value);
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (object(value)) return `{${Object.keys(value).sort().map(k => JSON.stringify(k) + ":" + stable(value[k])).join(",")}}`;
  return JSON.stringify(value);
}
function normalFile(file: string): void {
  noLinks(file);
  if (!fs.existsSync(file)) return;
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.nlink !== 1) throw new Error("MCP 文件必须为普通文件，不能使用硬链接、链接或 junction");
}

export class McpShareService {
  private state: PrivateState;
  private privateError?: string;
  private readonly privateFile: string;
  private plans = new Map<string, StoredPlan>();
  constructor(private readonly service: ConsoleService, private readonly codec: SecretCodec, private readonly now = () => Date.now()) {
    this.privateFile = path.join(service.storage, "mcp-private.enc");
    try { this.state = this.load(); }
    catch (error) { this.state = emptyState(); this.privateError = (error as Error).message; }
  }
  invalidatePlans(): void { this.plans.clear(); }
  private audit(): void {
    if (this.privateError) throw new Error(this.privateError);
    if (!this.service.verifyAudit().valid) throw new Error("活动台账校验失败，已阻止 MCP 配置操作");
  }
  private root(): string | undefined {
    const input = this.service.config.repository?.root;
    if (!input) return;
    const root = noLinks(localPath(input));
    this.service.assertWritablePath(root);
    if (!fs.statSync(root).isDirectory()) throw new Error("共享仓库路径无效");
    const marker = path.join(root, REPOSITORY_MARKER);
    normalFile(marker);
    const data = strictJson(readText(marker).toString("utf8"));
    if (!object(data) || data.version !== 1 || data.application !== "agent-memory-console") throw new Error("请先配置本软件管理的共享 Git 仓库");
    noLinks(path.join(root, ".git"));
    if (!fs.statSync(path.join(root, ".git")).isDirectory()) throw new Error("共享 Git 仓库结构无效");
    return root;
  }
  private manifest(root = this.root()): { value: McpManifest; hash?: string } {
    if (!root) return { value: clone(EMPTY_MANIFEST) };
    const file = path.join(root, "mcp", "servers.json"); normalFile(file);
    if (!fs.existsSync(file)) return { value: clone(EMPTY_MANIFEST) };
    const source = readText(file).toString("utf8");
    return { value: parseManifest(source), hash: digest(source) };
  }
  private target(input: string): string {
    const file = noLinks(localPath(input));
    if (path.extname(file).toLowerCase() !== ".json") throw new Error("请选择 .json 配置文件");
    this.service.assertWritablePath(file);
    const protectedRoots = [this.service.storage, process.env.SystemRoot, process.env.WINDIR,
      process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.ProgramData].filter((p): p is string => !!p);
    if (protectedRoots.some(root => within(root, file))) throw new Error("不能选择系统、应用或私有存储目录");
    const root = this.service.config.repository?.root;
    if (root && within(root, file)) throw new Error("客户端 MCP 配置必须位于共享仓库外，避免私有凭据进入 Git");
    noLinks(path.dirname(file));
    if (!fs.statSync(path.dirname(file)).isDirectory()) throw new Error("目标配置的父目录必须已经存在");
    normalFile(file);
    return file;
  }
  private current(file: string): { source: string | null; value: Record<string, unknown> } {
    this.target(file);
    if (!fs.existsSync(file)) return { source: null, value: {} };
    const source = readText(file).toString("utf8"), value = strictJson(source);
    normalFile(file);
    if (!object(value) || value.mcpServers !== undefined && !object(value.mcpServers)) throw new Error("目标 JSON 须为对象，mcpServers 须为对象");
    return { source, value };
  }
  private load(): PrivateState {
    normalFile(this.privateFile);
    if (!fs.existsSync(this.privateFile)) return emptyState();
    if (fs.statSync(this.privateFile).size > MAX_PRIVATE_BYTES * 2) throw new Error("MCP 私有数据超过上限");
    try {
      const decoded = this.codec.open(fs.readFileSync(this.privateFile, "utf8"));
      if (Buffer.byteLength(decoded) > MAX_PRIVATE_BYTES) throw new Error("size");
      const data = JSON.parse(decoded) as PrivateState;
      if (!object(data) || data.version !== 1 || !object(data.variables) || Object.keys(data.variables).length > 100 ||
          !Array.isArray(data.bindings) || data.bindings.length > this.service.adapters.length || !Array.isArray(data.deployments) || data.deployments.length > 100)
        throw new Error("shape");
      for (const [name, value] of Object.entries(data.variables)) this.checkVariable(name, value);
      const bound = new Set<string>();
      for (const binding of data.bindings) {
        this.service.adapter(binding.agentId);
        if (bound.has(binding.agentId) || !PROFILES.includes(binding.profile) || typeof binding.file !== "string" || localPath(binding.file) !== binding.file)
          throw new Error("binding");
        bound.add(binding.agentId);
      }
      const deploymentIds = new Set<string>();
      for (const deployment of data.deployments) {
        this.service.adapter(deployment.agentId);
        if (!/^[a-f0-9-]{36}$/.test(deployment.id) || deploymentIds.has(deployment.id) || !Number.isFinite(Date.parse(deployment.at)) ||
            typeof deployment.file !== "string" || localPath(deployment.file) !== deployment.file || !/^[a-f0-9]{64}$/.test(deployment.afterHash) ||
            typeof deployment.rolledBack !== "boolean" || !Array.isArray(deployment.serverIds) || deployment.serverIds.some(id => typeof id !== "string" || !SERVER_ID.test(id)) ||
            deployment.before !== null && typeof deployment.before !== "string") throw new Error("deployment");
        if (deployment.before !== null) strictJson(deployment.before);
        deploymentIds.add(deployment.id);
      }
      return data;
    } catch { throw new Error("MCP 私有配置无法读取或解密，请保留原文件并使用原 Windows 用户"); }
  }
  private preparePrivate(next: PrivateState): string {
    this.audit();
    const source = JSON.stringify(next);
    if (next.deployments.length > 100 || Buffer.byteLength(source) > MAX_PRIVATE_BYTES)
      throw new Error("MCP 私有备份容量已满，请先保留备份并清理历史数据");
    normalFile(this.privateFile);
    return this.codec.seal(source);
  }
  private persistPrepared(next: PrivateState, sealed: string): void {
    normalFile(this.privateFile);
    atomicWrite(this.privateFile, sealed);
    this.state = next;
  }
  private persist(next: PrivateState): void { this.persistPrepared(next, this.preparePrivate(next)); }
  private checkVariable(name: string, value: string): void {
    if (typeof name !== "string" || !VARIABLE.test(name) || typeof value !== "string" || value.length > 16000 || /[\0\r\n]/.test(value))
      throw new Error("私有变量名须为大写字母/数字/下划线，值须为不超过 16000 字的单行文本");
  }
  /** Main-process-only resolution for explicitly approved native runs. Never expose through IPC. */
  runtimeServer(id: string): { config: Record<string, unknown>; hash: string } {
    this.audit();
    if (this.privateError) throw new Error(this.privateError);
    const template = this.manifest().value.servers[id];
    if (!template) throw new Error("MCP 服务不存在");
    return { config: renderTemplate(template, "claude", this.state.variables), hash: crypto.createHash("sha256").update(JSON.stringify(template)).digest("hex") };
  }
  snapshot(): McpSnapshot {
    const snapshot: McpSnapshot = {
      templatesJson: json(EMPTY_MANIFEST), servers: [], variableNames: Object.keys(this.state.variables).sort(),
      bindings: clone(this.state.bindings), deployments: this.state.deployments.slice().reverse().map(item => this.publicDeployment(item)),
      error: this.privateError,
    };
    try {
      snapshot.root = this.root();
      if (snapshot.root) snapshot.templatePath = path.join(snapshot.root, "mcp", "servers.json");
      const { value } = this.manifest(snapshot.root);
      snapshot.templatesJson = json(value);
      snapshot.servers = Object.entries(value.servers).map(([id, item]) => ({ id, transport: item.transport, description: item.description, variables: templateVariables(item) }));
    } catch (e) { snapshot.error = [snapshot.error, (e as Error).message].filter(Boolean).join("；"); }
    return snapshot;
  }
  async saveTemplates(source: string): Promise<Result> {
    this.audit();
    const manifest = parseManifest(source), root = this.root();
    if (!root) throw new Error("请先在记忆仓库中选择独立 Git 仓库");
    await repositoryStatus(root);
    if (this.root() !== root) throw new Error("共享仓库已变化，请重新保存");
    const file = path.join(root, "mcp", "servers.json");
    normalFile(file); noLinks(path.dirname(file));
    atomicWrite(file, json(manifest));
    this.invalidatePlans();
    this.service.audit("mcp.templates", `保存 ${Object.keys(manifest.servers).length} 个 MCP 模板`);
    return { message: "MCP 模板已保存。尚未创建 Git 提交，请在共享仓库中提交版本；客户端配置不会自动改变。" };
  }
  setVariable(name: string, value: string): Result {
    this.checkVariable(name, value);
    const next = clone(this.state);
    if (value) next.variables[name] = value; else delete next.variables[name];
    if (Object.keys(next.variables).length > 100) throw new Error("私有变量最多 100 项");
    this.persist(next); this.invalidatePlans();
    this.service.audit("mcp.variable", value ? "更新一个私有变量" : "移除一个私有变量");
    return { message: value ? "私有变量已加密保存，不会写入共享 Git 仓库。" : "私有变量已移除。" };
  }
  bind(agentId: AgentId, profile: McpProfile, input: string): Result {
    this.audit(); this.service.adapter(agentId);
    if (!PROFILES.includes(profile)) throw new Error("未知 MCP 客户端格式");
    const file = this.target(input); this.current(file);
    if (this.state.bindings.some(b => b.agentId !== agentId && path.resolve(b.file).toLowerCase() === file.toLowerCase()))
      throw new Error("该配置文件已绑定另一个 Agent，请使用各客户端独立文件");
    const next = clone(this.state);
    next.bindings = [...next.bindings.filter(b => b.agentId !== agentId), { agentId, profile, file }];
    this.persist(next); this.invalidatePlans();
    this.service.audit("mcp.bind", `${agentId} · ${profile}`);
    return { message: "MCP 配置文件已绑定。尚未写入文件，请选择服务并预览部署。" };
  }
  preview(agentId: AgentId, serverIds: string[], bridge?: McpBridgeDefinition): McpPlan {
    this.audit(); this.service.adapter(agentId);
    const binding = this.state.bindings.find(b => b.agentId === agentId);
    if (!binding) throw new Error("请先绑定该 Agent 的 MCP JSON 配置文件");
    if (!Array.isArray(serverIds) || serverIds.length > 100 || serverIds.some(id => typeof id !== "string") || new Set(serverIds).size !== serverIds.length)
      throw new Error("请选择不重复的 MCP 服务");
    if (!serverIds.length && !bridge) throw new Error("请至少选择一个服务或本机互联桥");
    const root = this.root(), manifest = this.manifest(root), current = this.current(binding.file);
    const old = current.value.mcpServers as Record<string, unknown> | undefined;
    const definitions: Record<string, Record<string, unknown>> = {}, items: McpPlan["items"] = [];
    const add = (id: string, template: McpManifest["servers"][string], variables: Record<string, string>) => {
      const definition = renderTemplate(template, binding.profile, variables);
      definitions[id] = definition;
      const previous = old && Object.hasOwn(old, id) ? old[id] : undefined;
      items.push({ id, transport: template.transport, action: previous === undefined ? "add" : stable(previous) === stable(definition) ? "same" : "conflict" });
    };
    for (const id of serverIds) {
      if (!Object.hasOwn(manifest.value.servers, id)) throw new Error("选中的 MCP 服务已不存在，请刷新模板");
      add(id, manifest.value.servers[id], this.state.variables);
    }
    if (bridge) {
      if (!SERVER_ID.test(bridge.id) || !bridge.id.startsWith("agent-console-") || Object.hasOwn(definitions, bridge.id)) throw new Error("互联桥服务名无效");
      for (const [name, value] of Object.entries(bridge.variables)) this.checkVariable(name, value);
      add(bridge.id, bridge.template, bridge.variables);
    }
    const warnings = ["仅合并选中服务；其它客户端设置和未选服务保持原值。不传播删除。",
      "未勾选覆盖的同名冲突将跳过；部署后请在客户端检查、信任或重新加载 MCP。",
      "目标客户端配置可能包含明文凭据；备份在本应用私有目录加密保存，不进入 Git。"];
    if (items.some(item => item.transport === "stdio")) warnings.push("客户端加载 stdio 配置后可能启动其中的程序；请确认命令和来源可信。本控制台不会执行这些命令。");
    if (["generic", "qoder-ide", "trae"].includes(binding.profile)) warnings.push("请确认选择的是客户端实际使用的配置文件；通用适配不代表已验证该厂家连接。");
    const view: McpPlan = { id: crypto.randomUUID(), agentId, profile: binding.profile, file: binding.file,
      expiresAt: new Date(this.now() + 2 * 60_000).toISOString(), items, warnings };
    for (const [id, plan] of this.plans) if (Date.parse(plan.view.expiresAt) <= this.now()) this.plans.delete(id);
    if (this.plans.size >= 20) this.plans.delete(this.plans.keys().next().value!);
    this.plans.set(view.id, { view, original: current.source, beforeHash: hash(current.source), definitions,
      stateHash: digest(JSON.stringify(this.state)), root, templateHash: manifest.hash });
    return clone(view);
  }
  getPlan(id: string): McpPlan {
    const plan = this.plans.get(id);
    if (!plan || Date.parse(plan.view.expiresAt) <= this.now()) throw new Error("MCP 预览已过期，请重新预览");
    if (digest(JSON.stringify(this.state)) !== plan.stateHash || this.root() !== plan.root || this.manifest(plan.root).hash !== plan.templateHash)
      throw new Error("MCP 模板、私有变量或绑定已变化，请重新预览");
    if (hash(this.current(plan.view.file).source) !== plan.beforeHash) throw new Error("客户端配置在预览后已变化，请重新预览");
    return clone(plan.view);
  }
  apply(id: string, overwriteIds: string[]): Result {
    this.audit(); this.getPlan(id);
    const plan = this.plans.get(id)!;
    if (!Array.isArray(overwriteIds) || overwriteIds.some(name => !plan.view.items.some(i => i.id === name && i.action === "conflict")) || new Set(overwriteIds).size !== overwriteIds.length)
      throw new Error("覆盖列表只能包含当前预览中发生冲突的服务");
    if (digest(JSON.stringify(this.state)) !== plan.stateHash || this.root() !== plan.root || this.manifest(plan.root).hash !== plan.templateHash)
      throw new Error("MCP 模板、私有变量或绑定已变化，请重新预览");
    const current = this.current(plan.view.file);
    if (hash(current.source) !== plan.beforeHash) throw new Error("客户端配置在预览后已变化，请重新预览");
    const selected = plan.view.items.filter(item => item.action === "add" || item.action === "conflict" && overwriteIds.includes(item.id));
    this.plans.delete(id);
    if (!selected.length) return { message: "没有需要写入的 MCP 服务；同名冲突已保留原值。" };
    const servers = { ...(current.value.mcpServers as Record<string, unknown> || {}) };
    for (const item of selected) servers[item.id] = plan.definitions[item.id];
    const output = json({ ...current.value, mcpServers: servers });
    if (Buffer.byteLength(output) > 1024 * 1024) throw new Error("合并后的 MCP 配置超过 1 MiB");
    const deployment: SavedDeployment = { id: crypto.randomUUID(), at: new Date(this.now()).toISOString(), agentId: plan.view.agentId,
      file: plan.view.file, serverIds: selected.map(i => i.id), rolledBack: false, before: current.source, afterHash: digest(output) };
    const next = clone(this.state); next.deployments.push(deployment);
    // Persist the encrypted preimage before changing the external file. Even a crash leaves a recoverable backup.
    this.persist(next);
    const fresh = this.current(plan.view.file);
    if (hash(fresh.source) !== plan.beforeHash) throw new Error("客户端配置在备份期间已变化，未写入，请重新预览");
    atomicWrite(plan.view.file, output);
    this.invalidatePlans();
    this.service.audit("mcp.deploy", `${plan.view.agentId} · ${selected.length} 个服务 · ${deployment.id}`);
    return { message: `已合并 ${selected.length} 个 MCP 服务并加密备份。请在客户端检查、信任或重新加载；尚未验证连接。` };
  }
  private publicDeployment(item: SavedDeployment): McpDeployment {
    return { id: item.id, at: item.at, agentId: item.agentId, file: item.file, serverIds: [...item.serverIds], rolledBack: item.rolledBack };
  }
  getDeployment(id: string): McpDeployment {
    const item = this.state.deployments.find(d => d.id === id);
    if (!item) throw new Error("找不到 MCP 部署备份");
    return this.publicDeployment(item);
  }
  rollback(id: string): Result {
    this.audit(); this.getDeployment(id);
    const item = this.state.deployments.find(d => d.id === id)!;
    if (item.rolledBack) throw new Error("该 MCP 部署已经回滚");
    const current = this.current(item.file);
    const alreadyRestored = hash(current.source) === hash(item.before);
    if (hash(current.source) !== item.afterHash && !alreadyRestored) throw new Error("客户端配置已被后续操作修改，不能回滚覆盖；请保留当前内容后手动处理");
    const next = clone(this.state); next.deployments.find(d => d.id === id)!.rolledBack = true;
    // Check encryption availability before restoring an external file. A retry after a
    // private-state write failure can recognize the exact restored preimage safely.
    const sealed = this.preparePrivate(next);
    // Encryption/audit work can take time. Recheck both restore and already-restored
    // paths after it, before touching the client or recording a successful rollback.
    if (hash(this.current(item.file).source) !== hash(current.source))
      throw new Error("客户端配置在回滚准备期间已变化，未回滚，请保留当前内容后重新检查");
    if (!alreadyRestored) {
      if (item.before === null) { this.target(item.file); fs.unlinkSync(item.file); }
      else atomicWrite(item.file, item.before);
    }
    this.persistPrepared(next, sealed); this.invalidatePlans();
    this.service.audit("mcp.rollback", `${item.agentId} · ${id}`);
    return { message: "MCP 配置已恢复为部署前的完整内容；客户端仍需重新加载。" };
  }
}
