import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const MAX_FILE = 1024 * 1024;
export const MAX_FILES = 200;
export const MAX_TOTAL = 16 * 1024 * 1024;
export const TEXT_EXT = new Set([".md", ".txt", ".json", ".yaml", ".yml"]);
export const digest = (data: string | Buffer) =>
  crypto.createHash("sha256").update(data).digest("hex");
export function within(root: string, target: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return (
    rel === "" ||
    (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel))
  );
}
export function localPath(value: string): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 2000 ||
    value.includes("\0") ||
    !path.isAbsolute(value)
  )
    throw new Error("必须使用绝对本地路径");
  if (
    /^(\\\\|\/\/)/.test(value) ||
    (process.platform === "win32" &&
      (!/^[a-z]:[\\/]/i.test(value) || value.slice(2).includes(":")))
  )
    throw new Error("不支持网络路径、设备路径或备用数据流");
  const resolved = path.resolve(value);
  if (resolved === path.parse(resolved).root)
    throw new Error("不能选择磁盘根目录");
  return resolved;
}
/** Reject reparse points (including directory junctions) in every existing component. */
export function noLinks(value: string): string {
  const target = localPath(value);
  let current = path.parse(target).root;
  for (const part of target
    .slice(current.length)
    .split(path.sep)
    .filter(Boolean)) {
    current = path.join(current, part);
    try {
      if (fs.lstatSync(current).isSymbolicLink())
        throw new Error(`路径包含链接或 junction，已拒绝：${current}`);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") break;
      throw e;
    }
  }
  return target;
}
export function readText(file: string): Buffer {
  noLinks(file);
  const fd = fs.openSync(file, "r");
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_FILE)
      throw new Error("仅支持不超过 1 MiB 的普通文本文件");
    const bytes = fs.readFileSync(fd);
    if (bytes.length > MAX_FILE || bytes.includes(0))
      throw new Error("文件过大或不是 UTF-8 文本");
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return bytes;
  } finally {
    fs.closeSync(fd);
  }
}
export function hashFile(file: string): string | null {
  noLinks(file);
  try {
    return digest(readText(file));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}
/** Check the file format only. This does not establish the publisher's identity or trust. */
export function nativeExecutable(file: string): void {
  noLinks(file);
  if (path.extname(file).toLowerCase() !== ".exe")
    throw new Error("只支持本地原生 .exe，不接受脚本、快捷方式或命令字符串");
  const fd = fs.openSync(file, "r");
  try {
    const stat = fs.fstatSync(fd),
      dos = Buffer.alloc(64);
    if (
      !stat.isFile() ||
      stat.size < 90 ||
      fs.readSync(fd, dos, 0, 64, 0) !== 64 ||
      dos.toString("ascii", 0, 2) !== "MZ"
    )
      throw new Error("所选文件不是 Windows PE 程序");
    const offset = dos.readUInt32LE(60),
      header = Buffer.alloc(26);
    if (
      offset < 64 ||
      offset > stat.size - header.length ||
      fs.readSync(fd, header, 0, header.length, offset) !== header.length ||
      !header.subarray(0, 4).equals(Buffer.from([80, 69, 0, 0]))
    )
      throw new Error("所选文件不是 Windows PE 程序");
    const flags = header.readUInt16LE(22),
      magic = header.readUInt16LE(24);
    if (!(flags & 0x0002) || flags & 0x2000 || ![0x10b, 0x20b].includes(magic))
      throw new Error("所选文件不是可执行的 Windows PE 程序");
  } finally {
    fs.closeSync(fd);
  }
}
export function textTree(root: string): {
  files: string[];
  skipped: number;
  skills: number;
} {
  noLinks(root);
  if (!fs.statSync(root).isDirectory()) throw new Error("技能路径必须是文件夹");
  const files: string[] = [];
  let scanned = 0;
  let total = 0;
  let skipped = 0;
  let skills = 0;
  const walk = (dir: string, depth: number) => {
    if (depth > 10) throw new Error("技能目录嵌套超过 10 层");
    // opendir avoids loading an unbounded directory listing into memory.
    const handle = fs.opendirSync(dir);
    try {
      let entry: fs.Dirent | null;
      while ((entry = handle.readSync())) {
        if (++scanned > 2000)
          throw new Error("技能目录超过 2000 个条目，请选择更小的目录");
        const full = path.join(dir, entry.name);
        if (entry.isSymbolicLink())
          throw new Error(
            "技能目录包含链接或 junction；只读展示，拒绝遍历与同步",
          );
        if (
          entry.name.startsWith(".") ||
          ["node_modules", "dist", "build"].includes(entry.name)
        ) {
          skipped++;
          continue;
        }
        if (entry.isDirectory()) walk(full, depth + 1);
        else if (
          entry.isFile() &&
          TEXT_EXT.has(path.extname(entry.name).toLowerCase())
        ) {
          const bytes = readText(full);
          total += bytes.length;
          if (files.length >= MAX_FILES || total > MAX_TOTAL)
            throw new Error("技能目录超过 200 个文本文件或 16 MiB");
          files.push(full);
          if (entry.name.toUpperCase() === "SKILL.MD") skills++;
        } else skipped++;
      }
    } finally {
      handle.closeSync();
    }
  };
  walk(root, 0);
  return { files: files.sort(), skipped, skills };
}
export function atomicWrite(file: string, data: Buffer | string): void {
  noLinks(file);
  noLinks(path.dirname(file));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  noLinks(file);
  const temp = path.join(
    path.dirname(file),
    `.agent-console-${crypto.randomUUID()}.tmp`,
  );
  let fd: number | undefined;
  try {
    fd = fs.openSync(temp, "wx", 0o600);
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    noLinks(file);
    fs.renameSync(temp, file);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}
