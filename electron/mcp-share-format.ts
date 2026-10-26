import type { McpManifest, McpProfile, McpTemplate } from "../src/mcp-types";

const BAD_KEYS = new Set(["__proto__", "constructor", "prototype"]);
export const VARIABLE = /^[A-Z][A-Z0-9_]{0,63}$/;
export const SERVER_ID = /^[a-zA-Z][a-zA-Z0-9._-]{0,63}$/;
export const PROFILES: McpProfile[] = ["claude", "workbuddy", "trae", "qoder-cli", "qoder-ide", "generic"];
export const EMPTY_MANIFEST: McpManifest = { version: 1, servers: {} };
export const json = (value: unknown): string => JSON.stringify(value, null, 2) + "\n";
export const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const PRIVATE_REFERENCE = /^(?:(?:Bearer|Basic) )?\$\{[A-Z][A-Z0-9_]{0,63}\}$/;

/** JSON.parse accepts duplicate keys; reject those rather than silently replacing a definition. */
export function strictJson(text: string): unknown {
  if (typeof text !== "string" || Buffer.byteLength(text) > 1024 * 1024 || text.includes("\0")) throw new Error("JSON 文件必须小于 1 MiB");
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error("只接受严格 JSON；请先修复格式，不支持注释或尾逗号"); }
  const tokens = text.match(/"(?:\\.|[^"\\])*"|[{}\[\]:,]|[^\s{}\[\]:,]+/g) || [];
  if (tokens.length > 50000) throw new Error("JSON 条目过多");
  const stack: (Set<string> | null)[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === "{" || token === "[") {
      stack.push(token === "{" ? new Set() : null);
      if (stack.length > 40) throw new Error("JSON 嵌套超过 40 层");
    } else if (token === "}" || token === "]") stack.pop();
    else if (token.startsWith('"') && tokens[i + 1] === ":") {
      const key = JSON.parse(token) as string, keys = stack[stack.length - 1];
      if (BAD_KEYS.has(key) || !keys || keys.has(key)) throw new Error("JSON 含重复或不安全的属性名");
      keys.add(key);
    }
  }
  return value;
}

function text(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length <= max && !/[\0\r\n]/.test(value);
}
function references(value: string): string[] {
  const variables: string[] = [];
  const rest = value.replace(/\$\{([A-Z][A-Z0-9_]{0,63})\}/g, (_, name: string) => { variables.push(name); return ""; });
  if (rest.includes("${")) throw new Error("模板变量必须使用 ${UPPER_CASE_NAME} 格式");
  return variables;
}
/** A common-name safeguard, not a general secret scanner. Descriptions, paths and
 * arbitrary arguments must still be reviewed before saving a shared template. */
