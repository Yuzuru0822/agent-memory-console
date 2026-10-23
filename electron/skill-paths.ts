import fs from "node:fs";
import path from "node:path";
import {
  localPath,
  MAX_FILES,
  MAX_TOTAL,
  noLinks,
  readText,
  TEXT_EXT,
} from "./safety";

export interface SkillLink {
  /** Absolute path of the link in its resolved parent directory. */
  path: string;
  /** Fully resolved, local destination. Never an unchecked readlink value. */
  target: string;
  kind: "directory" | "file";
}

export interface SkillTree {
  files: Array<{ logical: string; real: string; relative: string }>;
  links: SkillLink[];
  skills: number;
  skipped: number;
  warnings: string[];
  truncated: boolean;
}

const MAX_LINKS = 40;
const MAX_ENTRIES = 20_000;
const MAX_DEPTH = 20;
const MAX_WARNINGS = 20;
const key = (value: string) =>
  process.platform === "win32" ? value.toLowerCase() : value;

function linkTarget(raw: string, parent: string): string {
  // Windows readlink may return the NT prefix for a local junction. Strip only
  // these OS-returned drive prefixes, never an arbitrary device or UNC prefix.
  if (process.platform === "win32") {
    if (/^\\\\\?\\[a-z]:\\/i.test(raw)) raw = raw.slice(4);
    else if (/^\\\?\?\\[a-z]:\\/i.test(raw)) raw = raw.slice(4);
    if (/^(\\\\|\/\/|\\\?\?\\)/.test(raw))
      throw new Error("技能链接不支持网络路径或设备路径");
    if (raw.includes(":")) return localPath(raw);
  }
  return localPath(path.isAbsolute(raw) ? raw : path.resolve(parent, raw));
}

/** Resolve one component at a time so an unvalidated UNC junction is never followed. */
export function resolveSkillPath(logical: string): {
  real: string;
  links: SkillLink[];
} {
  const links = new Map<string, SkillLink>();
  const active = new Set<string>();
  let followed = 0;
  const resolve = (input: string, mustExist: boolean): string => {
    const full = localPath(input);
    let current = path.parse(full).root;
    const parts = full.slice(current.length).split(path.sep).filter(Boolean);
    for (let index = 0; index < parts.length; index++) {
      const candidate = localPath(path.join(current, parts[index]));
      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(candidate);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          if (mustExist) throw new Error(`技能链接已失效：${candidate}`);
          return noLinks(path.join(current, ...parts.slice(index)));
        }
        throw error;
      }
      if (stat.isSymbolicLink()) {
        if (++followed > MAX_LINKS)
          throw new Error("技能路径链接超过 40 层，已停止解析");
        const id = key(candidate);
        if (active.has(id)) throw new Error(`技能路径存在循环链接：${candidate}`);
        const target = linkTarget(fs.readlinkSync(candidate), path.dirname(candidate));
        active.add(id);
        let real: string;
        try {
          real = resolve(target, true);
        } finally {
          active.delete(id);
        }
        noLinks(real);
        const actual = fs.lstatSync(real);
        if (!actual.isDirectory() && !actual.isFile())
          throw new Error(`技能链接目标不是普通文件或目录：${candidate}`);
        links.set(id, {
          path: candidate,
          target: real,
          kind: actual.isDirectory() ? "directory" : "file",
        });
        current = real;
        stat = actual;
      } else current = candidate;
      if (index < parts.length - 1 && !stat.isDirectory())
        throw new Error(`技能路径的父级不是目录：${current}`);
    }
    return noLinks(current);
  };
  const real = resolve(logical, false);
  return {
    real,
    links: [...links.values()].sort((a, b) => a.path.localeCompare(b.path)),
  };
}

