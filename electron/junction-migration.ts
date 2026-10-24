import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { atomicWrite, digest, localPath, noLinks, within } from "./safety";
import { resolveSkillPath, type SkillLink } from "./skill-paths";
import { validateGitMetadata } from "./git-migration";

const MAX_FILES = 5_000;
const MAX_BYTES = 256 * 1024 * 1024;
const MAX_FILE = 32 * 1024 * 1024;
const MAX_GIT_PACK = 128 * 1024 * 1024;
const key = (value: string) => process.platform === "win32" ? value.toLowerCase() : value;
const same = (a: string, b: string) => key(path.resolve(a)) === key(path.resolve(b));
type WritableCheck = (value: string) => void;

export interface JunctionFileVersion {
  path: string;
  hash: string;
  size: number;
  /** Small UTF-8 files only. Scripts are displayed as data and never executed. */
  textPreview?: string;
}
export interface JunctionFile {
  relative: string;
  agent?: JunctionFileVersion;
  repository?: JunctionFileVersion;
  conflict: boolean;
}
export interface JunctionPreview {
  id: string;
  agent: string;
  source: string;
  sourceReal: string;
  target: string;
  backupPath: string;
  alreadyLinked: boolean;
  files: JunctionFile[];
  links: SkillLink[];
  warnings: string[];
  skipped: number;
  totalBytes: number;
  fingerprint: string;
  /** Opaque evidence, re-created and checked before writing. */
  sourceFingerprint: string;
}
export interface JunctionResult {
  backupPath: string;
  repositoryBackupPath?: string;
  imported: number;
  alreadyLinked?: boolean;
}
interface Inventory {
  root: string;
  real: string;
  files: Array<{ relative: string; logical: string; version: JunctionFileVersion }>;
  directories: string[];
  physicalDirectories: string[];
  links: SkillLink[];
  warnings: string[];
  skipped: number;
  bytes: number;
  evidence: unknown[];
  fingerprint: string;
  gitDirectories: Array<{ relative: string; fingerprint: string }>;
}

