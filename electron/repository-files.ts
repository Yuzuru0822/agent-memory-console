import fs from "node:fs";
import path from "node:path";
import { digest, localPath, noLinks, within } from "./safety";
import { resolveSkillPath } from "./skill-paths";

export const FILE_LIMIT = 32 * 1024 * 1024;
export const TOTAL_LIMIT = 256 * 1024 * 1024;
export const COUNT_LIMIT = 5000;
export const pathKey = (p: string) => process.platform === "win32" ? path.resolve(p).toLowerCase() : path.resolve(p);
export const samePath = (a: string, b: string) => pathKey(a) === pathKey(b);
export function bytes(file: string): Buffer | undefined {
  noLinks(file);
  try {
    const fd = fs.openSync(file, "r");
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size > FILE_LIMIT) throw new Error(`文件不是普通文件或超过 32 MiB：${file}`);
      const data = fs.readFileSync(fd);
      if (data.length > FILE_LIMIT) throw new Error("文件在读取期间超出限制");
      return data;
    } finally { fs.closeSync(fd); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
export const hash = (data?: Buffer) => data === undefined ? null : digest(data);
export function plainText(data?: Buffer): string | undefined {
  if (data === undefined || data.length > 1024 * 1024 || data.includes(0)) return undefined;
  try { return new TextDecoder("utf-8", { fatal: true }).decode(data); } catch { return undefined; }
}
export function relativePath(root: string, relative: string): string {
  if (!relative || path.isAbsolute(relative) || relative.split(/[\\/]/).some(p=>!p || p === "." || p === ".." || p.toLowerCase() === ".git")) throw new Error("仓库相对路径无效");
  const file = localPath(path.join(root, relative));
  if (!within(root, file) || samePath(root, file)) throw new Error("仓库路径越界");
  return file;
}
export interface InventoryFile { logical: string; real: string; relative: string }
export function inventory(root: string, options: { links?: boolean; memory?: boolean } = {}): InventoryFile[] {
  const selected = localPath(root);
  const resolve = (p: string) => {
    const result = options.links ? resolveSkillPath(p).real : noLinks(p);
    if ([p,result].some(file=>file.split(/[\\/]/).some(part=>part.toLowerCase()===".git"))) throw new Error("不能将 Git 元数据作为记忆或技能同步");
    return result;
  };
  const actual = resolve(selected);
  if (!fs.statSync(actual).isDirectory()) throw new Error(`目录不存在：${root}`);
  const files: InventoryFile[] = [], seen = new Set<string>();
  let size = 0, entries = 0;
  function walk(logical: string, depth: number, parents: Set<string>) {
    if (depth > 20) throw new Error("目录超过 20 层");
    const real = resolve(logical), key = pathKey(real);
    if (parents.has(key)) throw new Error(`目录存在循环：${logical}`);
    if (seen.has(key)) return;
    seen.add(key);
    const ancestors = new Set(parents).add(key);
    const directory = fs.opendirSync(real);
    try {
      let entry: fs.Dirent | null;
      while ((entry = directory.readSync())) {
        if (++entries > 20000) throw new Error("目录超过 20000 个条目");
        // A skill can be a Git working tree. Its operational metadata belongs to
        // that repository and is carried by migration, never by file merging.
        if (entry.name.toLowerCase() === ".git") continue;
        if (options.memory && ["node_modules", "dist", "build"].includes(entry.name)) continue;
        const child = path.join(logical, entry.name), target = resolve(child), stat = fs.lstatSync(target);
        if (stat.isDirectory()) walk(child, depth + 1, ancestors);
        else if (stat.isFile()) {
          if (options.memory && ![".md", ".txt", ".json", ".yaml", ".yml"].includes(path.extname(child).toLowerCase())) continue;
          if (stat.size > FILE_LIMIT || (size += stat.size) > TOTAL_LIMIT || files.length >= COUNT_LIMIT) throw new Error("单次仓库同步限 5000 文件 / 256 MiB，单文件 32 MiB");
          files.push({ logical: child, real: target, relative: path.relative(selected, child).split(path.sep).join("/") });
        } else throw new Error(`不支持的文件类型：${child}`);
      }
    } finally { directory.closeSync(); }
  }
  walk(selected, 0, new Set());
  return files.sort((a,b)=>a.relative.localeCompare(b.relative));
}
