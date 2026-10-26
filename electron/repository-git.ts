import fs from "node:fs";
import path from "node:path";
import git from "isomorphic-git";
import { localPath, noLinks, readText, within } from "./safety";
import { parseManifest } from "./mcp-share-format";

export const REPOSITORY_MARKER = ".agent-console-repository.json";
const OWNER = "agent-memory-console";
const MAX_ENTRIES = 100_000;
const MAX_DEPTH = 40;
const MAX_FILE = 32 * 1024 * 1024;
const MAX_GIT_FILE = 128 * 1024 * 1024;
const MAX_TOTAL = 512 * 1024 * 1024;
const MAX_IO = 500_000;
// A git.add call rewrites the entire index. Bound both concurrent file reads and
// buffered content while amortizing that write across many skill files.
const STAGE_BATCH_FILES = 256;
const STAGE_BATCH_BYTES = 16 * 1024 * 1024;
const pending = new Map<string, Promise<unknown>>();

function locked<T>(root: string, run: () => Promise<T>): Promise<T> {
  const key = process.platform === "win32" ? root.toLowerCase() : root;
  const previous = pending.get(key) || Promise.resolve();
  const operation = previous.catch(() => {}).then(run);
  pending.set(key, operation);
  void operation.finally(() => { if (pending.get(key) === operation) pending.delete(key); }).catch(() => {});
  return operation;
}

function gitMetadataName(name: string): "directory" | "alias" | undefined {
  if (name.toLowerCase() === ".git") return "directory";
  // Match Git's NTFS/HFS reserved-name checks, including short-name aliases.
  const normalized = name.replace(/[\u200C-\u200F\u202A-\u202E\u206A-\u206F\uFEFF]/g, "")
    .split(":")[0].toLowerCase().replace(/[. ]+$/, "");
  return normalized === ".git" || /^\.?git~[1-9]$/.test(normalized) ? "alias" : undefined;
}

/** These directories are preserved as opaque skill data, never opened by central Git. */
function nestedSkillGit(root: string, full: string): boolean {
  const relative = path.relative(root, full).split(path.sep);
  return relative[0]?.toLowerCase() === "skills" &&
    relative.slice(1).some(part => gitMetadataName(part) === "directory");
}

function relativeFile(value: string): string {
  if (typeof value !== "string" || !value || value.length > 2000 || /[\\:\0]/.test(value) || value.startsWith("/"))
    throw new Error(`仓库文件路径无效：${value}`);
  const parts = value.split("/");
  if (parts.some(p => !p || p === "." || p === ".." || /[. ]$/.test(p) || gitMetadataName(p) ||
      /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p)))
    throw new Error(`仓库文件路径无效：${value}`);
  return value;
}

function allowedFile(value: string): boolean {
  relativeFile(value);
  return value === "README.md" || value === REPOSITORY_MARKER ||
    value.startsWith("memories/") || value.startsWith("skills/") || value === "mcp/servers.json";
}

function statusFilter(value: string): boolean {
  return value === "." || value === "memories" || value === "skills" || value === "mcp" || allowedFile(value);
}

