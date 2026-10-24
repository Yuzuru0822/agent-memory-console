import fs from "node:fs";
import path from "node:path";
import { noLinks } from "./safety";

function configLines(content: string, file: string): string[] {
  const lines: string[] = [];
  let line = "", quoted = false, comment = false;
  const input = content.replace(/\r\n/g, "\n");
  for (let i = 0; i < input.length; i++) {
    const character = input[i];
    if (comment) {
      // A backslash in a comment never continues the following physical line.
      if (character !== "\n") continue;
      comment = false; lines.push(line); line = ""; continue;
    }
    if (character === "\\") {
      if (input[i + 1] === "\n") { i++; continue; }
      if (i + 1 >= input.length) throw new Error(`Git 配置转义不完整：${file}`);
      line += character + input[++i]; continue;
    }
    if (character === '"') { quoted = !quoted; line += character; continue; }
    if (!quoted && (character === "#" || character === ";")) { comment = true; continue; }
    if (character === "\n") {
      if (quoted) throw new Error(`Git 配置引号未闭合：${file}`);
      lines.push(line); line = ""; continue;
    }
    line += character;
  }
  if (quoted) throw new Error(`Git 配置引号未闭合：${file}`);
  lines.push(line);
  return lines;
}

/** Validate relocatability without invoking Git, loading includes, or running hooks. */
export function validateGitMetadata(directory: string): void {
  noLinks(directory);
  for (const name of ["HEAD", "objects", "refs"]) {
    const file = noLinks(path.join(directory, name));
    let stat: fs.Stats;
    try { stat = fs.lstatSync(file); }
    catch { throw new Error(`.git 目录结构不完整（缺少 ${name}），请先修复仓库：${directory}`); }
    if (name === "HEAD" ? !stat.isFile() : !stat.isDirectory())
      throw new Error(`.git 目录结构无效：${file}`);
  }
  for (const name of ["commondir", "gitdir", "worktrees", "modules", "objects/info/alternates", "objects/info/http-alternates"])
    if (fs.existsSync(path.join(directory, name)))
      throw new Error(`Git 仓库依赖共享工作树、子模块或外部对象路径（${name}），请先转为独立完整工作树：${directory}`);
  for (const name of ["config", "config.worktree"]) {
    const file = noLinks(path.join(directory, name));
    if (!fs.existsSync(file)) continue;
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error(`Git 配置不是普通文本或超过 1 MiB：${file}`);
    let content: string;
    try { content = new TextDecoder("utf-8", { fatal: true }).decode(fs.readFileSync(file)); }
    catch { throw new Error(`Git 配置不是有效 UTF-8，无法安全检查迁移依赖：${file}`); }
    if (content.includes("\0")) throw new Error(`Git 配置包含无效字符：${file}`);
    const lines = configLines(content, file);
    let section = "";
    for (const raw of lines) {
      const line = raw.trim();
      if (!line || /^[#;]/.test(line)) continue;
      if (line.startsWith("[")) {
        const header = /^\[\s*([a-z][a-z0-9.-]*)(?:\s+"(?:[^"\\]|\\.)*")?\s*\]\s*(?:[#;].*)?$/i.exec(line);
        if (!header) throw new Error(`Git 配置节格式不支持，无法安全检查迁移依赖：${file}`);
        section = header[1].toLowerCase().split(".")[0];
        if (["include", "includeif"].includes(section)) throw new Error(`Git 配置包含外部 include，迁移前请合并为独立配置：${file}`);
        continue;
      }
      const setting = /^([a-z][a-z0-9-]*)\s*(?:=|$)/i.exec(line);
      if (!setting || !section) throw new Error(`Git 配置格式不支持，无法安全检查迁移依赖：${file}`);
      const variable = setting[1].toLowerCase();
      if (section === "core" && ["worktree", "hookspath"].includes(variable))
        throw new Error(`Git 配置 core.${variable} 可能依赖迁移外路径，请先改用标准独立工作树：${file}`);
      if (section === "extensions" && variable === "partialclone" || section === "remote" && variable === "promisor")
        throw new Error(`Git 仓库使用部分克隆外部对象，请先补全本地对象：${file}`);
    }
  }
}
