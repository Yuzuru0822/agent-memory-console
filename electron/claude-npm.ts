import fs from "node:fs";
import path from "node:path";
import { localPath, nativeExecutable, noLinks, within } from "./safety";

export interface ClaudeNpmInstallation {
  /** Keep the chosen launcher spelling so an outer junction is re-resolved at launch. */
  launcher: string;
  packageJson: string;
  packageVersion: string;
  entry: string;
  kind: "native" | "node";
  node?: string;
}

export interface NpmDiscoveryOptions {
  prefixes: string[];
  nodeCandidates: string[];
}

const MAX_PATH_ENTRIES = 128;
const MAX_CANDIDATES = 136;
const MAX_METADATA = 64 * 1024;
const MAX_CLI = 32 * 1024 * 1024;
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?(?:\+[0-9A-Za-z][0-9A-Za-z.-]*)?$/;
const pathKey = (value: string) =>
  process.platform === "win32" ? value.toLowerCase() : value;

/** Build candidates only. Discovery does not invoke npm, a shell, or any candidate. */
export function npmDiscoveryPaths(
  home: string,
  env: NodeJS.ProcessEnv,
): NpmDiscoveryOptions {
  const prefixes: string[] = [];
  const nodeCandidates: string[] = [];
  const add = (list: string[], candidate: string | undefined) => {
    if (!candidate) return;
    try {
      const normalized = localPath(candidate);
      if (!list.some((item) => pathKey(item) === pathKey(normalized)))
        list.push(normalized);
    } catch {
      // Ignore relative, network, device, ADS, and otherwise invalid candidates.
    }
  };
  add(prefixes, env.npm_config_prefix);
  add(prefixes, env.NPM_CONFIG_PREFIX);
  try {
    add(prefixes, path.join(localPath(env.APPDATA || path.join(localPath(home), "AppData", "Roaming")), "npm"));
  } catch {
    // An invalid home/APPDATA does not expand into a relative candidate.
  }
  add(prefixes, env.NVM_SYMLINK);
  if (env.NVM_SYMLINK) {
    try {
      add(nodeCandidates, path.join(localPath(env.NVM_SYMLINK), "node.exe"));
    } catch { /* Ignore invalid environment paths. */ }
  }
  const pathValue = env.PATH ?? env.Path ?? env.path ?? "";
  // Slice before processing to bound filesystem work even with a huge PATH.
  for (const item of pathValue.split(path.delimiter, MAX_PATH_ENTRIES)) {
    const candidate = item.startsWith('"') && item.endsWith('"') ? item.slice(1, -1) : item;
    try {
      const directory = localPath(candidate);
      add(prefixes, directory);
      add(nodeCandidates, path.join(directory, "node.exe"));
    } catch { /* Ignore invalid environment paths. */ }
  }
  return { prefixes, nodeCandidates };
}

/** Read at most limit + 1 bytes even if the file grows after its initial stat. */
function boundedText(file: string, limit: number): string {
  noLinks(localPath(file));
  const fd = fs.openSync(file, "r");
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size < 1 || stat.size > limit)
      throw new Error("npm 安装文件必须是大小受限的非空普通文件");
    const chunks: Buffer[] = [];
    let total = 0;
    while (total <= limit) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, limit + 1 - total));
      const count = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (!count) break;
      chunks.push(chunk.subarray(0, count));
      total += count;
    }
    if (!total || total > limit)
      throw new Error("npm 安装文件为空或超出大小限制");
    const bytes = Buffer.concat(chunks, total);
    if (bytes.includes(0)) throw new Error("npm 安装文件不是 UTF-8 文本");
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } finally {
    fs.closeSync(fd);
  }
}

function canonicalNode(candidate: string): string {
  const selected = localPath(candidate);
  if (path.basename(selected).toLowerCase() !== "node.exe")
    throw new Error("旧版 npm Claude Code 需要本地 node.exe");
  // nvm-windows commonly exposes Node through an outer directory junction.
  const actual = noLinks(localPath(fs.realpathSync(selected)));
  if (path.basename(actual).toLowerCase() !== "node.exe")
    throw new Error("Node 运行时路径无效");
  nativeExecutable(actual);
  return actual;
}

/**
 * claude.cmd is a locator only: its body is never read or executed.
 * Package identity/layout and executable format checks are not a publisher signature.
 */