/** Every operation rechecks containment and all parent links, including .git. */
function confinedFs(root: string) {
  let calls = 0;
  const check = (input: fs.PathLike, write = false): string => {
    if (++calls > MAX_IO) throw new Error("仓库操作超过文件访问上限");
    if (typeof input !== "string") throw new Error("仓库路径必须是本地字符串");
    const full = localPath(input);
    if (!within(root, full)) throw new Error("Git 操作越出仓库路径，已拒绝");
    if (write && !within(path.join(root, ".git"), full)) throw new Error("Git 只能写入本仓库的 .git 元数据");
    noLinks(full);
    if (nestedSkillGit(root, full)) {
      // isomorphic-git treats ENOENT as absent. Its statusMatrix(ignored:true)
      // and add(force:true) bypass ignore rules, so an ignore file is insufficient.
      throw Object.assign(new Error("内层 Git 元数据不属于中央 Git 的读写范围"), { code: "ENOENT" });
    }
    return full;
  };
  const promises = {
    readFile: async (input: fs.PathLike, options?: unknown) => {
      const full = check(input);
      const fd = fs.openSync(full, "r");
      try {
        const s = fs.fstatSync(fd);
        const limit = within(path.join(root, ".git"), full) ? MAX_GIT_FILE : MAX_FILE;
        if (!s.isFile() || s.size > limit) throw new Error("仓库文件过大或不是普通文件");
        noLinks(full);
        const result = fs.readFileSync(fd, options as { encoding: null });
        if (Buffer.byteLength(result) > limit) throw new Error("仓库文件超过读取上限");
        return result;
      } finally { fs.closeSync(fd); }
    },
    writeFile: async (input: fs.PathLike, data: string | NodeJS.ArrayBufferView, options?: unknown) => {
      const full = check(input, true);
      const size = typeof data === "string" ? Buffer.byteLength(data) : data.byteLength;
      if (size > MAX_GIT_FILE) throw new Error("Git 元数据超过大小上限");
      fs.writeFileSync(full, data, options as fs.WriteFileOptions);
    },
    unlink: async (input: fs.PathLike) => fs.unlinkSync(check(input, true)),
    readdir: async (input: fs.PathLike) => {
      const full = check(input), dir = fs.opendirSync(full);
      const entries: string[] = [];
      try {
        let entry: fs.Dirent | null;
        while ((entry = dir.readSync())) {
          if (entries.length >= MAX_ENTRIES) throw new Error("仓库单目录条目过多");
          if (entry.isSymbolicLink()) throw new Error("仓库内部不能包含链接或 junction");
          if (nestedSkillGit(root, path.join(full, entry.name))) continue;
          entries.push(entry.name);
        }
      } finally { dir.closeSync(); }
      return entries;
    },
    mkdir: async (input: fs.PathLike, options?: unknown) => fs.mkdirSync(check(input, true), options as fs.MakeDirectoryOptions),
    rmdir: async (input: fs.PathLike) => fs.rmdirSync(check(input, true)),
    stat: async (input: fs.PathLike) => fs.statSync(check(input)),
    lstat: async (input: fs.PathLike) => fs.lstatSync(check(input)),
    readlink: async () => { throw new Error("Git 不允许读取仓库链接"); },
    symlink: async () => { throw new Error("Git 不允许创建仓库链接"); },
    chmod: async (input: fs.PathLike, mode: fs.Mode) => fs.chmodSync(check(input, true), mode),
  };
  return { promises };
}

function scan(root: string): void {
  let count = 0, total = 0;
  const walk = (dir: string, depth: number): void => {
    if (depth > MAX_DEPTH) throw new Error("仓库目录嵌套超过 40 层");
    noLinks(dir);
    const handle = fs.opendirSync(dir);
    try {
      let entry: fs.Dirent | null;
      while ((entry = handle.readSync())) {
        if (++count > MAX_ENTRIES) throw new Error("仓库超过 100000 个条目");
        const full = path.join(dir, entry.name);
        const stat = fs.lstatSync(full);
        if (stat.isSymbolicLink()) throw new Error("仓库内部不能包含链接或 junction");
        const metadataName = gitMetadataName(entry.name);
        if (metadataName === "alias") throw new Error("仓库包含 .git 别名，已拒绝导入");
        if (metadataName === "directory" && nestedSkillGit(root, full) && !stat.isDirectory())
          throw new Error("技能内的 .git 必须是完整普通目录，不支持 worktree 指针文件");
        if (stat.isDirectory()) walk(full, depth + 1);
        else if (stat.isFile()) {
          const limit = within(path.join(root, ".git"), full) || nestedSkillGit(root, full) ? MAX_GIT_FILE : MAX_FILE;
          if (stat.size > limit || (total += stat.size) > MAX_TOTAL)
            throw new Error("仓库超过文件或总大小上限（普通文件 32 MiB，总计 512 MiB）");
        } else throw new Error("仓库只允许普通文件和目录");
      }
    } finally { handle.closeSync(); }
  };
  walk(root, 0);
}

function owned(root: string): ReturnType<typeof confinedFs> {
  noLinks(root);
  if (!fs.statSync(root).isDirectory()) throw new Error("仓库路径必须是独立目录");
  scan(root);
  const marker = path.join(root, REPOSITORY_MARKER);
  if (!fs.existsSync(marker) || fs.statSync(marker).size > 4096) throw new Error("该目录不是本应用管理的仓库");
  let value: { version?: unknown; application?: unknown };
  try { value = JSON.parse(fs.readFileSync(marker, "utf8")); }
  catch { throw new Error("仓库标识损坏"); }
  if (value?.version !== 1 || value.application !== OWNER) throw new Error("该目录不是本应用管理的仓库");
  for (const dir of ["memories", "skills", ".git", ".git/objects", ".git/refs"])
    if (!fs.existsSync(path.join(root, dir)) || !fs.statSync(path.join(root, dir)).isDirectory())
      throw new Error("仓库目录结构或 Git 元数据损坏");
  const head = path.join(root, ".git", "HEAD");
  if (!fs.existsSync(head) || fs.statSync(head).size > 256 ||
      fs.readFileSync(head, "utf8").trim() !== "ref: refs/heads/main")
    throw new Error("仓库 HEAD 无效；仅管理 main 分支");
  // Shared object stores and worktrees would escape this repository's boundary.
  for (const name of ["commondir", "objects/info/alternates", "objects/info/http-alternates"])
    if (fs.existsSync(path.join(root, ".git", name))) throw new Error("不支持外部 Git 对象库或共享工作树");
  return confinedFs(root);
}