function exists(value: string): boolean {
  try { fs.lstatSync(value); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
function identity(value: string): unknown {
  const stat = fs.lstatSync(value);
  return [stat.dev, stat.ino, stat.birthtimeMs, stat.isSymbolicLink() ? fs.readlinkSync(value) : null,
    stat.isDirectory() ? "directory" : stat.isFile() ? "file" : stat.isSymbolicLink() ? "link" : "other"];
}
function fileLimit(file: string): number {
  return /(?:^|[\\/])\.git[\\/]objects[\\/]pack[\\/][^\\/]+\.pack$/i.test(file) ? MAX_GIT_PACK : MAX_FILE;
}
function bytes(file: string): Buffer {
  noLinks(file);
  const fd = fs.openSync(file, "r");
  try {
    const stat = fs.fstatSync(fd);
    const limit = fileLimit(file);
    if (!stat.isFile() || stat.size > limit) throw new Error(`技能文件必须是普通文件；普通文件限 32 MiB，Git pack 限 128 MiB：${file}`);
    // A bounded read also catches a file that grows after fstat.
    const data = Buffer.alloc(Math.min(stat.size + 1, limit + 1));
    let size = 0;
    while (size < data.length) {
      const read = fs.readSync(fd, data, size, data.length - size, null);
      if (!read) break;
      size += read;
    }
    if (size > stat.size || size > limit) throw new Error(`扫描期间技能文件发生变化：${file}`);
    return data.subarray(0, size);
  } finally { fs.closeSync(fd); }
}
function version(file: string): JunctionFileVersion {
  const data = bytes(file);
  let textPreview: string | undefined;
  if (data.length <= 64 * 1024 && !data.includes(0)) {
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(data);
      textPreview = text.length > 4_000 ? `${text.slice(0, 4_000)}\n…预览已截断` : text;
    } catch { /* Binary bundle asset. */ }
  }
  return { path: file, hash: digest(data), size: data.length, ...(textPreview === undefined ? {} : { textPreview }) };
}

function inventory(root: string, assertWritable: WritableCheck, repository = false): Inventory {
  root = localPath(root);
  const initial = resolveSkillPath(root);
  if ([root, initial.real].some(value => value.split(path.sep).some(part => part.toLowerCase() === ".git")))
    throw new Error("不能把 .git 内部目录作为技能来源或目标");
  assertWritable(initial.real);
  if (repository) noLinks(root);
  const result: Inventory = { root, real: initial.real, files: [], directories: [], physicalDirectories: [],
    links: [], warnings: [], skipped: 0, bytes: 0, evidence: [], fingerprint: "", gitDirectories: [] };
  let parent = path.dirname(root);
  while (!exists(parent)) parent = path.dirname(parent);
  result.evidence.push(["existing-parent", parent, identity(parent)]);
  const links = new Map<string, SkillLink>();
  const collect = (values: SkillLink[]) => {
    for (const link of values) {
      assertWritable(link.target);
      const prior = links.get(key(link.path));
      if (prior && JSON.stringify(prior) !== JSON.stringify(link)) throw new Error("扫描期间技能链接发生变化");
      links.set(key(link.path), link);
    }
  };
  collect(initial.links);
  if (!exists(root)) {
    if (!repository) throw new Error("Agent 技能目录不存在");
    result.evidence.push(["missing-root", root]);
  } else {
    if (!fs.statSync(initial.real).isDirectory()) throw new Error("技能根路径必须是文件夹");
    result.evidence.push(["root", identity(root), identity(initial.real)]);
    const directories = new Set<string>();
    const files = new Set<string>();
    let entries = 0;
    let previewCharacters = 0;
    const gitRoots: string[] = [];
    const walk = (logical: string, real: string, ancestors: Set<string>, depth: number, gitRoot?: string) => {
      if (depth > 40) throw new Error("技能目录嵌套超过 40 层");
      const relative = path.relative(root, logical);
      result.evidence.push(["directory", relative, real, identity(real)]);
      if (ancestors.has(key(real))) {
        result.warnings.push(`循环链接已跳过，原入口会保留在备份：${logical}`); result.skipped++; return;
      }
      if (directories.has(key(real))) { result.skipped++; return; }
      directories.add(key(real)); result.physicalDirectories.push(real); result.directories.push(relative);
      const names: string[] = [];
      const handle = fs.opendirSync(real);
      try {
        let entry: fs.Dirent | null;
        while ((entry = handle.readSync())) {
          if (++entries > 20_000) throw new Error("技能仓库条目超过 20000 个");
          names.push(entry.name);
        }
      } finally { handle.closeSync(); }
      for (const name of names.sort()) {
        const normalized = name.replace(/[\u200C-\u200F\u202A-\u202E\u206A-\u206F\uFEFF]/g, "").split(":")[0].toLowerCase().replace(/[. ]+$/, "");
        if (name.toLowerCase() !== ".git" && (normalized === ".git" || /^\.?git~[1-9]$/.test(normalized)))
          throw new Error(`技能包含 .git 别名，不能安全迁移：${path.join(logical, name)}`);
        const child = path.join(logical, name), childRelative = path.relative(root, child);
        if (!within(root, child) || !childRelative) throw new Error("技能相对路径越界");
        const physicalChild = path.join(real, name);
        const gitEntry = !gitRoot && name.toLowerCase() === ".git";
        if (gitRoot && name.toLowerCase().endsWith(".lock")) throw new Error(`Git 操作可能尚未结束（${child}）；请等待 Git 完成或确认残留锁已安全处理后再迁移`);
        const childStat = fs.lstatSync(physicalChild);
        if ((gitRoot || gitEntry) && childStat.isSymbolicLink()) throw new Error(`Git 元数据不能包含链接或 junction：${child}`);
        if (gitEntry && !childStat.isDirectory()) throw new Error(`不支持 .git 文件指向的外置工作树；请先转为独立完整仓库：${child}`);
        result.evidence.push(["entry", childRelative, identity(physicalChild)]);
        let resolved: ReturnType<typeof resolveSkillPath>;
        try { resolved = resolveSkillPath(child); }
        catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (repository || gitRoot || gitEntry || !/已失效|循环链接|超过 40 层/.test(message)) throw error;
          result.warnings.push(`失效或循环链接已跳过，原入口会保留在备份：${child}`);
          result.evidence.push(["skipped", childRelative, message]); result.skipped++; continue;
        }
        if (repository && resolved.links.length) throw new Error("仓库技能目录必须使用普通目录和文件，不能含链接");
        if (!gitRoot && !gitEntry && resolved.real.split(path.sep).some(part => part.toLowerCase() === ".git")) throw new Error("技能链接不能直接指向 .git 内部目录或文件；请选择完整工作树");
        collect(resolved.links); assertWritable(resolved.real);
        const stat = fs.lstatSync(resolved.real);
        if (gitEntry) { validateGitMetadata(resolved.real); gitRoots.push(childRelative); }
        if (stat.isDirectory()) walk(child, resolved.real, new Set(ancestors).add(key(real)), depth + 1, gitRoot || (gitEntry ? child : undefined));
        else if (stat.isFile()) {
          if (files.has(key(resolved.real))) { result.skipped++; result.evidence.push(["duplicate", childRelative, resolved.real]); continue; }
          files.add(key(resolved.real));
          if (result.files.length >= MAX_FILES) throw new Error("技能包超过 5000 个文件");
          const value = version(resolved.real); result.bytes += value.size;
          if (gitRoot) delete value.textPreview;
          if (previewCharacters + (value.textPreview?.length || 0) > 128 * 1024) delete value.textPreview;
          else previewCharacters += value.textPreview?.length || 0;
          if (result.bytes > MAX_BYTES) throw new Error("技能包总大小超过 256 MiB");
          result.files.push({ relative: childRelative, logical: child, version: value });
          result.evidence.push(["file", childRelative, resolved.real, value.hash, value.size]);
        } else throw new Error(`技能包包含不支持的特殊文件：${child}`);
      }
    };
    walk(root, initial.real, new Set(), 0);
    const beneath = (prefix: string, value: string) => key(value) === key(prefix) || key(value).startsWith(`${key(prefix)}${path.sep}`);
    result.gitDirectories = gitRoots.map(relative => ({ relative, fingerprint: digest(JSON.stringify([
      result.directories.filter(value => beneath(relative, value)).map(value => path.relative(relative, value)).sort(),
      result.files.filter(file => beneath(relative, file.relative)).map(file => [path.relative(relative, file.relative), file.version.hash, file.version.size]).sort((a,b) => String(a[0]).localeCompare(String(b[0]))),
    ])) }));
  }
  result.links = [...links.values()].sort((a, b) => a.path.localeCompare(b.path));
  result.files.sort((a, b) => a.relative.localeCompare(b.relative));
  result.fingerprint = digest(JSON.stringify([result.evidence, result.links]));
  return result;
}

