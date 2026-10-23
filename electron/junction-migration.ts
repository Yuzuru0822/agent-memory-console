import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { atomicWrite, digest, localPath, noLinks, within } from "./safety";
import { resolveSkillPath, type SkillLink } from "./skill-paths";

const MAX_FILES = 5_000;
const MAX_BYTES = 256 * 1024 * 1024;
const MAX_FILE = 32 * 1024 * 1024;
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
function bytes(file: string): Buffer {
  noLinks(file);
  const fd = fs.openSync(file, "r");
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_FILE) throw new Error("技能文件必须是普通文件且不超过 32 MiB");
    // A bounded read also catches a file that grows after fstat.
    const data = Buffer.alloc(Math.min(stat.size + 1, MAX_FILE + 1));
    let size = 0;
    while (size < data.length) {
      const read = fs.readSync(fd, data, size, data.length - size, null);
      if (!read) break;
      size += read;
    }
    if (size > stat.size || size > MAX_FILE) throw new Error(`扫描期间技能文件发生变化：${file}`);
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
    links: [], warnings: [], skipped: 0, bytes: 0, evidence: [], fingerprint: "" };
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
    const walk = (logical: string, real: string, ancestors: Set<string>, depth: number) => {
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
        if (name.toLowerCase() === ".git") throw new Error(`技能包中包含 .git，不能导入：${path.join(logical, name)}`);
        const child = path.join(logical, name), childRelative = path.relative(root, child);
        if (!within(root, child) || !childRelative) throw new Error("技能相对路径越界");
        const physicalChild = path.join(real, name);
        result.evidence.push(["entry", childRelative, identity(physicalChild)]);
        let resolved: ReturnType<typeof resolveSkillPath>;
        try { resolved = resolveSkillPath(child); }
        catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (repository || !/已失效|循环链接|超过 40 层/.test(message)) throw error;
          result.warnings.push(`失效或循环链接已跳过，原入口会保留在备份：${child}`);
          result.evidence.push(["skipped", childRelative, message]); result.skipped++; continue;
        }
        if (repository && resolved.links.length) throw new Error("仓库技能目录必须使用普通目录和文件，不能含链接");
        if (resolved.real.split(path.sep).some(part => part.toLowerCase() === ".git")) throw new Error("技能链接不能指向 .git 内部目录或文件");
        collect(resolved.links); assertWritable(resolved.real);
        const stat = fs.lstatSync(resolved.real);
        if (stat.isDirectory()) walk(child, resolved.real, new Set(ancestors).add(key(real)), depth + 1);
        else if (stat.isFile()) {
          if (files.has(key(resolved.real))) { result.skipped++; result.evidence.push(["duplicate", childRelative, resolved.real]); continue; }
          files.add(key(resolved.real));
          if (result.files.length >= MAX_FILES) throw new Error("技能包超过 5000 个文件");
          const value = version(resolved.real); result.bytes += value.size;
          if (previewCharacters + (value.textPreview?.length || 0) > 128 * 1024) delete value.textPreview;
          else previewCharacters += value.textPreview?.length || 0;
          if (result.bytes > MAX_BYTES) throw new Error("技能包总大小超过 256 MiB");
          result.files.push({ relative: childRelative, logical: child, version: value });
          result.evidence.push(["file", childRelative, resolved.real, value.hash, value.size]);
        } else throw new Error(`技能包包含不支持的特殊文件：${child}`);
      }
    };
    walk(root, initial.real, new Set(), 0);
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
  return { id, agent, source, sourceReal: from.real, target, backupPath, alreadyLinked, files: ordered,
    links: from.links, warnings: from.warnings, skipped: from.skipped, totalBytes,
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
  const createdDirs: string[] = [], written: typeof prepared = [];
  let renamed = false, linked = false, savedRepositoryBackup = false;
  const mkdir = (directory: string) => {
    const missing: string[] = [];
    let current = noLinks(directory);
    while (!exists(current)) { assertWritable(current); missing.push(current); current = path.dirname(current); }
    for (const item of missing.reverse()) { fs.mkdirSync(item); createdDirs.push(item); }
  };
  try {
    mkdir(fresh.target);
    for (const relative of sourceTree.directories) mkdir(path.join(fresh.target, relative));
    for (const entry of prepared) {
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
    }
    if (inventory(fresh.source, assertWritable).fingerprint !== fresh.sourceFingerprint) throw new Error("迁移期间技能来源发生变化");
    noLinks(path.dirname(fresh.source)); assertWritable(fresh.backupPath);
    if (exists(fresh.backupPath)) throw new Error("原目录备份位置已被占用");
    fs.renameSync(fresh.source, fresh.backupPath); renamed = true;
    fs.symlinkSync(fresh.target, fresh.source, "junction"); linked = true;
    verifiedJunction(fresh.source, fresh.target);
    return { backupPath: fresh.backupPath, ...(savedRepositoryBackup ? { repositoryBackupPath } : {}), imported: written.length };
  } catch (error) {
    const failures: string[] = [];
    if (linked) {
      try { verifiedJunction(fresh.source, fresh.target); fs.unlinkSync(fresh.source); } catch (rollback) { failures.push(String(rollback)); }
    }
    if (renamed) {
      try { if (exists(fresh.source)) throw new Error("原入口被其他进程占用"); fs.renameSync(fresh.backupPath, fresh.source); }
      catch (rollback) { failures.push(String(rollback)); }
    }
    for (const entry of written.reverse()) {
      try {
        assertWritable(entry.output); noLinks(entry.output);
        if (!exists(entry.output) || digest(bytes(entry.output)) !== digest(entry.data)) throw new Error(`文件被其他进程改动，保留现场：${entry.output}`);
        if (entry.original) atomicWrite(entry.output, entry.original); else fs.unlinkSync(entry.output);
      } catch (rollback) { failures.push(String(rollback)); }
    }
    for (const directory of createdDirs.reverse()) {
      try { noLinks(directory); fs.rmdirSync(directory); }
      catch (rollback) { if (!["ENOTEMPTY", "ENOENT"].includes((rollback as NodeJS.ErrnoException).code || "")) failures.push(String(rollback)); }
    }
    if (failures.length) throw new Error(`迁移失败；部分回滚需要手工恢复，原备份位置 ${fresh.backupPath}。${String(error)}；${failures.join("；")}`);
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