async function validHead(client: ReturnType<typeof confinedFs>, root: string): Promise<string | undefined> {
  const ref = path.join(root, ".git", "refs", "heads", "main");
  if (!fs.existsSync(ref) && !fs.existsSync(path.join(root, ".git", "packed-refs")))
    throw new Error("仓库 main 分支引用丢失，已拒绝重建历史");
  const oid = await git.resolveRef({ fs: client, dir: root, ref: "HEAD" });
  if (!/^[a-f0-9]{40}$/.test(oid)) throw new Error("仓库提交标识损坏");
  await git.readCommit({ fs: client, dir: root, oid });
  return oid;
}

async function validateTracked(client: ReturnType<typeof confinedFs>, root: string, head?: string): Promise<void> {
  let count = 0;
  await git.walk({ fs: client, dir: root, trees: head ? [git.STAGE(), git.TREE({ ref: head })] : [git.STAGE()],
    map: async (name, entries) => {
      if (++count > MAX_ENTRIES || name.split("/").length > MAX_DEPTH) throw new Error("Git 跟踪文件超过数量或深度上限");
      for (const entry of entries) {
        if (!entry) continue;
        const mode = await entry.mode();
        if (await entry.type() === "tree") {
          if (name !== "." && name !== "memories" && name !== "skills" && name !== "mcp" &&
              !name.startsWith("memories/") && !name.startsWith("skills/"))
            throw new Error(`Git 含有管理范围外的目录：${name}`);
          if (name !== ".") relativeFile(name);
        } else {
          if (mode !== 0o100644 && mode !== 0o100755) throw new Error("Git 索引或提交包含链接、子模块等非普通文件");
          if (!allowedFile(name)) throw new Error(`Git 含有管理范围外的文件：${name}`);
        }
      }
    },
  });
}

async function stageChanges(client: ReturnType<typeof confinedFs>, root: string, rows: Awaited<ReturnType<typeof git.statusMatrix>>): Promise<void> {
  const removed: string[] = [], added: string[] = [];
  for (const [filepath, , work] of rows) {
    if (!allowedFile(filepath)) throw new Error(`Git 含有管理范围外的文件：${filepath}`);
    (work === 0 ? removed : added).push(filepath);
  }
  // remove also supports an array and writes its index just once. Remove first
  // so file/directory replacements cannot leave obsolete index entries behind.
  if (removed.length) await git.remove({ fs: client, dir: root, filepath: removed });
  let batch: string[] = [], size = 0;
  const flush = async () => {
    if (!batch.length) return;
    await git.add({ fs: client, dir: root, filepath: batch, force: true });
    batch = [];
    size = 0;
  };
  for (const filepath of added) {
    // Do not retain path or content caches across operations: links and external
    // edits still receive the same confined filesystem checks at every access.
    const stat = await client.promises.lstat(path.join(root, filepath));
    if (!stat.isFile() || stat.size > MAX_FILE) throw new Error("仓库文件过大或不是普通文件");
    if (batch.length && (batch.length >= STAGE_BATCH_FILES || size + stat.size > STAGE_BATCH_BYTES)) await flush();
    batch.push(filepath);
    size += stat.size;
  }
  await flush();
}