function credentialKey(name: string): boolean {
  const key = name.toLowerCase().replace(/[-_.]/g, "");
  return /^(key|auth|pwd)$/.test(key) || /token|secret|password|passwd|authorization|authentication|credential|apikey|subscriptionkey|authkey|accesskey|privatekey|clientkey/.test(key);
}
function checkCredentialArgs(args: string[]): void {
  for (let i = 0; i < args.length; i++) {
    const flag = /^--?([A-Za-z][A-Za-z0-9_.-]*)(?:=(.*))?$/.exec(args[i]);
    if (flag && credentialKey(flag[1]) && !PRIVATE_REFERENCE.test(flag[2] ?? args[i + 1] ?? ""))
      throw new Error("MCP 凭据参数须使用私有变量引用，如 --api-key ${API_KEY}；请勿把凭据写入共享模板");
  }
}
function checkCredentialQuery(value: string): void {
  // URLSearchParams decodes names, so encoded api_key/token names cannot evade the check.
  const parsed = new URL(value);
  for (const [key, item] of parsed.searchParams) {
    if (credentialKey(key) && !PRIVATE_REFERENCE.test(item))
      throw new Error("MCP URL 凭据参数须使用私有变量引用，如 ?api_key=${API_KEY}；请勿把凭据写入共享模板");
  }
}
export function templateVariables(template: McpTemplate): string[] {
  return [...new Set([template.command || "", template.url || "", ...(template.args || []), ...Object.values(template.env || {}),
    ...Object.values(template.headers || {})].flatMap(references))].sort();
}
function privateMap(value: unknown, header: boolean): Record<string, string> | undefined {
  if (value === undefined) return;
  if (!object(value) || Object.keys(value).length > 32) throw new Error("env/headers 必须是不超过 32 项的对象");
  for (const [key, item] of Object.entries(value)) {
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(key) || BAD_KEYS.has(key) || !text(item, 2048)) throw new Error("env/headers 格式无效");
    if (header && /^(host|origin|content-length|connection|transfer-encoding|mcp-session-id|mcp-protocol-version|mcp-method|mcp-name)$/i.test(key))
      throw new Error("不能覆盖传输层 HTTP 请求头");
    // Keep shared files free of literal credentials. Auth scheme prefixes are harmless.
    if (!PRIVATE_REFERENCE.test(item))
      throw new Error("env/headers 值须使用私有变量引用，如 ${API_TOKEN} 或 Bearer ${API_TOKEN}");
  }
  return value as Record<string, string>;
}
export function validateTemplate(value: unknown): McpTemplate {
  if (!object(value) || Object.keys(value).some(k => !["transport", "description", "command", "args", "url", "env", "headers"].includes(k)))
    throw new Error("MCP 模板含不支持的字段");
  if (!["stdio", "http", "sse"].includes(String(value.transport))) throw new Error("MCP transport 必须是 stdio/http/sse");
  if (value.description !== undefined && !text(value.description, 500)) throw new Error("MCP 描述过长或含换行");
  if (value.transport === "stdio") {
    if (!text(value.command, 1000) || !value.command.trim() || /[|&;<>`"']/.test(value.command) || value.url !== undefined || value.headers !== undefined)
      throw new Error("stdio 须提供单独的 command，不能混入 URL、shell 表达式或 headers");
    const commandBase = value.command.split(/[\\/]/).pop()!.replace(/\.(exe|cmd|bat)$/i, "");
    if (/^(cmd|powershell|pwsh|bash|sh|wscript|cscript|mshta)$/i.test(commandBase)) throw new Error("MCP 模板不支持通用 shell 或脚本宿主作为 command");
    if (value.args !== undefined && (!Array.isArray(value.args) || value.args.length > 64 || value.args.some(a => !text(a, 4000))))
      throw new Error("MCP args 必须是不超过 64 项的字符串数组");
    checkCredentialArgs((value.args || []) as string[]);
    privateMap(value.env, false);
  } else {
    if (!text(value.url, 4000) || !value.url || value.command !== undefined || value.args !== undefined || value.env !== undefined)
      throw new Error("远程 MCP 须提供 url，不能混入 command、args 或 env");
    checkUrl(value.url.replace(/\$\{[A-Z][A-Z0-9_]{0,63}\}/g, "placeholder"));
    checkCredentialQuery(value.url);
    privateMap(value.headers, true);
  }
  const result = value as unknown as McpTemplate;
  templateVariables(result);
  return result;
}
function checkUrl(value: string): void {
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error("MCP URL 无效"); }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash)
    throw new Error("MCP URL 只支持 HTTP/HTTPS，不允许 URL 用户名密码或片段");
  if (parsed.protocol === "http:" && !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname))
    throw new Error("非本机 MCP URL 必须使用 HTTPS");
}
export function parseManifest(source: string): McpManifest {
  const value = strictJson(source);
  if (!object(value) || value.version !== 1 || !object(value.servers) || Object.keys(value).some(k => !["version", "servers"].includes(k)) || Object.keys(value.servers).length > 100)
    throw new Error("模板须为 {version:1,servers:{...}}，最多 100 个服务");
  for (const [id, server] of Object.entries(value.servers)) {
    if (!SERVER_ID.test(id) || BAD_KEYS.has(id) || id.startsWith("agent-console-")) throw new Error("MCP 服务名无效，agent-console- 前缀为互联桥保留");
    validateTemplate(server);
  }
  return value as unknown as McpManifest;
}
export function renderTemplate(template: McpTemplate, profile: McpProfile, variables: Record<string, string>): Record<string, unknown> {
  validateTemplate(template);
  const expand = (source: string): string => source.replace(/\$\{([A-Z][A-Z0-9_]{0,63})\}/g, (_, name: string) => {
    if (!Object.hasOwn(variables, name)) throw new Error(`请先配置本机私有变量：${name}`);
    return variables[name];
  });
  const map = (input: Record<string, string> | undefined) => input ? Object.fromEntries(Object.entries(input).map(([key, value]) => [key, expand(value)])) : undefined;
  if (template.transport === "stdio") {
    const command = expand(template.command!);
    if (/[|&;<>`"'\r\n]/.test(command) || !command.trim()) throw new Error("展开后的 MCP command 无效");
    if (profile === "trae" && /\s/.test(command)) throw new Error("TRAE 官方要求 command 不含空格，请选择不含空格的可执行路径");
    const base = command.split(/[\\/]/).pop()!.replace(/\.(exe|cmd|bat)$/i, "");
    if (/^(cmd|powershell|pwsh|bash|sh|wscript|cscript|mshta)$/i.test(base)) throw new Error("不能通过私有变量使用通用 shell 宿主");
    return { command, ...(template.args ? { args: template.args.map(expand) } : {}), ...(template.env ? { env: map(template.env) } : {}) };
  }
  const url = expand(template.url!); checkUrl(url);
  const headers = map(template.headers);
  if (headers && Object.values(headers).some(value => /[\r\n\0]/.test(value))) throw new Error("展开后的 HTTP 请求头含无效字符");
  const type = profile === "trae" ? undefined : template.transport === "sse" || profile === "qoder-ide" ? "sse" : profile === "workbuddy" ? "streamableHttp" : "http";
  return { ...(type ? { type } : {}), url, ...(headers ? { headers } : {}) };
}