function inspect(agent: string, source: string, target: string, assertWritable: WritableCheck, id: string): JunctionPreview {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new Error("无效的技能迁移预览标识");
  source = localPath(source); target = noLinks(target);
  noLinks(path.dirname(source)); assertWritable(path.dirname(source)); assertWritable(target);
  const from = inventory(source, assertWritable), to = inventory(target, assertWritable, true);
  for (const git of from.gitDirectories) {
    const existing = to.gitDirectories.find(value => key(value.relative) === key(git.relative));
    if (existing && existing.fingerprint !== git.fingerprint)
      throw new Error(`Git 整仓库冲突：目标同名仓库 ${git.relative} 的历史或配置不同，双方均保留，尚未写入。不会逐文件合并 .git；请先统一仓库版本，或使用不同的技能子目录后重新预览。`);
  }
  const alreadyLinked = fs.lstatSync(source).isSymbolicLink() && same(from.real, target);
  if (!alreadyLinked) {
    for (const actual of from.physicalDirectories) {
      if (within(actual, target) || within(target, actual)) throw new Error("Agent 技能目录与仓库的实际路径必须分离，不能相同或互相嵌套");
    }
    for (const file of from.files) if (within(target, file.version.path)) throw new Error("Agent 技能文件已引用此仓库，请先整理共享入口");
  }
  const backupPath = alreadyLinked ? "" : `${source}.agent-console-original-${id}`;
  if (backupPath) { noLinks(backupPath); assertWritable(backupPath); if (exists(backupPath)) throw new Error("原目录备份位置已被占用，请重新预览"); }
  const files = new Map<string, JunctionFile>();
  for (const file of from.files) files.set(key(file.relative), { relative: file.relative, agent: file.version, conflict: false });
  for (const file of to.files) {
    const existing = files.get(key(file.relative));
    if (existing) { existing.repository = file.version; existing.conflict = existing.agent?.hash !== file.version.hash; }
    else files.set(key(file.relative), { relative: file.relative, repository: file.version, conflict: false });
  }
  // Files cannot be merged over a directory, including an empty one.
  const fromFiles = new Set(from.files.map(file => key(file.relative))), toFiles = new Set(to.files.map(file => key(file.relative)));
  if (from.directories.some(dir => toFiles.has(key(dir))) || to.directories.some(dir => fromFiles.has(key(dir))))
    throw new Error("Agent 与仓库存在同名文件/目录冲突，请先重命名后再迁移");
  const totalBytes = alreadyLinked ? from.bytes : from.bytes + to.bytes;
  if (files.size > MAX_FILES || totalBytes > MAX_BYTES) throw new Error("迁移预览超过 5000 个文件或 256 MiB");
  const ordered = [...files.values()].sort((a, b) => a.relative.localeCompare(b.relative));
  const warnings = [...from.warnings];
  if (from.gitDirectories.length) warnings.push(`完整保留 Git 仓库 ${from.gitDirectories.length} 个；历史与配置仅搬运，hooks 不执行`);
  return { id, agent, source, sourceReal: from.real, target, backupPath, alreadyLinked, files: ordered,
    links: from.links, warnings, skipped: from.skipped, totalBytes,
    fingerprint: digest(JSON.stringify([from.fingerprint, to.fingerprint, from.directories, ordered])), sourceFingerprint: from.fingerprint };
}

