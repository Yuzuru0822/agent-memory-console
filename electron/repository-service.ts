import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { AgentId } from "../src/shared";
import type { RepositoryAutomation, RepositoryConfig, RepositorySnapshot, RepositoryPlan, RepositoryFile, RepositoryResolution, JunctionView } from "../src/repository-types";
import { ConsoleService } from "./service";
import { atomicWrite, digest, localPath, noLinks, within } from "./safety";
import { resolveSkillPath } from "./skill-paths";
import { initRepository, commitRepository, repositoryHistory, repositoryStatus } from "./repository-git";
import { mergeText } from "./merge";
import { previewJunction, applyJunction, undoJunction, type JunctionPreview } from "./junction-migration";
import { bytes, hash, plainText, inventory, relativePath, samePath, pathKey, TOTAL_LIMIT, COUNT_LIMIT } from "./repository-files";

const defaults: RepositoryAutomation = { enabled: false, intervalSeconds: 60, cleanupEnabled: false, retentionDays: 30, minBackups: 20 };
interface Base { hash: string; blob?: string; agent: AgentId; kind: "memory" | "skills"; relative: string }
interface Receipt { source: string; target: string; backupPath: string; repositoryBackupPath?: string }
interface State { version: 1; bases: Record<string, Base>; links: Partial<Record<AgentId, Receipt>>; lastRun?: string; lastMessage?: string }
interface Pair { view: RepositoryFile; realLocal: string; local?: Buffer; repository?: Buffer; output?: Buffer; localHash: string | null; repositoryHash: string | null }
interface Stored { view: RepositoryPlan; pairs: Pair[]; configHash: string }
interface BackupManifest { version: 1; id: string; root: string; at: string; completed: boolean; files: { target: string; blob?: string; hash: string | null }[] }
const uuid = (value: string) => /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(value);
function readJson<T>(file: string): T {
  noLinks(file);
  const data = bytes(file);
  if (!data) throw new Error(`文件不存在：${file}`);
  return JSON.parse(data.toString("utf8")) as T;
}
export class RepositoryService {
  running = false;
  private plans = new Map<string, Stored>();
  private junctions = new Map<string, { plan: JunctionPreview; agent: AgentId; configHash: string; at: number }>();
  private lastTick = 0;
  private cachedGit?: RepositorySnapshot["git"];
  private cachedHistory: RepositorySnapshot["history"] = [];
  constructor(readonly console: ConsoleService) {}
  private config(): RepositoryConfig {
    const c = this.console.config.repository;
    if (!c) throw new Error("请先选择独立的本地仓库目录");
    this.console.assertWritablePath(c.root);
    noLinks(c.root);
    return c;
  }
  private scopeHash(): string { return digest(JSON.stringify({ repository: this.console.config.repository, agents: this.console.config.agents })); }
  private grantHash(): string {
    const c = this.config();
    return digest(JSON.stringify({ root: c.root, ids: c.agentIds, memoryFolders: c.memoryFolders, agents: c.agentIds.map(id=>this.console.settings(id)) }));
  }
  private area(): string {
    const area = path.join(this.console.storage, "repository-data", digest(this.config().root).slice(0, 24));
    noLinks(area); fs.mkdirSync(area, { recursive: true }); return area;
  }
  private state(): State {
    const file = path.join(this.area(), "state.json");
    if (!fs.existsSync(file)) return { version: 1, bases: {}, links: {} };
    const s = readJson<State>(file);
    if (s.version !== 1 || !s.bases || !s.links || Object.keys(s.bases).length > 30000) throw new Error("仓库同步基线损坏");
    return s;
  }
  private saveState(s: State): void { atomicWrite(path.join(this.area(), "state.json"), JSON.stringify(s, null, 2)); }
  private audit(action: string, detail: string): void { this.console.audit(`repository.${action}`, detail); }
  private guard(): void { if (!this.console.verifyAudit().valid) throw new Error("活动台账校验失败，已停止仓库操作"); }
  private invalidate(): void { this.plans.clear(); this.junctions.clear(); }
  cancelPreview(id?: string): void {
    if (id) { this.plans.delete(id); this.junctions.delete(id); } else this.invalidate();
  }
  async choose(selected: string): Promise<void> {
    this.guard();
    const root = localPath(selected); this.console.assertWritablePath(root);
    if (root.split(/[\\/]/).some(p=>p.toLowerCase()===".git")) throw new Error("不能在其他仓库的 Git 元数据内创建中央仓库");
    for (const agent of this.console.adapters) {
      const c = this.console.settings(agent.id);
      for (const p of [c.skills, c.memory, this.console.config.repository?.memoryFolders[agent.id]]) {
        if (p && (within(root, p) || within(p, root))) throw new Error("中央仓库必须独立于 Agent 的现有记忆和技能路径");
        if (p) {
          const actual=resolveSkillPath(p).real;
          const existingLink=c.skills===p && samePath(actual,path.join(root,"skills")) && this.console.config.repository && samePath(root,this.console.config.repository.root);
          if (!existingLink && (within(root,actual)||within(actual,root))) throw new Error("中央仓库必须独立于 Agent 的实际文件位置");
        }
      }
    }
    await initRepository(root);
    const previous = this.console.config.repository;
    this.console.config.repository = previous && samePath(previous.root, root) ? previous : {
      root, agentIds: this.console.adapters.filter(a=>this.console.settings(a.id).memory || this.console.settings(a.id).skills).map(a=>a.id), memoryFolders: {}, automation: { ...defaults },
    };
    this.console.persistRepository(); this.invalidate();
    this.audit("choose", root);
  }
  members(ids: AgentId[]): void {
    this.guard();
    if (!Array.isArray(ids) || ids.length > this.console.adapters.length || new Set(ids).size !== ids.length) throw new Error("Agent 选择无效");
    ids.forEach(id=>this.console.adapter(id));
    const c = this.config(); c.agentIds = ids; c.automation.enabled = false; delete c.autoGrant;
    this.console.persistRepository(); this.invalidate(); this.audit("members", ids.join(", "));
  }
  memoryFolder(id: AgentId, selected: string): void {
    this.guard(); this.console.adapter(id);
    const root = noLinks(selected), c = this.config(); this.console.assertWritablePath(root);
    if (within(c.root, root) || within(root, c.root)) throw new Error("Agent 记忆目录与中央仓库必须独立");
    inventory(root, { memory: true });
    c.memoryFolders[id] = root; c.automation.enabled = false; delete c.autoGrant;
    this.console.persistRepository(); this.invalidate(); this.audit("memory-folder", `${id} · ${root}`);
  }
  async snapshot(): Promise<RepositorySnapshot> {
    const c = this.console.config.repository;
    let error: string | undefined, s: State | undefined;
    if (c) {
      try {
        s = this.state();
        if (!this.running) {
          this.cachedGit = await repositoryStatus(c.root);
          this.cachedHistory = await repositoryHistory(c.root, 20);
        }
      } catch (e) { error = (e as Error).message; }
    }
    return {
      root: c?.root, git: this.cachedGit, history: this.cachedHistory, running: this.running, error,
      automation: c?.automation || { ...defaults }, lastRun: s?.lastRun, lastMessage: s?.lastMessage,
      backupCount: c ? this.backups().length : 0,
      members: this.console.adapters.map(a=>{
        const skills = this.console.settings(a.id).skills || this.console.paths(a.id).skills;
        let linked = false;
        try { linked = !!c && !!skills && samePath(resolveSkillPath(skills).real, path.join(c.root, "skills")); } catch { /* Invalid candidates remain visible. */ }
        return { id: a.id, name: a.name, selected: !!c?.agentIds.includes(a.id), memoryPath: c?.memoryFolders[a.id] || this.console.settings(a.id).memory,
          skillsPath: skills, linked, originalBackup: s?.links[a.id]?.backupPath };
      }),
    };
  }
  private baseText(base?: Base): string | undefined {
    if (!base?.blob) return undefined;
    if (!/^[a-f0-9]{64}\.bin$/.test(base.blob)) throw new Error("同步基线文件名无效");
    const data = bytes(path.join(this.area(), "bases", base.blob));
    if (hash(data) !== base.hash) throw new Error("同步基线校验失败");
    return plainText(data);
  }
  private validateLocal(file: RepositoryFile): void {
    const c = this.config();
    if (!c.agentIds.includes(file.agent)) throw new Error("Agent 已移出当前纳管范围");
    if (file.kind === "skills") this.console.checkRepositorySkill(file.agent, file.agentPath, resolveSkillPath(file.agentPath).real);
    else {
      const folder = c.memoryFolders[file.agent], memory = this.console.settings(file.agent).memory;
      if (!(folder ? within(folder, file.agentPath) && !samePath(folder, file.agentPath) : memory && samePath(memory, file.agentPath))) throw new Error("记忆路径已失去授权");
      this.console.assertWritablePath(file.agentPath);
    }
    noLinks(file.repositoryPath);
    const allowed = path.join(c.root, file.kind === "skills" ? "skills" : `memories/${file.agent}`);
    if (!within(allowed, file.repositoryPath) || samePath(allowed, file.repositoryPath)) throw new Error("仓库目标越界");
  }
  private localReal(file: RepositoryFile): string {
    return file.kind === "skills" ? this.console.checkRepositorySkill(file.agent, file.agentPath) : noLinks(file.agentPath);
  }
  async preview(): Promise<RepositoryPlan> {
    this.guard(); const c = this.config(), state = this.state();
    await repositoryStatus(c.root);
    if (!c.agentIds.length) throw new Error("请先选择纳管 Agent 并保存选择");
    const pairs: Pair[] = [], warnings: string[] = []; let total = 0;
    for (const id of c.agentIds) {
      const agent = this.console.settings(id);
      for (const kind of ["memory", "skills"] as const) {
        const folder = kind === "memory" ? c.memoryFolders[id] : agent.skills;
        const single = kind === "memory" && !folder ? agent.memory : undefined;
        if (!folder && !single) { warnings.push(`${this.console.adapter(id).name}：尚未授权${kind === "memory" ? "记忆文件/目录" : "技能目录"}，已跳过`); continue; }
        const localRoot = folder || path.dirname(single!);
        const repoRoot = path.join(c.root, kind === "memory" ? `memories/${id}` : "skills");
        const physical=kind==="skills" ? resolveSkillPath(localRoot).real : noLinks(single||localRoot);
        const sharedSkills=kind==="skills" && samePath(physical,repoRoot);
        if (!sharedSkills && (within(c.root,physical)||within(physical,c.root))) throw new Error("Agent 路径与中央仓库实际位置重叠；请使用独立路径或技能连接功能");
        const local = new Map<string, string>();
        if (single) { if (bytes(single)) local.set(path.basename(single), single); }
        else for (const f of inventory(folder!, { links: kind === "skills", memory: kind === "memory" })) local.set(f.relative, f.logical);
        const repository = new Map<string, string>();
        if (fs.existsSync(repoRoot)) for (const f of inventory(repoRoot, { memory: kind === "memory" })) {
          if (!single || f.relative === path.basename(single)) repository.set(f.relative, f.real);
        }
        const names = new Set([...local.keys(), ...repository.keys(), ...Object.values(state.bases).filter(b=>b.agent === id && b.kind === kind && (!single || b.relative === path.basename(single))).map(b=>b.relative)]);
        for (const relative of names) {
          const key = `${id}:${kind}:${relative}`;
          const view: RepositoryFile = { key, agent: id, kind, relative, agentPath: local.get(relative) || (single || relativePath(localRoot, relative)), repositoryPath: repository.get(relative) || relativePath(repoRoot, relative), binary: false, conflict: false, description: "内容一致" };
          this.validateLocal(view);
          const realLocal = this.localReal(view);
          const localData = bytes(realLocal), repoData = bytes(view.repositoryPath);
          view.localExists = localData !== undefined; view.repositoryExists = repoData !== undefined;
          if (!localData && !repoData) continue;
          total += (localData?.length || 0) + (repoData?.length || 0);
          if (pairs.length >= COUNT_LIMIT || total > TOTAL_LIMIT * 2) throw new Error("同步批次超过 5000 文件或 256 MiB，请减少纳管目录");
          const lh = hash(localData), rh = hash(repoData), base = state.bases[key];
          let output: Buffer | undefined;
          view.localText = plainText(localData); view.repositoryText = plainText(repoData); view.baseText = this.baseText(base);
          view.binary = !!localData && view.localText === undefined || !!repoData && view.repositoryText === undefined;
          if (lh === rh) output = localData;
          else if (!localData) { output = repoData; view.description = "仓库 → Agent（保留内容，不传播删除）"; }
          else if (!repoData) { output = localData; view.description = "Agent → 仓库（保留内容，不传播删除）"; }
          else if (base && lh === base.hash) { output = repoData; view.description = "仓库更新 → Agent"; }
          else if (base && rh === base.hash) { output = localData; view.description = "Agent 更新 → 仓库"; }
          else if (!view.binary) {
            const merged = mergeText(view.baseText, view.localText!, view.repositoryText!);
            view.conflict = merged.conflict; view.mergedText = merged.text;
            if (!merged.conflict && merged.text !== undefined) { output = Buffer.from(merged.text); view.description = "三方合并：双方独立修改"; }
          } else view.conflict = true;
          if (view.conflict) view.description = "双方内容冲突，请选择保留版本或手动合并";
          if (output) view.mergedText = plainText(output);
          pairs.push({ view, realLocal, local: localData, repository: repoData, localHash: lh, repositoryHash: rh, output });
        }
      }
    }
    const groups = new Map<string, Pair[]>();
    for (const pair of pairs.filter(p=>p.view.kind === "skills")) {
      const key = pathKey(pair.view.repositoryPath); groups.set(key, [...(groups.get(key) || []), pair]);
    }
    for (const group of groups.values()) {
      if (group.length<2) continue;
      let conflict=group.some(p=>p.view.conflict), merged=group[0].repository;
      const updates=[...new Map(group.filter(p=>p.output!==undefined && hash(p.output)!==p.repositoryHash).map(p=>[hash(p.output),p.output!])).values()];
      for (const update of updates) {
        if (conflict) break;
        if (merged===undefined || hash(merged)===group[0].repositoryHash) merged=update;
        else {
          const base=plainText(group[0].repository), current=plainText(merged), next=plainText(update);
          if (current===undefined || next===undefined) { conflict=true; break; }
          const result=mergeText(base,current,next);
          if (result.conflict || result.text===undefined) { conflict=true; break; }
          merged=Buffer.from(result.text);
        }
      }
      if (conflict) group.forEach(p=>{ p.view.conflict=true; p.view.description="多个 Agent 对同一技能给出不同版本，请统一选择结果"; p.output=undefined; });
      else if (merged!==undefined) group.forEach(p=>{ p.output=merged; p.view.mergedText=plainText(merged); if(hash(merged)!==p.localHash||hash(merged)!==p.repositoryHash) p.view.description="汇总共享技能修改，同步到所有选定 Agent"; });
    }
    let previewBudget = 512 * 1024;
    for (const p of pairs) {
      for (const field of ["localText","repositoryText","baseText","mergedText"] as const) {
        const value=p.view[field]; if (value===undefined) continue;
        const limit=Math.min(12000,previewBudget);
        if (value.length>limit) { p.view[field]=value.slice(0,limit)+"\n…预览已截断，请选择完整版本；手动编辑不可用"; p.view.previewTruncated=true; }
        previewBudget-=Math.min(value.length,limit);
      }
    }
    const view: RepositoryPlan = { id: crypto.randomUUID(), expiresAt: new Date(Date.now() + 300000).toISOString(), files: pairs.filter(p=>p.view.conflict || hash(p.output) !== p.localHash || hash(p.output) !== p.repositoryHash).map(p=>p.view), warnings };
    this.plans.clear(); this.plans.set(view.id, { view, pairs, configHash: this.scopeHash() }); return view;
  }
  review(id: string): RepositoryPlan {
    const p = this.plans.get(id);
    if (!p || Date.now() > Date.parse(p.view.expiresAt) || p.configHash !== this.scopeHash()) throw new Error("仓库预览已过期或授权变化，请重新预览");
    return p.view;
  }
  private preflight(pair: Pair): void {
    this.validateLocal(pair.view);
    if (!samePath(this.localReal(pair.view),pair.realLocal)) throw new Error(`预览后实际路径或链接发生变化：${pair.view.relative}`);
    if (hash(bytes(this.localReal(pair.view))) !== pair.localHash || hash(bytes(pair.view.repositoryPath)) !== pair.repositoryHash) throw new Error(`预览后文件或链接发生变化：${pair.view.relative}`);
  }
  private createBackup(writes: { target: string; before?: Buffer }[]): { folder: string; manifest: BackupManifest } {
    const id = crypto.randomUUID(), folder = path.join(this.area(), "backups", id);
    noLinks(folder); fs.mkdirSync(folder, { recursive: true });
    const manifest: BackupManifest = { version: 1, id, root: this.config().root, at: new Date().toISOString(), completed: false, files: [] };
    writes.forEach((w,i)=>{
      const blob = w.before === undefined ? undefined : `${i}.bin`;
      if (blob) atomicWrite(path.join(folder, blob), w.before!);
      manifest.files.push({ target: w.target, blob, hash: hash(w.before) });
    });
    atomicWrite(path.join(folder, "manifest.json"), JSON.stringify(manifest, null, 2));
    return { folder, manifest };
  }
  async apply(id: string, choices: Record<string, RepositoryResolution> = {}): Promise<number> {
    this.guard(); this.review(id);
    const plan = this.plans.get(id)!; this.plans.delete(id);
    if (!choices || typeof choices !== "object" || Array.isArray(choices)) throw new Error("合并选择无效");
    const writes = new Map<string, { target: string; before?: Buffer; after: Buffer }>();
    for (const pair of plan.pairs) {
      const choice = choices[pair.view.key];
      if (pair.view.conflict) {
        if (!choice || !["agent", "repository", "manual"].includes(choice.choice)) throw new Error("仍有未解决的合并冲突");
        if (choice.choice === "manual") {
          if (pair.view.binary || pair.view.previewTruncated || typeof choice.text !== "string" || Buffer.byteLength(choice.text) > 1024 * 1024 || choice.text.includes("\0")) throw new Error("手动合并仅支持完整预览的文本");
          pair.output = Buffer.from(choice.text);
        } else if (choice.choice === "agent" && choice.sourceKey) {
          const source=plan.pairs.find(p=>p.view.key===choice.sourceKey);
          if (!source || source.view.kind!=="skills" || pair.view.kind!=="skills" || !samePath(source.view.repositoryPath,pair.view.repositoryPath)) throw new Error("共享技能版本来源无效");
          pair.output=source.local;
        } else pair.output = choice.choice === "agent" ? pair.local : pair.repository;
      }
      if (pair.output === undefined) throw new Error("缺少合并结果；不会传播删除");
      this.preflight(pair);
      for (const [target,before] of [[pair.realLocal,pair.local], [pair.view.repositoryPath,pair.repository]] as const) {
        const key = pathKey(target), previous = writes.get(key);
        if (previous && hash(previous.after) !== hash(pair.output)) throw new Error("不同 Agent 的选择仍会覆盖同一个实际文件，请统一冲突结果");
        writes.set(key, { target, before, after: pair.output });
      }
    }
    const changed = [...writes.values()].filter(w=>hash(w.before) !== hash(w.after));
    const c = this.config(), state = this.state();
    this.running = true;
    let backup: ReturnType<RepositoryService["createBackup"]> | undefined;
    const written: typeof changed = [];
    try {
      const checkpoint=await commitRepository(c.root, "同步前保存仓库已有修改");
      if (plan.configHash!==this.scopeHash()) throw new Error("授权范围在 Git 检查期间变化，请重新预览");
      plan.pairs.forEach(p=>this.preflight(p));
      if (changed.length) backup = this.createBackup(changed);
      for (const write of changed) {
        if (plan.configHash!==this.scopeHash()) throw new Error("授权范围已变化");
        plan.pairs.filter(p=>samePath(p.view.repositoryPath,write.target) || samePath(p.realLocal,write.target)).forEach(p=>{
          // Recheck authorization and link mapping; own earlier writes may have changed content.
          this.validateLocal(p.view);
          if (!samePath(this.localReal(p.view),p.realLocal)) throw new Error("执行期间链接实际位置变化");
        });
        if (hash(bytes(write.target)) !== hash(write.before)) throw new Error("执行期间目标被外部修改");
        atomicWrite(write.target, write.after); written.push(write);
        if (hash(bytes(write.target)) !== hash(write.after)) throw new Error("写入校验失败");
      }
      const committed=await commitRepository(c.root, `双向同步 ${changed.length} 个文件`);
      if (plan.configHash!==this.scopeHash()) throw new Error("授权范围在 Git 提交期间变化");
      for (const p of plan.pairs) {
        const h = hash(p.output)!;
        const blob = plainText(p.output) === undefined ? undefined : `${h}.bin`;
        if (blob && (state.bases[p.view.key]?.hash!==h || state.bases[p.view.key]?.blob!==blob)) atomicWrite(path.join(this.area(), "bases", blob), p.output!);
        state.bases[p.view.key] = { hash: h, blob, agent: p.view.agent, kind: p.view.kind, relative: p.view.relative };
      }
      state.lastRun = new Date().toISOString(); state.lastMessage = `双向同步完成：${changed.length} 个文件；不传播删除`;
      this.saveState(state);
      if (backup) { backup.manifest.completed = true; atomicWrite(path.join(backup.folder,"manifest.json"),JSON.stringify(backup.manifest,null,2)); }
      if (changed.length || checkpoint.changed || committed.changed) this.audit("sync", `${changed.length} 个文件 · ${c.root}`);
      return changed.length;
    } catch (error) {
      let recovered = 0;
      for (const write of written.reverse()) {
        try {
          noLinks(write.target);
          if (hash(bytes(write.target)) !== hash(write.after)) continue;
          if (write.before === undefined) fs.unlinkSync(write.target); else atomicWrite(write.target,write.before);
          recovered++;
        } catch { /* Keep incomplete backups for manual recovery. */ }
      }
      this.audit("sync-failed", `已回退 ${recovered}/${written.length} 项；快照 ${backup?.folder || "未写入"}；${String(error)}`);
      throw new Error(`${String(error)}；已回退 ${recovered}/${written.length} 项，写前快照已保留`);
    } finally { this.running = false; }
  }
  async commit(): Promise<string> {
    this.guard(); const result = await commitRepository(this.config().root,"手动保存记忆与技能仓库");
    this.audit("commit", result.oid); return result.changed ? `已提交 ${result.oid.slice(0,8)}` : "仓库没有未提交变更";
  }
  automation(options: RepositoryAutomation): void {
    this.guard(); const c = this.config();
    if (!options || typeof options.enabled !== "boolean" || typeof options.cleanupEnabled !== "boolean" ||
      !Number.isInteger(options.intervalSeconds) || options.intervalSeconds < 30 || options.intervalSeconds > 3600 ||
      !Number.isInteger(options.retentionDays) || options.retentionDays < 1 || options.retentionDays > 3650 ||
      !Number.isInteger(options.minBackups) || options.minBackups < 1 || options.minBackups > 1000) throw new Error("自动任务参数无效");
    if (options.enabled && !c.agentIds.length) throw new Error("请选择纳管 Agent");
    c.automation = { ...options }; c.autoGrant = options.enabled ? this.grantHash() : undefined;
    this.console.persistRepository(); this.lastTick = Date.now(); this.invalidate();
    this.audit("automation", JSON.stringify(options));
  }
  async tick(now = Date.now()): Promise<void> {
    const c = this.console.config.repository;
    if (!c || this.running || now - this.lastTick < c.automation.intervalSeconds * 1000) return;
    if ([...this.plans.values()].some(p=>Date.parse(p.view.expiresAt)>now) || [...this.junctions.values()].some(p=>now-p.at<300000)) return;
    this.lastTick = now;
    if (!c.automation.enabled && !c.automation.cleanupEnabled) return;
    try {
      if (c.automation.enabled) {
        if (c.autoGrant !== this.grantHash()) {
          c.automation.enabled = false; this.console.persistRepository();
          throw new Error("授权范围已变化，自动同步已暂停，请重新启用");
        }
        const plan = await this.preview();
        if (plan.files.some(f=>f.conflict)) throw new Error("自动同步遇到冲突，整批暂缓；请预览并解决冲突");
        await this.apply(plan.id);
      }
      if (c.automation.cleanupEnabled) this.cleanup(now);
    } catch (error) {
      const s = this.state(), message = (error as Error).message;
      if (s.lastMessage !== message && this.console.verifyAudit().valid) this.audit("auto-paused",message);
      s.lastRun = new Date(now).toISOString(); s.lastMessage = message; this.saveState(s);
    }
  }
  private backups(): { folder: string; manifest: BackupManifest }[] {
    const root = path.join(this.area(), "backups"); noLinks(root);
    if (!fs.existsSync(root)) return [];
    const result: { folder: string; manifest: BackupManifest }[] = [];
    for (const name of fs.readdirSync(root)) {
      if (!uuid(name)) continue;
      try {
        const folder = path.join(root,name); noLinks(folder);
        const m = readJson<BackupManifest>(path.join(folder,"manifest.json"));
        if (m.version === 1 && m.id === name && samePath(m.root,this.config().root) && Array.isArray(m.files) && Number.isFinite(Date.parse(m.at))) result.push({folder,manifest:m});
      } catch { /* Unrecognized or linked entries are never eligible for removal. */ }
    }
    return result.sort((a,b)=>Date.parse(b.manifest.at)-Date.parse(a.manifest.at));
  }
  cleanup(now = Date.now()): number {
    this.guard(); const c = this.config(); let count = 0;
    const eligible = this.backups().filter(b=>b.manifest.completed);
    for (const item of eligible.slice(c.automation.minBackups)) {
      if (Date.parse(item.manifest.at) >= now - c.automation.retentionDays * 86400000) continue;
      const expected = new Set(["manifest.json", ...item.manifest.files.map(f=>f.blob).filter((x):x is string=>!!x)]);
      if ([...expected].some(f=>f !== "manifest.json" && !/^\d+\.bin$/.test(f))) continue;
      noLinks(item.folder);
      const actual = fs.readdirSync(item.folder);
      if (actual.length !== expected.size || actual.some(name=>!expected.has(name))) continue;
      for (const name of actual) { const f=noLinks(path.join(item.folder,name)); if (!fs.lstatSync(f).isFile()) throw new Error("清理范围包含非普通文件，已停止"); }
      for (const name of actual) fs.unlinkSync(noLinks(path.join(item.folder,name)));
      fs.rmdirSync(item.folder); count++;
    }
    // Original Agent directories and Git history are intentionally outside this scope.
    if (count) this.audit("cleanup", `清理 ${count} 份过期快照，保留至少 ${c.automation.minBackups} 份及最近 ${c.automation.retentionDays} 天`);
    let temporary = 0;
    const internal = [this.area(),path.join(this.area(),"bases"),path.join(this.area(),"backups"),...this.backups().map(b=>b.folder)];
    for (const folder of internal) {
      noLinks(folder); if (!fs.existsSync(folder)) continue;
      for (const name of fs.readdirSync(folder)) {
        if (!/^\.agent-console-[0-9a-f]{8}-[0-9a-f-]{27}\.tmp$/i.test(name)) continue;
        const target=noLinks(path.join(folder,name)), stat=fs.lstatSync(target);
        if (stat.isFile() && stat.mtimeMs<now-86400000) { fs.unlinkSync(target); temporary++; }
      }
    }
    if (temporary) this.audit("cleanup-temp",`清理 ${temporary} 个本程序内部超过 24 小时的残留临时文件`);
    return count;
  }
  linkPreview(id: AgentId): JunctionView {
    this.guard(); this.console.adapter(id); const c = this.config();
    if (!c.agentIds.includes(id)) throw new Error("请先将 Agent 加入纳管选择");
    const source = this.console.settings(id).skills || this.console.paths(id).skills;
    if (!source) throw new Error("未发现技能目录，请先在 Agent 详情选择目录");
    const plan = previewJunction(id, source, path.join(c.root,"skills"), p=>this.console.assertWritablePath(p));
    this.junctions.clear(); this.junctions.set(plan.id,{plan,agent:id,configHash:this.scopeHash(),at:Date.now()});
    return { id:plan.id,agent:id,source:plan.source,target:plan.target,backupPath:plan.backupPath,alreadyLinked:plan.alreadyLinked,
      files:plan.files.map(f=>({relative:f.relative,conflict:f.conflict,bytes:f.agent?.size||f.repository?.size||0,localText:f.agent?.textPreview,repositoryText:f.repository?.textPreview})), warnings:plan.warnings };
  }
  linkReview(id: string): JunctionView {
    const p=this.junctions.get(id);
    if (!p || p.configHash!==this.scopeHash() || Date.now()-p.at>300000) throw new Error("链接预览已失效，请重新预览");
    return { id,agent:p.agent,source:p.plan.source,target:p.plan.target,backupPath:p.plan.backupPath,alreadyLinked:p.plan.alreadyLinked,files:[],warnings:p.plan.warnings };
  }
  async linkApply(id: string, choices: Record<string,"agent"|"repository">): Promise<string> {
    this.guard(); this.linkReview(id); const stored=this.junctions.get(id)!; this.junctions.delete(id);
    const c=this.config(), s=this.state(), previous=s.links[stored.agent]; this.running=true;
    let linked=false;
    try {
      await commitRepository(c.root,"技能连接前保存仓库");
      if (stored.configHash!==this.scopeHash()) throw new Error("授权范围在 Git 检查期间变化，请重新预览");
      // Save the recovery receipt before renaming any Agent directory, including across crashes.
      if (!stored.plan.alreadyLinked) {
        s.links[stored.agent]={source:stored.plan.source,target:stored.plan.target,backupPath:stored.plan.backupPath};
        this.saveState(s);
      }
      const result=await applyJunction(stored.plan,choices,p=>this.console.assertWritablePath(p));
      linked=true;
      if (result.backupPath) s.links[stored.agent]={source:stored.plan.source,target:stored.plan.target,backupPath:result.backupPath,repositoryBackupPath:result.repositoryBackupPath};
      this.saveState(s);
      this.console.bindSkills(stored.agent,this.console.prepareSkills(stored.plan.source));
      c.automation.enabled=false; delete c.autoGrant; this.console.persistRepository();
      await commitRepository(c.root,`连接 ${stored.agent} 技能仓库`);
      this.audit("link", `${stored.agent} · ${stored.plan.source} → ${stored.plan.target} · 原目录 ${result.backupPath || "已连接"}${result.repositoryBackupPath ? " · 仓库覆盖前副本 " + result.repositoryBackupPath : ""}`);
      return result.backupPath ? `技能已连接到仓库；原目录保存在 ${result.backupPath}` : "技能已经连接到此仓库";
    } catch (error) {
      if (!linked && stored.plan.backupPath && !fs.existsSync(stored.plan.backupPath)) {
        if (previous) s.links[stored.agent]=previous; else delete s.links[stored.agent];
        this.saveState(s);
      }
      if (linked) throw new Error(`技能连接已创建，但后续记录未完成：${String(error)}。原目录保留在 ${stored.plan.backupPath || previous?.backupPath || "原有恢复记录"}；可使用解除连接恢复。`);
      throw error;
    } finally { this.running=false; }
  }
  unlinkReview(id: AgentId): Receipt {
    this.console.adapter(id); const r=this.state().links[id]; if (!r) throw new Error("没有可恢复的原目录记录"); return r;
  }
  async unlink(id: AgentId): Promise<void> {
    this.guard(); const s=this.state(), receipt=this.unlinkReview(id);
    await undoJunction(receipt.source,receipt.target,receipt.backupPath,p=>this.console.assertWritablePath(p));
    delete s.links[id]; this.saveState(s);
    // The original folder can contain broken links; restore its path without silently granting them.
    const agent=this.console.settings(id); agent.skills=receipt.source; delete agent.skillsAccess;
    this.config().automation.enabled=false; delete this.config().autoGrant;
    this.console.persistRepository(); this.invalidate(); this.audit("unlink",`${id} · ${receipt.source} · 仓库内容保留`);
  }
}