export function resolveClaudeNpm(
  selectedCmd: string,
  options: NpmDiscoveryOptions,
): ClaudeNpmInstallation {
  const launcher = localPath(selectedCmd);
  if (path.basename(launcher).toLowerCase() !== "claude.cmd")
    throw new Error("请选择 npm 安装生成的 claude.cmd");

  // Canonicalize only the outer prefix. Package descendants must never be links.
  const prefix = noLinks(localPath(fs.realpathSync(localPath(path.dirname(launcher)))));
  const actualLauncher = noLinks(localPath(path.join(prefix, path.basename(launcher))));
  const launcherStat = fs.statSync(actualLauncher);
  if (!launcherStat.isFile() || launcherStat.size < 1 || launcherStat.size > MAX_METADATA)
    throw new Error("claude.cmd 必须是非空普通 npm 启动文件");

  const packageRoot = noLinks(localPath(path.join(prefix, "node_modules", "@anthropic-ai", "claude-code")));
  if (!fs.statSync(packageRoot).isDirectory())
    throw new Error("未找到本地 @anthropic-ai/claude-code npm 包");
  const packageJson = noLinks(localPath(path.join(packageRoot, "package.json")));
  let metadata: unknown;
  try {
    metadata = JSON.parse(boundedText(packageJson, MAX_METADATA));
  } catch (error) {
    throw new Error(`无法读取 Claude Code npm 包元数据：${(error as Error).message}`);
  }
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata))
    throw new Error("Claude Code npm 包元数据无效");
  const pkg = metadata as Record<string, unknown>;
  if (pkg.name !== "@anthropic-ai/claude-code")
    throw new Error("npm 包名称必须为 @anthropic-ai/claude-code");
  if (typeof pkg.version !== "string" || pkg.version.length > 128 || !versionPattern.test(pkg.version))
    throw new Error("Claude Code npm 包版本格式不受支持");
  if (!pkg.bin || typeof pkg.bin !== "object" || Array.isArray(pkg.bin))
    throw new Error("Claude Code npm bin 布局不受支持");
  const bin = (pkg.bin as Record<string, unknown>).claude;
  const relative = typeof bin === "string" && bin.startsWith("./") ? bin.slice(2) : bin;
  if (relative !== "cli.js" && relative !== "bin/claude.exe")
    throw new Error("Claude Code npm 入口布局不受支持；仅接受 cli.js 或 bin/claude.exe");
  const entry = noLinks(localPath(path.join(packageRoot, relative)));
  if (!within(packageRoot, entry)) throw new Error("npm 入口不能离开包目录");

  if (relative === "bin/claude.exe") {
    nativeExecutable(entry);
    return { launcher, packageJson, packageVersion: pkg.version, entry, kind: "native" };
  }

  boundedText(entry, MAX_CLI);
  for (const candidate of [path.join(prefix, "node.exe"), ...options.nodeCandidates.slice(0, MAX_CANDIDATES)]) {
    try {
      const node = canonicalNode(candidate);
      return { launcher, packageJson, packageVersion: pkg.version, entry, kind: "node", node };
    } catch {
      // Skip a missing or invalid runtime; none are executed during inspection.
    }
  }
  throw new Error("此 npm Claude Code 使用 cli.js，但未找到可用的本地 node.exe");
}

export function discoverClaudeNpm(
  options: NpmDiscoveryOptions,
): ClaudeNpmInstallation | undefined {
  for (const prefix of options.prefixes.slice(0, MAX_CANDIDATES)) {
    try {
      const launcher = path.join(localPath(prefix), "claude.cmd");
      return resolveClaudeNpm(launcher, options);
    } catch {
      // Read-only best-effort discovery. The caller still needs explicit approval.
    }
  }
  return undefined;
}

export function validateClaudeNpm(
  approved: ClaudeNpmInstallation,
  options: NpmDiscoveryOptions,
): ClaudeNpmInstallation {
  const fresh = resolveClaudeNpm(approved.launcher, options);
  const samePath = (before: string | undefined, after: string | undefined) =>
    before === undefined && after === undefined ||
    typeof before === "string" && typeof after === "string" &&
    pathKey(localPath(before)) === pathKey(localPath(after));
  if (fresh.kind !== approved.kind ||
      !samePath(approved.launcher, fresh.launcher) ||
      !samePath(approved.packageJson, fresh.packageJson) ||
      !samePath(approved.entry, fresh.entry) ||
      !samePath(approved.node, fresh.node))
    throw new Error("Claude Code npm 安装路径或入口已改变，请重新选择并确认");
  // A normal in-place npm update is allowed only after all format/layout checks pass.
  return fresh;
}
