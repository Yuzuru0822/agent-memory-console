import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { Adapter } from "./adapters";
import { discoverClaudeNpm, resolveClaudeNpm, validateClaudeNpm, type ClaudeNpmInstallation } from "./claude-npm";
import { resolveSkillPath, scanSkills } from "./skill-paths";
import {
  atomicWrite,
  digest,
  hashFile,
  localPath,
  nativeExecutable,
  noLinks,
  readText,
  within,
  MAX_FILES,
  MAX_TOTAL,
  TEXT_EXT,
} from "./safety";
import type {
  AgentId,
  AgentConfig,
  AuditRow,
  Backup,
  Config,
  FileInfo,
  PathKind,
  PickKind,
  Plan,
  PlanItem,
  SkillsInfo,
  Snapshot,
  AgentView,
  SkillAccess,
} from "../src/shared";

interface StoredPlan {
  view: Plan;
  configHash: string;
}
interface Manifest extends Backup {
  entries: { target: string; file: string; hash: string; logicalTarget?: string }[];
}
const pathKey = (p: string) => process.platform === "win32" ? path.resolve(p).toLowerCase() : path.resolve(p);
const samePath = (a: string, b: string) => pathKey(a) === pathKey(b);
export class ConsoleService {
  config: Config;
  private plans = new Map<string, StoredPlan>();
  private protectedRoots: string[];
  constructor(
    readonly storage: string,
    readonly adapters: Adapter[],
    protectedRoots: string[] = [],
  ) {
    this.protectedRoots = [storage, ...protectedRoots].flatMap((p) => {
      const absolute = path.resolve(p);
      if (absolute === path.parse(absolute).root) return [absolute];
      return [absolute, resolveSkillPath(absolute).real];
    });
    noLinks(storage);
    fs.mkdirSync(storage, { recursive: true });
    const cfg = path.join(storage, "config.json");
    this.config = fs.existsSync(cfg)
      ? JSON.parse(readText(cfg).toString("utf8"))
      : { version: 1, agents: {} };
    if (
      this.config.version !== 1 ||
      !this.config.agents ||
      typeof this.config.agents !== "object" ||
      Array.isArray(this.config.agents)
    )
      throw new Error("配置格式无效。请备份后检查 config.json");
  }
  adapter(id: AgentId): Adapter {
    const a = this.adapters.find((a) => a.id === id);
    if (!a) throw new Error("未知 Agent");
    return a;
  }
  /** Trusted host-only bootstrap data for the isolated repository worker. */
  workerContext() {
    return { storage: this.storage, adapters: this.adapters, protectedRoots: [...this.protectedRoots] };
  }
  settings(id: AgentId): AgentConfig {
    this.adapter(id);
    return this.config.agents[id] || {};
  }
  private candidate(paths: string[]): string {
    return paths.find((p) => fs.existsSync(p)) || paths[0] || "";
  }
  paths(id: AgentId): AgentConfig {
    const a = this.adapter(id),
      c = this.settings(id);
    return {
      memory: c.memory || this.candidate(a.memory),
      skills: c.skills || this.candidate(a.skills),
      executable: c.claudeNpm?.launcher || c.executable || this.candidate(a.executables),
      workspace: c.workspace,
    };
  }
  npmCandidate(): ClaudeNpmInstallation | undefined {
    const options = this.adapter("claude").npmDiscovery;
    return options ? discoverClaudeNpm(options) : undefined;
  }
  resolveNpm(selected: string): ClaudeNpmInstallation {
    return resolveClaudeNpm(selected, this.adapter("claude").npmDiscovery || { prefixes: [], nodeCandidates: [] });
  }
  bindNpm(installation: ClaudeNpmInstallation): void {
    if (!this.verifyAudit().valid) throw new Error("活动台账校验失败，已阻止授权变更");
    const approved = validateClaudeNpm(installation, this.adapter("claude").npmDiscovery || { prefixes: [], nodeCandidates: [] });
    const c = { ...this.settings("claude"), claudeNpm: approved };
    delete c.executable;
    this.config.agents.claude = c;
    this.save();
    this.audit("path.bind", `claude · npm ${approved.packageVersion} · ${approved.entry}${approved.node ? " · node=" + approved.node : ""}`);
  }
  private ensureWritable(p: string): void {
    noLinks(p);
    if (this.protectedRoots.some((root) => within(root, p)))
      throw new Error("不能写入系统、应用或控制台数据目录");
  }
  assertWritablePath(p: string): void { this.ensureWritable(p); }
  checkRepositorySkill(id: AgentId, logical: string, expectedReal?: string): string {
    const c = this.settings(id);
    if (!c.skills || samePath(c.skills, logical)) throw new Error("请先授权 Agent 技能目录");
    const real = this.skillPath(c.skills, c.skillsAccess, logical, expectedReal);
    this.ensureWritable(real);
    return real;
  }
  persistRepository(): void {
    if (!this.verifyAudit().valid) throw new Error("活动台账校验失败");
    this.save();
  }
  prepareSkills(selected: string): SkillAccess {
    const root = localPath(selected), resolved = resolveSkillPath(root);
    if (!fs.statSync(resolved.real).isDirectory()) throw new Error("技能路径必须是文件夹");
    const tree = scanSkills(root, { inspection: true });
    if (tree.truncated || tree.links.length > 256) throw new Error("技能目录或链接过多，请选择较小的目录后授权");
    if (tree.warnings.length) throw new Error(`技能目录存在需要修复的项目，修复后再授权同步：${tree.warnings[0]}`);
    return { root, realRoot: resolved.real, links: tree.links };
  }
  bindSkills(id: AgentId | null, access: SkillAccess): void {
    if (!this.verifyAudit().valid) throw new Error("活动台账校验失败，已阻止授权变更");
    const fresh = this.prepareSkills(access.root);
    if (digest(JSON.stringify(fresh)) !== digest(JSON.stringify(access))) throw new Error("技能链接在确认期间变化，请重新授权");
    if (id !== null) {
      this.ensureWritable(fresh.realRoot);
      for (const link of fresh.links) this.ensureWritable(link.target);
      this.config.agents[id] = { ...this.settings(id), skills: fresh.root, skillsAccess: fresh };
    } else {
      this.config.canonicalSkills = fresh.root;
      this.config.canonicalSkillsAccess = fresh;
    }
    this.save();
    this.audit("path.bind", `${id || "shared"} · skills · ${fresh.root} → ${fresh.realRoot} · ${fresh.links.length} 个链接`);
  }
  private skillPath(root: string, access: SkillAccess | undefined, logical: string, expectedReal?: string): string {
    if (!within(root, logical)) throw new Error("技能路径不在当前授权目录中");
    const actualRoot = resolveSkillPath(root), resolved = resolveSkillPath(logical);
    if (access && (!samePath(access.root, root) || !samePath(access.realRoot, actualRoot.real)))
      throw new Error("技能根目录链接已变化，请重新授权");
    for (const link of resolved.links) {
      if (!access?.links.some(a => samePath(a.path, link.path) && samePath(a.target, link.target) && a.kind === link.kind))
        throw new Error(`技能链接尚未授权或已改变，请重新授权：${link.path}`);
    }
    if (expectedReal && !samePath(resolved.real, expectedReal)) throw new Error("技能链接在预览后变化，请重新授权并预览");
    return resolved.real;
  }
  private allowedTarget(id: AgentId, target: string, logicalTarget?: string): void {
    this.ensureWritable(target);
    const c = this.settings(id);
    if (c.memory && path.resolve(c.memory) === path.resolve(target)) return;
    if (
      c.skills &&
      within(c.skills, logicalTarget || target) &&
      !samePath(c.skills, logicalTarget || target) &&
      TEXT_EXT.has(path.extname(target).toLowerCase()) &&
      TEXT_EXT.has(path.extname(logicalTarget || target).toLowerCase())
    ) {
      this.skillPath(c.skills, c.skillsAccess, logicalTarget || target, target);
      return;
    }
    throw new Error("目标不在当前明确授权的记忆文件或技能目录中");
  }
  private save(): void {
    atomicWrite(
      path.join(this.storage, "config.json"),
      JSON.stringify(this.config, null, 2),
    );
    this.plans.clear();
  }
  bind(id: AgentId | null, kind: PickKind, selected: string): void {
    if (kind === "skills" || kind === "canonicalSkills") {
      if ((kind === "canonicalSkills") !== (id === null)) throw new Error("技能路径参数无效");
      this.bindSkills(id, this.prepareSkills(selected));
      return;
    }
    if (kind === "executable" && id === "claude" && path.extname(selected).toLowerCase() === ".cmd") {
      this.bindNpm(this.resolveNpm(selected));
      return;
    }
    if (
      ![
        "memory",
        "skills",
        "executable",
        "workspace",
        "canonicalMemory",
        "canonicalSkills",
      ].includes(kind)
    )
      throw new Error("路径类型无效");
    if (!this.verifyAudit().valid)
      throw new Error("活动台账校验失败，已阻止授权变更");
    const p = localPath(selected);
    noLinks(p);
    const stat = fs.statSync(p);
    if (kind === "canonicalMemory" || kind === "memory") {
      if (!stat.isFile() || path.extname(p).toLowerCase() !== ".md")
        throw new Error("记忆文件必须是已有的 UTF-8 .md 文件");
      readText(p);
    } else if (kind === "executable") {
      nativeExecutable(p);
    } else if (!stat.isDirectory()) throw new Error("请选择文件夹");
    if (kind === "memory") this.ensureWritable(p);
    if (kind === "canonicalMemory") {
      if (id !== null) throw new Error("共享源参数无效");
      this.config[kind] = p;
    } else {
      if (!id) throw new Error("请选择 Agent");
      const c = this.settings(id);
      this.config.agents[id] = { ...c, [kind]: p };
      if (kind === "executable") delete this.config.agents[id]!.claudeNpm;
    }
    this.save();
    this.audit("path.bind", `${id || "shared"} · ${kind} · ${p}`);
  }
  clear(id: AgentId, kind: PathKind): void {
    if (!["memory", "skills", "executable", "workspace"].includes(kind))
      throw new Error("路径类型无效");
    if (!this.verifyAudit().valid)
      throw new Error("活动台账校验失败，已阻止授权变更");
    const c = this.settings(id);
    delete c[kind];
    if (kind === "executable") delete c.claudeNpm;
    if (kind === "skills") delete c.skillsAccess;
    this.save();
    this.audit("path.clear", `${id} · ${kind}`);
  }
  fileInfo(p = ""): FileInfo {
    if (!p) return { path: "", exists: false };
    try {
      const data = readText(p);
      const s = fs.statSync(p);
      const text = data.toString("utf8");
      return {
        path: p,
        exists: true,
        hash: digest(data),
        bytes: data.length,
        chars: Array.from(text).length,
        lines: text ? text.split(/\r?\n/).length : 0,
        modified: s.mtime.toISOString(),
      };
    } catch (e) {
      return {
        path: p,
        exists: fs.existsSync(p),
        error:
          (e as NodeJS.ErrnoException).code === "ENOENT"
            ? undefined
            : (e as Error).message,
      };
    }
  }
  skillsInfo(p = ""): SkillsInfo {
    if (!p)
      return { path: "", exists: false, count: 0, files: 0, linked: false };
    try {
      const t = scanSkills(p, { inspection: true });
      return {
        path: p,
        exists: true,
        count: t.skills,
        files: t.files.length,
        linked: t.links.length > 0,
        links: t.links,
        warnings: t.warnings,
        truncated: t.truncated,
      };
    } catch (e) {
      const msg = (e as Error).message;
      return {
        path: p,
        exists: fs.existsSync(p),
        count: 0,
        files: 0,
        linked: /链接|junction/.test(msg),
        error: (e as NodeJS.ErrnoException).code === "ENOENT" ? undefined : msg,
      };
    }
  }
  snapshot(
    processes: Partial<Record<AgentId, AgentView["process"]>> = {},
  ): Snapshot {
    const canonicalMemory = this.fileInfo(this.config.canonicalMemory);
    const audit = this.verifyAudit();
    return {
      at: new Date().toISOString(),
      storagePath: this.storage,
      canonicalMemory,
      canonicalSkills: this.skillsInfo(this.config.canonicalSkills),
      agents: this.adapters.map((a) => {
        const c = this.settings(a.id),
          p = this.paths(a.id),
          memory = this.fileInfo(p.memory),
          skills = this.skillsInfo(p.skills);
        const executable =
          p.executable && fs.existsSync(p.executable)
            ? p.executable
            : undefined;
        const state =
          memory.error || skills.error || skills.warnings?.length
            ? "attention"
            : memory.exists && skills.exists
              ? "ready"
              : memory.exists || skills.exists || executable
                ? "partial"
                : "missing";
        return {
          ...a,
          memory,
          skills,
          executable,
          executableApproved: !!(c.executable || c.claudeNpm),
          npmCandidate: a.id === "claude" ? this.npmCandidate() : undefined,
          npmInstallation: a.id === "claude" ? c.claudeNpm : undefined,
          memoryApproved: !!c.memory,
          skillsApproved: !!c.skills,
          workspace: c.workspace,
          state,
          sync:
            memory.hash && canonicalMemory.hash
              ? memory.hash === canonicalMemory.hash
                ? "same"
                : "different"
              : "unknown",
          process: processes[a.id] || { running: false, output: "" },
        };
      }),
      backups: this.backups(),
      logs: audit.rows.slice(-100).reverse(),
      auditValid: audit.valid,
      auditError: audit.error,
    };
  }
  private remember(items: PlanItem[], skipped: string[]): Plan {
    if (
      items.length > MAX_FILES ||
      items.reduce((s, x) => s + x.bytes, 0) > MAX_TOTAL
    )
      throw new Error("单次同步上限为 200 个文件、16 MiB，请减少目标");
    const targets = new Set<string>();
    for (const i of items) {
      const key =
        process.platform === "win32" ? i.target.toLowerCase() : i.target;
      if (targets.has(key))
        throw new Error("多个 Agent 指向相同目标，请单独同步");
      targets.add(key);
    }
    const plan: Plan = {
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      items,
      skipped,
    };
    this.plans.clear();
    this.plans.set(plan.id, {
      view: plan,
      configHash: digest(JSON.stringify(this.config)),
    });
    return plan;
  }
  private item(
    agent: AgentId,
    kind: PlanItem["kind"],
    source: string,
    target: string,
    sourceLogical?: string,
    targetLogical?: string,
  ): PlanItem | null {
    this.allowedTarget(agent, target, targetLogical);
    const data = readText(source),
      after = digest(data),
      before = hashFile(target);
    if (before === after) return null;
    return {
      agent,
      kind,
      source,
      target,
      before,
      after,
      bytes: data.length,
      oldText: before === null ? "" : readText(target).toString("utf8"),
      newText: data.toString("utf8"),
      sourceLogical,
      targetLogical,
    };
  }
  preview(mode: "memory" | "skills", ids: AgentId[]): Plan {
    if (
      !["memory", "skills"].includes(mode) ||
      !Array.isArray(ids) ||
      ids.length < 1 ||
      ids.length > this.adapters.length ||
      new Set(ids).size !== ids.length
    )
      throw new Error("同步参数无效");
    const items: PlanItem[] = [],
      skipped: string[] = [];
    const source =
      mode === "memory"
        ? this.config.canonicalMemory
        : this.config.canonicalSkills;
    if (!source) throw new Error("请先选择共享记忆源或技能源");
    const tree = mode === "skills" ? scanSkills(source) : undefined;
    if (tree?.skipped)
      skipped.push(
        `共享技能源排除 ${tree.skipped} 项：隐藏目录、脚本、二进制、构建产物或重复实际文件`,
      );
    for (const id of ids) {
      const c = this.settings(id);
      const target = c[mode];
      if (!target) {
        skipped.push(
          `${this.adapter(id).name}：尚未明确授权${mode === "memory" ? "记忆文件" : "技能目录"}`,
        );
        continue;
      }
      if (mode === "skills") {
        if (within(source, target) || within(target, source))
          throw new Error("技能源与目标目录不能相同或互相嵌套");
        const sourceRoot = this.skillPath(source, this.config.canonicalSkillsAccess, source);
        const targetRoot = this.skillPath(target, c.skillsAccess, target);
        if (!fs.statSync(targetRoot).isDirectory())
          throw new Error("技能目标目录不存在");
        const targetScan = scanSkills(target, { inspection: true });
        const sourceRoots = [sourceRoot, ...tree!.links.map(l=>l.target)];
        const targetRoots = [targetRoot, ...targetScan.links.map(l=>l.target)];
        if (sourceRoots.some(s=>targetRoots.some(t=>within(s,t) || within(t,s))))
          throw new Error("技能源与目标的实际目录不能相同或互相嵌套；可能已通过链接共享，无需重复复制");
        for (const src of tree!.files) {
          this.skillPath(source, this.config.canonicalSkillsAccess, src.logical, src.real);
          const logicalTarget = path.join(target, src.relative);
          const realTarget = this.skillPath(target, c.skillsAccess, logicalTarget);
          const item = this.item(
            id,
            "skills",
            src.real,
            realTarget,
            src.logical,
            logicalTarget,
          );
          if (item) items.push(item);
        }
      } else {
        const item = this.item(id, "memory", source, target);
        if (item) items.push(item);
      }
    }
    return this.remember(items, skipped);
  }
  private plan(id: string): StoredPlan {
    const plan = this.plans.get(id);
    if (!plan || Date.now() > Date.parse(plan.view.expiresAt))
      throw new Error("预览已失效，请重新生成");
    if (plan.configHash !== digest(JSON.stringify(this.config)))
      throw new Error("配置已变化，请重新预览");
    return plan;
  }
  review(id: string): Plan {
    return this.plan(id).view;
  }
  private preflight(i: PlanItem): void {
    this.allowedTarget(i.agent, i.target, i.targetLogical);
    if (i.sourceLogical) {
      if (!this.config.canonicalSkills) throw new Error("共享技能源授权已撤销");
      this.skillPath(this.config.canonicalSkills, this.config.canonicalSkillsAccess, i.sourceLogical, i.source);
    }
    if (hashFile(i.source) !== i.after || hashFile(i.target) !== i.before)
      throw new Error(`文件在预览后发生变化，已中止：${i.target}`);
  }
  apply(id: string): number {
    const plan = this.plan(id).view;
    this.plans.delete(id);
    plan.items.forEach((i) => this.preflight(i));
    if (!this.verifyAudit().valid)
      throw new Error("活动台账校验失败，已阻止写入");
    // Back up all existing targets before the first target write; one batch per agent.
    for (const agent of new Set(plan.items.map((i) => i.agent))) {
      const files = plan.items
        .filter((i) => i.agent === agent && i.before !== null)
        .map((i) => ({ target: i.target, logicalTarget: i.targetLogical }));
      if (files.length) this.createBackup(agent, files, "同步前自动快照");
    }
    let done = 0;
    try {
      this.audit("sync.begin", `${id} · ${plan.items.length} 个文件`);
      for (const i of plan.items) {
        this.preflight(i);
        const data = readText(i.source);
        if (digest(data) !== i.after) throw new Error("源文件已变化");
        atomicWrite(i.target, data);
        done++;
        if (hashFile(i.target) !== i.after) throw new Error("写入后校验失败");
        this.audit(
          "file.write",
          `${i.agent} · ${i.target} · ${i.after.slice(0, 12)}`,
        );
      }
      this.audit("sync.complete", `${done} 个文件`);
      return done;
    } catch (e) {
      this.audit(
        "sync.failed",
        `已完成 ${done}/${plan.items.length}；自动快照可恢复。${(e as Error).message}`,
      );
      throw e;
    }
  }
  private createBackup(
    agent: AgentId,
    files: Array<string | { target: string; logicalTarget?: string }>,
    label: string,
  ): Manifest {
    if (!this.verifyAudit().valid)
      throw new Error("台账校验失败，已阻止备份操作");
    const entries = files.map((file) => {
      const { target, logicalTarget } = typeof file === "string" ? { target: file, logicalTarget: undefined } : file;
      this.allowedTarget(agent, target, logicalTarget);
      const data = readText(target);
      return { target, logicalTarget, data, hash: digest(data) };
    });
    if (
      entries.length > MAX_FILES ||
      entries.reduce((s, e) => s + e.data.length, 0) > MAX_TOTAL
    )
      throw new Error("备份超出大小限制");
    const id = crypto.randomUUID(),
      at = new Date().toISOString(),
      folder = path.join(this.storage, "backups", id);
    noLinks(folder);
    fs.mkdirSync(folder, { recursive: true });
    const manifest: Manifest = {
      id,
      at,
      agent,
      label,
      files: entries.length,
      entries: [],
    };
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i],
        file = `${i}.txt`;
      atomicWrite(path.join(folder, file), e.data);
      manifest.entries.push({ target: e.target, logicalTarget: e.logicalTarget, file, hash: e.hash });
    }
    atomicWrite(
      path.join(folder, "manifest.json"),
      JSON.stringify(manifest, null, 2),
    );
    this.audit("backup.create", `${agent} · ${id} · ${entries.length} 个文件`);
    return manifest;
  }
  backup(id: AgentId): number {
    const c = this.settings(id),
      files: Array<{ target: string; logicalTarget?: string }> = [];
    if (c.memory) files.push({ target: c.memory });
    if (c.skills) files.push(...scanSkills(c.skills).files.map(f=>({ target: f.real, logicalTarget: f.logical })));
    if (!files.length) throw new Error("请先选择并授权实际记忆文件或技能目录");
    const unique = [...new Map(files.map(f=>[pathKey(f.target),f])).values()];
    this.createBackup(id, unique, "手动快照");
    return unique.length;
  }
  private manifest(id: string): Manifest {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error("无效备份 ID");
    const m = JSON.parse(
      readText(
        path.join(this.storage, "backups", id, "manifest.json"),
      ).toString("utf8"),
    ) as Manifest;
    if (
      !m ||
      m.id !== id ||
      !Array.isArray(m.entries) ||
      m.entries.length > MAX_FILES ||
      !Number.isInteger(m.files) ||
      m.files !== m.entries.length ||
      typeof m.at !== "string" ||
      !Number.isFinite(Date.parse(m.at)) ||
      typeof m.label !== "string" ||
      m.label.length > 200
    )
      throw new Error("备份清单损坏");
    this.adapter(m.agent);
    const files = new Set<string>(),
      targets = new Set<string>();
    for (const e of m.entries) {
      if (
        !e ||
        typeof e.file !== "string" ||
        !/^\d+\.txt$/.test(e.file) ||
        typeof e.hash !== "string" ||
        !/^[a-f0-9]{64}$/.test(e.hash) ||
        typeof e.target !== "string" ||
        (e.logicalTarget !== undefined && typeof e.logicalTarget !== "string")
      )
        throw new Error("备份条目无效");
      const target = localPath(e.target),
        key = process.platform === "win32" ? target.toLowerCase() : target;
      if (e.logicalTarget !== undefined) localPath(e.logicalTarget);
      if (files.has(e.file) || targets.has(key))
        throw new Error("备份条目重复");
      files.add(e.file);
      targets.add(key);
    }
    return m;
  }
  backups(): Backup[] {
    const root = path.join(this.storage, "backups");
    noLinks(root);
    if (!fs.existsSync(root)) return [];
    const all: Backup[] = [];
    for (const id of fs.readdirSync(root)) {
      try {
        const m = this.manifest(id);
        all.push({
          id: m.id,
          at: m.at,
          agent: m.agent,
          label: m.label,
          files: m.files,
        });
      } catch {
        /* Invalid manifests are never exposed as restorable. */
      }
    }
    return all.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 100);
  }
  restore(id: string): Plan {
    const m = this.manifest(id),
      items: PlanItem[] = [];
    for (const e of m.entries) {
      const source = path.join(this.storage, "backups", id, e.file);
      if (hashFile(source) !== e.hash) throw new Error("备份内容校验失败");
      const item = this.item(m.agent, "restore", source, e.target, undefined, e.logicalTarget);
      if (item) items.push(item);
    }
    return this.remember(items, [
      "恢复仅还原快照中已有的文件；不会删除同步后新增的文件。",
    ]);
  }
  verifyAudit(): { valid: boolean; rows: AuditRow[]; error?: string } {
    const file = path.join(this.storage, "activity.jsonl");
    noLinks(file);
    if (!fs.existsSync(file)) return { valid: true, rows: [] };
    if (fs.statSync(file).size > 32 * 1024 * 1024)
      return { valid: false, rows: [], error: "台账超过 32 MiB，请归档后重启" };
    const rows: AuditRow[] = [];
    let prev = "0".repeat(64);
    try {
      for (const line of fs
        .readFileSync(file, "utf8")
        .split("\n")
        .filter(Boolean)) {
        const row = JSON.parse(line) as AuditRow;
        const { hash, ...body } = row;
        if (
          row.seq !== rows.length + 1 ||
          row.prev !== prev ||
          digest(JSON.stringify(body)) !== hash
        )
          throw new Error("台账内容或顺序发生变化");
        rows.push(row);
        prev = hash;
      }
      return { valid: true, rows };
    } catch (e) {
      return { valid: false, rows, error: (e as Error).message };
    }
  }
  audit(action: string, detail: string): void {
    const v = this.verifyAudit();
    if (!v.valid) throw new Error(v.error || "台账校验失败");
    const body = {
      seq: v.rows.length + 1,
      at: new Date().toISOString(),
      action,
      detail: detail.slice(0, 4000),
      prev: v.rows.at(-1)?.hash || "0".repeat(64),
    };
    const row: AuditRow = { ...body, hash: digest(JSON.stringify(body)) };
    const target = path.join(this.storage, "activity.jsonl");
    noLinks(target);
    fs.appendFileSync(target, JSON.stringify(row) + "\n", { mode: 0o600 });
  }
}
