import dns from 'node:dns/promises';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';
import { publicAddress, remoteUrl, deadline } from '../agent-bridge-network';

/** Shared HTTP implementation: pin DNS, prohibit redirects, honor abort and total deadline. */
export async function guardedFetch(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
  const raw = input instanceof Request ? input.url : String(input);
  const url = remoteUrl(raw, new URL(raw).hostname === '127.0.0.1');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const signal = AbortSignal.any([...(init.signal ? [init.signal] : []), AbortSignal.timeout(120000)]);
  signal.throwIfAborted();
  const addresses = net.isIP(hostname) ? [{ address: hostname, family: net.isIP(hostname) }] : await deadline(dns.lookup(hostname, { all: true }), 10000);
  signal.throwIfAborted();
  if (!addresses.length || addresses.some(a => hostname !== '127.0.0.1' && !publicAddress(a.address))) throw new Error('端点 DNS 指向未授权地址');
  const chosen = addresses[0];
  return new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? https : http).request(url, {
      method: init.method || 'GET', agent: false, signal, family: chosen.family,
      lookup: (_host, _options, callback) => callback(null, chosen.address, chosen.family),
      headers: Object.fromEntries(new Headers(init.headers).entries()),
    }, response => {
      if ((response.statusCode || 0) >= 300 && (response.statusCode || 0) < 400) { response.destroy(); reject(new Error('端点重定向已拒绝')); return; }
      const headers = new Headers();
      for (const [key, value] of Object.entries(response.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
      const status = response.statusCode || 500;
      if ([204, 205, 304].includes(status)) { response.resume(); resolve(new Response(null, { status, headers })); }
      else resolve(new Response(Readable.toWeb(response) as ReadableStream<Uint8Array>, { status, headers }));
    });
    request.on('error', reject);
    if (init.body !== undefined && init.body !== null && typeof init.body !== 'string') { request.destroy(); reject(new Error('仅接受文本请求体')); return; }
    request.end(init.body || undefined);
  });
}
export async function* sse(response: Response): AsyncGenerator<any> {
  if (!response.ok) throw new Error(`模型服务返回 HTTP ${response.status}`);
  if (!response.body) throw new Error('服务未返回响应体');
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let pending = '', total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      total += value.length; if (total > 8 * 1024 * 1024) throw new Error('模型输出超过 8 MiB');
      pending += decoder.decode(value, { stream: true }); pending = pending.replace(/\r\n/g, '\n');
      let end: number;
      while ((end = pending.indexOf('\n\n')) >= 0) {
        const frame = pending.slice(0, end); pending = pending.slice(end + 2);
        const data = frame.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
        if (data === '[DONE]') return;
        if (data) yield JSON.parse(data);
      }
      if (pending.length > 1024 * 1024) throw new Error('流事件过大');
    }
    if (pending.trim()) throw new Error('响应流意外中断');
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
