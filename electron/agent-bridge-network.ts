import dns from "node:dns/promises";
import net from "node:net";
import http from "node:http";
import https from "node:https";

export function remoteUrl(value: unknown, allowLoopback: boolean): URL {
  if (typeof value !== "string" || value.length > 2000) throw new Error("远端地址无效");
  const url = new URL(value);
  if (url.username || url.password || url.hash || url.search) throw new Error("远端地址不能包含凭证、查询参数或片段");
  if (url.hostname === "127.0.0.1" && allowLoopback && ["http:", "https:"].includes(url.protocol)) return url;
  if (url.protocol !== "https:" || url.hostname === "localhost" || url.hostname.endsWith(".localhost") || url.hostname.endsWith(".local")) throw new Error("远端须使用 HTTPS；本机测试仅允许明确授权的 127.0.0.1");
  if (net.isIP(url.hostname.replace(/^\[|\]$/g, "")) && !publicAddress(url.hostname.replace(/^\[|\]$/g, ""))) throw new Error("远端地址不允许内网、保留或元数据地址");
  return url;
}

export function publicAddress(address: string): boolean {
  let ip = address.toLowerCase();
  if (net.isIP(ip) === 4) {
    const [a, b, c] = ip.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
  }
  if (net.isIP(ip) !== 6 || ip.includes("%")) return false;
  ip = new URL(`http://[${ip}]/`).hostname.slice(1, -1);
  const [head, tail] = ip.split("::"), left = head ? head.split(":") : [], right = tail ? tail.split(":") : [];
  const words = [...left, ...Array(8 - left.length - right.length).fill("0"), ...right].map(part => Number.parseInt(part, 16));
  // Allow ordinary 2000::/3 unicast only. Exclude IANA special-purpose prefixes,
  // including transition/benchmark/ORCHID ranges within 2001::/23, regardless of compression.
  // https://www.iana.org/assignments/iana-ipv6-special-registry/
  return words[0] >= 0x2000 && words[0] <= 0x3fff &&
    !(words[0] === 0x2001 && ((words[1] & 0xfe00) === 0 || words[1] === 0x0db8)) &&
    words[0] !== 0x2002 && !(words[0] === 0x2620 && words[1] === 0x004f && words[2] === 0x8000) &&
    !(words[0] === 0x3fff && (words[1] & 0xf000) === 0);
}

/** Pin a validated DNS address to this socket, so a second lookup cannot rebind it. */
export async function bridgeRpc(endpoint: string, allowLoopback: boolean, token: string | undefined, payload: unknown, timeoutMs = 10000): Promise<unknown> {
  const url = remoteUrl(endpoint, allowLoopback);
  const loopback = allowLoopback && url.hostname === "127.0.0.1";
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = net.isIP(hostname) ? [{ address: hostname, family: net.isIP(hostname) }] : await deadline(dns.lookup(hostname, { all: true }), timeoutMs);
  if (!addresses.length || addresses.some(item => !loopback && !publicAddress(item.address))) throw new Error("远端 DNS 指向不允许的地址");
  const chosen = addresses[0], body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const request = (url.protocol === "https:" ? https : http).request(url, {
      method: "POST", agent: false, family: chosen.family,
      lookup: (_hostname, _options, callback) => callback(null, chosen.address, chosen.family),
      headers: { "Content-Type": "application/json", Accept: "application/json", "A2A-Version": "1.0", "Content-Length": Buffer.byteLength(body), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    }, response => {
      const chunks: Buffer[] = []; let size = 0;
      if (response.statusCode !== 200 || !/^application\/(?:json|a2a\+json)(?:;|$)/i.test(response.headers["content-type"] || "")) {
        response.destroy(); request.destroy(); reject(new Error("远端未返回受支持的 JSON 响应（不跟随重定向）")); return;
      }
      response.on("data", (chunk: Buffer) => { size += chunk.length; if (size > 256 * 1024) response.destroy(new Error("远端响应过大")); else chunks.push(chunk); });
      response.on("error", reject);
      response.on("end", () => { try { resolve(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)))); } catch { reject(new Error("远端响应无效")); } });
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error("远端请求超时")));
    const deadline = setTimeout(() => request.destroy(new Error("远端请求超时")), timeoutMs);
    request.on("close", () => clearTimeout(deadline));
    request.on("error", reject); request.end(body);
  });
}

export async function deadline<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("远端 DNS 查询超时")), milliseconds); })]); }
  finally { if (timer) clearTimeout(timer); }
}