export async function initRepository(input: string): Promise<void> {
  const root = noLinks(localPath(input));
  return locked(root, async () => {
    if (fs.existsSync(root)) {
      if (!fs.statSync(root).isDirectory()) throw new Error("仓库必须使用独立目录");
      const directory = fs.opendirSync(root);
      let nonempty: boolean;
      try { nonempty = directory.readSync() !== null; }
      finally { directory.closeSync(); }
      if (nonempty) {
        const client = owned(root);
        await validateTracked(client, root, await validHead(client, root));
        return;
      }
    } else fs.mkdirSync(root, { recursive: true });
    const client = confinedFs(root);
    await git.init({ fs: client, dir: root, defaultBranch: "main" });
    // Exclusive creation ensures unrelated files are never replaced at initialization.
    for (const dir of ["memories", "skills"]) fs.mkdirSync(path.join(root, dir));
    fs.writeFileSync(path.join(root, REPOSITORY_MARKER), JSON.stringify({ version: 1, application: OWNER }, null, 2) + "\n", { flag: "wx" });
    fs.writeFileSync(path.join(root, "README.md"), "# Agent Memory Repository\n\nLocal memories and complete skill bundles managed by Agent Memory Console.\n\n- `memories/`: agent memory documents\n- `skills/`: shared skills, including their scripts and assets\n\nScripts are stored only; the console never executes them. Git history stays local unless you publish it separately.\n", { flag: "wx" });
    await git.add({ fs: client, dir: root, filepath: ["README.md", REPOSITORY_MARKER] });
    await git.commit({ fs: client, dir: root, message: "Initialize agent memory repository", author: { name: "Agent Memory Console", email: "local@agent-memory-console.invalid" } });
  });
}

export async function commitRepository(input: string, message: string): Promise<{ oid: string; changed: boolean }> {
  const root = noLinks(localPath(input));
  if (typeof message !== "string" || !message.trim() || message.length > 2000 || message.includes("\0"))
    throw new Error("Git 提交说明无效");
  return locked(root, async () => {
    const client = owned(root);
    const head = await validHead(client, root);
    await validateTracked(client, root, head);
    const mcpManifest = path.join(root, "mcp", "servers.json");
    if (fs.existsSync(mcpManifest)) {
      if (fs.statSync(mcpManifest).size > 1024 * 1024 || fs.statSync(mcpManifest).nlink !== 1)
        throw new Error("MCP 模板必须是不超过 1 MiB 的普通独立文件");
      parseManifest(readText(mcpManifest).toString("utf8"));
    }
    const rows = await git.statusMatrix({ fs: client, dir: root, ignored: true, refresh: false,
      filepaths: ["README.md", REPOSITORY_MARKER, "memories", "skills", "mcp/servers.json"],
      filter: statusFilter });
    const changed = rows.filter(([, h, w, s]) => h !== w || h !== s);
    if (!changed.length && head) return { oid: head, changed: false };
    await stageChanges(client, root, changed);
    const oid = await git.commit({ fs: client, dir: root, message: message.trim(), author: { name: "Agent Memory Console", email: "local@agent-memory-console.invalid" } });
    return { oid, changed: true };
  });
}

export async function repositoryHistory(input: string, limit = 20): Promise<{ oid: string; message: string; timestamp: number }[]> {
  const root = noLinks(localPath(input));
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("历史数量必须在 1 到 100 之间");
  return locked(root, async () => {
    const client = owned(root);
    if (!await validHead(client, root)) return [];
    return (await git.log({ fs: client, dir: root, depth: limit })).map(entry => ({
      oid: entry.oid, message: entry.commit.message.trim(), timestamp: entry.commit.committer.timestamp * 1000,
    }));
  });
}

export async function repositoryStatus(input: string): Promise<{ branch: string; dirty: number }> {
  const root = noLinks(localPath(input));
  return locked(root, async () => {
    const client = owned(root);
    await validateTracked(client, root, await validHead(client, root));
    const rows = await git.statusMatrix({ fs: client, dir: root, ignored: true, refresh: false,
      filepaths: ["README.md", REPOSITORY_MARKER, "memories", "skills", "mcp/servers.json"],
      filter: statusFilter });
    return { branch: "main", dirty: rows.filter(([, h, w, s]) => h !== w || h !== s).length };
  });
}

export async function readRevision(input: string, oid: string, filepath: string): Promise<Buffer> {
  const root = noLinks(localPath(input));
  if (!/^[a-f0-9]{40}$/.test(oid) || !allowedFile(filepath)) throw new Error("提交或文件路径无效");
  return locked(root, async () => {
    const client = owned(root);
    await validHead(client, root);
    await git.readCommit({ fs: client, dir: root, oid });
    const result = await git.readBlob({ fs: client, dir: root, oid, filepath });
    if (result.blob.length > MAX_FILE) throw new Error("历史文件超过 32 MiB");
    return Buffer.from(result.blob);
  });
}