export function previewJunction(agent: string, source: string, target: string, assertWritable: WritableCheck): JunctionPreview {
  return inspect(agent, source, target, assertWritable, crypto.randomUUID());
}

function verifiedJunction(source: string, target: string): void {
  noLinks(path.dirname(source)); noLinks(target);
  if (!fs.lstatSync(source).isSymbolicLink() || !same(resolveSkillPath(source).real, target))
    throw new Error("技能入口已经变化，不会删除或替换该入口");
}

/** Check only the link entry; rollback must also work when its target moved or disappeared. */
function junctionEntry(source: string, target: string): string {
  noLinks(path.dirname(source));
  if (!fs.lstatSync(source).isSymbolicLink()) throw new Error("技能入口已被替换，保留现场");
  let raw = fs.readlinkSync(source);
  if (/^\\\\\?\\[a-z]:\\/i.test(raw) || /^\\\?\?\\[a-z]:\\/i.test(raw)) raw = raw.slice(4);
  const destination = localPath(path.isAbsolute(raw) ? raw : path.resolve(path.dirname(source), raw));
  if (!same(destination, target)) throw new Error("技能入口链接已被替换，保留现场");
  return JSON.stringify(identity(source));
}

/** Imports whole bundles as bytes, then switches only the root entry. No scripts are run. */
export function applyJunction(preview: JunctionPreview, choices: Record<string, "agent" | "repository">, assertWritable: WritableCheck): JunctionResult {
  const fresh = inspect(preview.agent, preview.source, preview.target, assertWritable, preview.id);
  if (fresh.fingerprint !== preview.fingerprint || JSON.stringify(fresh) !== JSON.stringify(preview))
    throw new Error("目录、内容或链接已变化，迁移预览失效，请重新预览");
  if (fresh.alreadyLinked) return { backupPath: "", imported: 0, alreadyLinked: true };
  const conflicts = new Set(fresh.files.filter(file => file.conflict).map(file => file.relative));
  for (const name of Object.keys(choices)) if (!conflicts.has(name) || !["agent", "repository"].includes(choices[name])) throw new Error("无效的技能冲突选择");
  for (const name of conflicts) if (!Object.prototype.hasOwnProperty.call(choices, name)) throw new Error(`请选择冲突文件的版本：${name}`);
  const imports = fresh.files.filter(file => file.agent && (!file.repository || (file.conflict && choices[file.relative] === "agent")));
  const sourceTree = inventory(fresh.source, assertWritable);
  if (sourceTree.fingerprint !== fresh.sourceFingerprint) throw new Error("技能来源已变化，请重新预览");
  const prepared = imports.map(file => {
    const data = bytes(file.agent!.path);
    if (digest(data) !== file.agent!.hash) throw new Error("技能来源内容已变化，请重新预览");
    const output = noLinks(path.join(fresh.target, file.relative));
    if (!within(fresh.target, output) || same(output, fresh.target)) throw new Error("技能输出路径越界");
    assertWritable(output);
    const original = file.repository ? bytes(output) : undefined;
    if (original && digest(original) !== file.repository!.hash) throw new Error("仓库内容已变化，请重新预览");
    return { file, output, data, original };
  });
  const repositoryBackupPath = `${fresh.backupPath}-repository`;
  noLinks(repositoryBackupPath); assertWritable(repositoryBackupPath);
  if (exists(repositoryBackupPath)) throw new Error("仓库备份位置已被占用，请重新预览");
  const createdDirs: Array<{ directory: string; stamp: string }> = [], written: typeof prepared = [];
  let renamed = false, linked = false, savedRepositoryBackup = false, preserveTarget = false;
  let targetStamp: string | undefined, parentStamp: string | undefined, linkStamp: string | undefined;
  const directoryStamp = (directory: string): string => {
    noLinks(directory);
    if (!fs.lstatSync(directory).isDirectory()) throw new Error(`目标目录已被替换：${directory}`);
    return JSON.stringify(identity(directory));
  };
  const targetUnchanged = (): boolean => {
    try { return targetStamp !== undefined && parentStamp !== undefined && directoryStamp(fresh.target) === targetStamp && directoryStamp(path.dirname(fresh.target)) === parentStamp; }
    catch { return false; }
  };
  const assertTarget = () => { if (!targetUnchanged()) throw new Error("仓库目标目录或父目录身份发生变化，停止迁移并保留现场"); };
  const initialTarget = inventory(fresh.target, assertWritable, true);
  const originalTargetStamp = exists(fresh.target) ? directoryStamp(fresh.target) : undefined;
  const originalParentStamp = exists(path.dirname(fresh.target)) ? directoryStamp(path.dirname(fresh.target)) : undefined;
  const expectedGit = new Map(initialTarget.gitDirectories.map(value => [key(value.relative), value.fingerprint]));
  sourceTree.gitDirectories.forEach(value => expectedGit.set(key(value.relative), value.fingerprint));
  const importNames = new Set(imports.map(file => key(file.relative)));
  const expectedFiles = new Map(fresh.files.map(file => [key(file.relative), importNames.has(key(file.relative)) ? file.agent!.hash : file.repository!.hash]));
  const verifyTargetContents = () => {
    try {
      assertTarget();
      const current = inventory(fresh.target, assertWritable, true);
      if (current.gitDirectories.length !== expectedGit.size || current.gitDirectories.some(value => expectedGit.get(key(value.relative)) !== value.fingerprint))
        throw new Error("Git 元数据在写入期间变化，已停止技能连接并保留现场");
      if (current.files.length !== expectedFiles.size || current.files.some(value => expectedFiles.get(key(value.relative)) !== value.version.hash))
        throw new Error("仓库目标内容在写入期间变化，已停止技能连接并保留现场");
      assertTarget();
    } catch (error) { preserveTarget = true; throw error; }
  };
  const relocatedTarget = (): string => {
    const find = (parent: string, stamp: string | undefined): string | undefined => {
      if (!stamp) return undefined;
      try {
        noLinks(parent); const handle = fs.opendirSync(parent);
        try {
          let entry: fs.Dirent | null, scanned = 0;
          while ((entry = handle.readSync()) && ++scanned <= 512) {
            if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
            const candidate = path.join(parent, entry.name);
            if (directoryStamp(candidate) === stamp) return candidate;
          }
        } finally { handle.closeSync(); }
      } catch { /* A moved tree outside its old parent is left untouched. */ }
      return undefined;
    };
    const originalParent = path.dirname(fresh.target);
    const movedParent = find(path.dirname(originalParent), parentStamp);
    return find(originalParent, targetStamp) || (movedParent && find(movedParent, targetStamp)) || `${fresh.target}（原目录可能已被外部移动，请核查移动位置）`;
  };
  const mkdir = (directory: string) => {
    const missing: string[] = [];
    let current = noLinks(directory);
    while (!exists(current)) { assertWritable(current); missing.push(current); current = path.dirname(current); }
    for (const item of missing.reverse()) { fs.mkdirSync(item); createdDirs.push({ directory: item, stamp: directoryStamp(item) }); }
  };
  if (inspect(preview.agent, preview.source, preview.target, assertWritable, preview.id).fingerprint !== preview.fingerprint)
    throw new Error("准备写入期间目录、Git 元数据或链接发生变化，请重新预览");
  try {
    mkdir(fresh.target);
    targetStamp = originalTargetStamp || directoryStamp(fresh.target);
    parentStamp = originalParentStamp || directoryStamp(path.dirname(fresh.target));
    assertTarget();
    for (const relative of sourceTree.directories) mkdir(path.join(fresh.target, relative));
    for (const entry of prepared) {
      assertTarget();
      noLinks(entry.output); assertWritable(entry.output);
      if (entry.original) {
        const backup = path.join(repositoryBackupPath, entry.file.relative);
        assertWritable(backup); atomicWrite(backup, entry.original); savedRepositoryBackup = true;
      }
      mkdir(path.dirname(entry.output));
      // The target must still match the bytes captured before any mutations.
      if (entry.original ? !exists(entry.output) || digest(bytes(entry.output)) !== digest(entry.original) : exists(entry.output))
        throw new Error("写入前仓库文件发生变化，迁移已停止");
      atomicWrite(entry.output, entry.data); written.push(entry);
      assertTarget();
    }
    verifyTargetContents();
    if (inventory(fresh.source, assertWritable).fingerprint !== fresh.sourceFingerprint) throw new Error("迁移期间技能来源发生变化");
    noLinks(path.dirname(fresh.source)); assertWritable(fresh.backupPath);
    if (exists(fresh.backupPath)) throw new Error("原目录备份位置已被占用");
    assertTarget();
    fs.renameSync(fresh.source, fresh.backupPath); renamed = true;
    verifyTargetContents();
    fs.symlinkSync(fresh.target, fresh.source, "junction"); linked = true;
    linkStamp = junctionEntry(fresh.source, fresh.target);
    verifyTargetContents();
    verifiedJunction(fresh.source, fresh.target);
    return { backupPath: fresh.backupPath, ...(savedRepositoryBackup ? { repositoryBackupPath } : {}), imported: written.length };
  } catch (error) {
    const failures: string[] = [];
    if (linked) {
      try {
        const currentLink = junctionEntry(fresh.source, fresh.target);
        if (linkStamp && currentLink !== linkStamp) throw new Error("技能入口链接已被替换，保留现场");
        fs.unlinkSync(fresh.source);
      } catch (rollback) { failures.push(String(rollback)); }
    }
    if (renamed) {
      try { if (exists(fresh.source)) throw new Error("原入口被其他进程占用"); fs.renameSync(fresh.backupPath, fresh.source); }
      catch (rollback) { failures.push(String(rollback)); }
    }
    const rollbackTarget = !preserveTarget && targetUnchanged();
    if (!rollbackTarget && (written.length || createdDirs.length)) failures.push(`已写目标树未清理：${relocatedTarget()}；不会写入或删除替代目录`);
    for (const entry of rollbackTarget ? written.reverse() : []) {
      try {
        assertTarget();
        assertWritable(entry.output); noLinks(entry.output);
        if (!exists(entry.output) || digest(bytes(entry.output)) !== digest(entry.data)) throw new Error(`文件被其他进程改动，保留现场：${entry.output}`);
        if (entry.original) atomicWrite(entry.output, entry.original); else fs.unlinkSync(entry.output);
      } catch (rollback) { failures.push(String(rollback)); }
    }
    for (const { directory, stamp } of rollbackTarget ? createdDirs.reverse() : []) {
      try {
        if (directoryStamp(directory) !== stamp) throw new Error(`创建目录已被替换，不清理：${directory}`);
        fs.rmdirSync(directory);
      }
      catch (rollback) { if (!["ENOTEMPTY", "ENOENT"].includes((rollback as NodeJS.ErrnoException).code || "")) failures.push(String(rollback)); }
    }
    if (failures.length) throw new Error(`迁移失败；已保留恢复现场，Agent 入口 ${fresh.source}，原备份位置 ${fresh.backupPath}。${String(error)}；${failures.join("；")}`);
    throw error;
  }
}

/** Removes one verified junction entry only. Repository contents are never deleted. */
export function undoJunction(source: string, target: string, backupPath: string, assertWritable: WritableCheck): void {
  source = localPath(source); target = noLinks(target); backupPath = localPath(backupPath);
  noLinks(path.dirname(source)); noLinks(path.dirname(backupPath));
  const prefix = `${path.basename(source)}.agent-console-original-`;
  if (!same(path.dirname(source), path.dirname(backupPath)) || !path.basename(backupPath).startsWith(prefix) || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(path.basename(backupPath).slice(prefix.length)))
    throw new Error("原目录备份位置与技能入口不匹配");
  assertWritable(path.dirname(source)); assertWritable(target);
  if (!exists(backupPath)) throw new Error("原目录备份不存在");
  const backupStat = fs.lstatSync(backupPath);
  if (!backupStat.isDirectory() && !backupStat.isSymbolicLink()) throw new Error("原目录备份不是目录或链接");
  assertWritable(resolveSkillPath(backupPath).real);
  verifiedJunction(source, target);
  fs.unlinkSync(source);
  try { fs.renameSync(backupPath, source); }
  catch (error) {
    if (!exists(source)) fs.symlinkSync(target, source, "junction");
    throw error;
  }
}