/** Inspection reads directory metadata only; sync additionally enforces text/size limits. */
export function scanSkills(
  root: string,
  options: { inspection?: boolean } = {},
): SkillTree {
  const logicalRoot = localPath(root);
  const initial = resolveSkillPath(logicalRoot);
  if (!fs.statSync(initial.real).isDirectory())
    throw new Error("技能路径必须是文件夹");
  const result: SkillTree = {
    files: [], links: [], skills: 0, skipped: 0, warnings: [], truncated: false,
  };
  const links = new Map<string, SkillLink>();
  const directories = new Set<string>();
  const files = new Set<string>();
  const skills = new Set<string>();
  let entries = 0;
  let total = 0;
  const collectLinks = (found: SkillLink[]) => {
    for (const link of found) {
      const previous = links.get(key(link.path));
      if (previous && (key(previous.target) !== key(link.target) || previous.kind !== link.kind))
        throw new Error(`扫描期间技能链接目标发生变化：${link.path}`);
      links.set(key(link.path), link);
    }
  };
  const warning = (message: string) => {
    if (result.warnings.length < MAX_WARNINGS) result.warnings.push(message);
  };
  const failOrWarn = (error: unknown, logical: string) => {
    if (!options.inspection) throw error;
    result.skipped++;
    warning(`跳过 ${logical}：${error instanceof Error ? error.message : String(error)}`);
  };
  const walk = (logical: string, real: string, depth: number, ancestors: Set<string>) => {
    if (depth > MAX_DEPTH) {
      result.truncated = true;
      failOrWarn(new Error("技能目录嵌套超过 20 层"), logical);
      return;
    }
    const directoryKey = key(real);
    if (ancestors.has(directoryKey)) {
      failOrWarn(new Error("技能目录存在循环链接"), logical);
      return;
    }
    if (directories.has(directoryKey)) {
      result.skipped++;
      return;
    }
    directories.add(directoryKey);
    const nextAncestors = new Set(ancestors).add(directoryKey);
    noLinks(real);
    const handle = fs.opendirSync(real);
    try {
      let entry: fs.Dirent | null;
      while ((entry = handle.readSync())) {
        if (++entries > MAX_ENTRIES) {
          result.truncated = true;
          failOrWarn(new Error("技能目录超过 20000 个条目，检查结果已截断"), logical);
          return;
        }
        if (entry.name.startsWith(".") || ["node_modules", "dist", "build"].includes(entry.name)) {
          result.skipped++;
          continue;
        }
        const child = path.join(logical, entry.name);
        try {
          // Script and binary files remain excluded, including file links.
          if (!entry.isDirectory() && !entry.isSymbolicLink() && !TEXT_EXT.has(path.extname(entry.name).toLowerCase())) {
            result.skipped++;
            continue;
          }
          const resolved = resolveSkillPath(child);
          collectLinks(resolved.links);
          const stat = fs.lstatSync(resolved.real);
          if (stat.isDirectory()) {
            walk(child, resolved.real, depth + 1, nextAncestors);
          } else if (stat.isFile() && TEXT_EXT.has(path.extname(entry.name).toLowerCase())) {
            const fileKey = key(resolved.real);
            if (entry.name.toUpperCase() === "SKILL.MD") skills.add(fileKey);
            if (files.has(fileKey)) {
              result.skipped++;
              continue;
            }
            if (!options.inspection) {
              total += readText(resolved.real).length;
              if (result.files.length >= MAX_FILES || total > MAX_TOTAL)
                throw new Error("技能同步超过 200 个文本文件或 16 MiB，请选择更小的共享源");
            }
            files.add(fileKey);
            result.files.push({ logical: child, real: resolved.real, relative: path.relative(logicalRoot, child) });
          } else result.skipped++;
        } catch (error) {
          failOrWarn(error, child);
        }
        if (entries > MAX_ENTRIES) return;
      }
    } finally {
      handle.closeSync();
    }
  };
  collectLinks(initial.links);
  walk(logicalRoot, initial.real, 0, new Set());
  result.skills = skills.size;
  result.links = [...links.values()].sort((a, b) => a.path.localeCompare(b.path));
  result.files.sort((a, b) => a.relative.localeCompare(b.relative));
  return result;
}
