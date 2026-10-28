import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { noLinks, readText, within, atomicWrite, nativeExecutable } from '../safety';
import { remoteUrl } from '../agent-bridge-network';
import { guardedFetch } from './network';
import type { RuntimeTool } from './runtime';
export type Approve = (name: string, args: unknown) => Promise<void>;
export function workspaceTools(root: string, approve: Approve): RuntimeTool[] {
  function target(value: unknown) {
    if (typeof value !== 'string' || !value || value.includes('\0') || path.isAbsolute(value)) throw new Error('文件名必须是工作区内相对路径');
    const result = path.resolve(root, value); noLinks(result);
    if (!within(root, result) || result === root || value.split(/[\\/]/).some(p => p === '.git') || fs.existsSync(result) && fs.statSync(result).nlink !== 1) throw new Error('路径超出允许范围或存在硬链接');
    return result;
  }
  return [
    { name: 'workspace_read', description: 'Read one UTF-8 file in the selected workspace, with user approval.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
      async call(args) { target(args.path); await approve('读取工作区文件', args); const text = readText(target(args.path)).toString('utf8'); if (Buffer.byteLength(text) > 64000) throw new Error('单次读取超过 64 KiB'); return text; } },
    { name: 'workspace_write', description: 'Write a UTF-8 file in the workspace after the user reviews its entire new content. Existing content is backed up.', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'], additionalProperties: false },
      async call(args) {
        const file = target(args.path); if (typeof args.content !== 'string' || Buffer.byteLength(args.content) > 64000) throw new Error('写入内容超过 64 KiB');
        const before = fs.existsSync(file) ? readText(file) : undefined;
        await approve('写入工作区文件', args); target(args.path);
        const now = fs.existsSync(file) ? readText(file) : undefined;
        if (before?.toString('base64') !== now?.toString('base64')) throw new Error('文件在审批期间已变化');
        // The service records encrypted preimages through the approval event; disk backup is explicit.
        if (before) { const backup = file + '.agent-backup-' + Date.now(); noLinks(backup); fs.writeFileSync(backup, before, { flag: 'wx', mode: 0o600 }); }
        atomicWrite(file, args.content); return '文件已保存；旧文件备份位于相邻的 .agent-backup-* 文件';
      } },
  ];
}
export async function connectMcp(id: string, config: Record<string, any>, approve: Approve, signal: AbortSignal): Promise<{ tools: RuntimeTool[]; close(): Promise<void> }> {
  await approve('连接 MCP 服务', { serverId: id, transport: config.command ? 'stdio' : 'http', command: config.command, args: config.args, url: config.url, environmentNames: Object.keys(config.env || {}), headerNames: Object.keys(config.headers || {}) }); signal.throwIfAborted();
  const client = new Client({ name: 'agent-console', version: '1.0.0-rc.1' }, { capabilities: {} });
  let transport;
  if (config.command) {
    nativeExecutable(config.command);
    const env: Record<string, string> = {};
    for (const key of ['SystemRoot', 'WINDIR', 'PATH', 'TEMP', 'TMP']) if (process.env[key]) env[key] = process.env[key]!;
    Object.assign(env, config.env || {});
    for (const key of Object.keys(env)) if (/^(NODE_OPTIONS|NODE_PATH|ELECTRON_RUN_AS_NODE)$/i.test(key)) delete env[key];
    transport = new StdioClientTransport({ command: config.command, args: config.args || [], env, stderr: 'ignore' });
  } else {
    if (config.type === 'sse') throw new Error('原生工作台仅支持 Streamable HTTP 与原生 EXE stdio；SSE 模板仍可部署到其他客户端');
    const url = remoteUrl(config.url, true);
    transport = new StreamableHTTPClientTransport(url, { fetch: guardedFetch as typeof fetch, requestInit: { headers: config.headers || {}, signal } });
  }
  const close = async () => { await client.close().catch(() => {}); };
  const abort = () => { void close(); }; signal.addEventListener('abort', abort, { once: true });
  try {
    await client.connect(transport, { timeout: 15000 }); signal.throwIfAborted();
    const result = await client.listTools({}, { signal, timeout: 15000 });
    if (result.nextCursor || result.tools.length > 64) throw new Error('MCP 工具列表过大，请在服务端限制工具范围');
    const tools: RuntimeTool[] = result.tools.map((tool, i) => ({
      name: `mcp_${id.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 32)}_${i}`, description: (tool.description || tool.name).slice(0, 2000), parameters: tool.inputSchema,
      async call(args) {
        await approve(`MCP ${id} / ${tool.name}`, args); signal.throwIfAborted();
        const output = await client.callTool({ name: tool.name, arguments: args }, undefined, { signal, timeout: 60000 });
        const serialized = JSON.stringify(output); if (serialized.length > 64000) throw new Error('MCP 工具输出超过 64 KiB'); return serialized;
      },
    }));
    return { tools, close: async () => { signal.removeEventListener('abort', abort); await close(); } };
  } catch (error) { signal.removeEventListener('abort', abort); await close(); throw error; }
}
