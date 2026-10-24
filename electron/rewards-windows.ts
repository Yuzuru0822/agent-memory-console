import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { localPath, nativeExecutable, noLinks, within } from "./safety";
import type { RewardElement, RewardSelector } from "../src/rewards-types";

const ACTION_TYPES = new Set(["Button", "MenuItem", "Hyperlink", "TabItem"]);
const MAX_OUTPUT = 1024 * 1024, TIMEOUT = 15_000;
type Inspection = { title: string; elements: RewardElement[] };
type Request = { action: "inspect" | "invoke"; executable: string; windowTitle?: string; selector?: RewardSelector; expectedContext?: string[] };

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Windows 奖励桥返回了无效结构");
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error("Windows 奖励桥数据包含未知字段");
}
function text(value: unknown, limit: number): string {
  if (typeof value !== "string" || value.length > limit || value.includes("\0")) throw new Error("Windows 奖励桥文本字段无效");
  return value;
}
function selector(value: unknown): RewardSelector {
  const input = object(value); keys(input, ["name", "automationId", "controlType"]);
  const result = { name: text(input.name, 300), automationId: text(input.automationId, 300), controlType: text(input.controlType, 50) };
  if ((!result.name && !result.automationId) || !ACTION_TYPES.has(result.controlType)) throw new Error("仅支持明确命名的 Button、MenuItem、Hyperlink 或 TabItem");
  return result;
}
function inspection(response: Record<string, unknown>): Inspection {
  keys(response, ["ok", "title", "elements"]);
  const title = text(response.title, 500);
  if (!Array.isArray(response.elements) || response.elements.length > 500) throw new Error("Windows 奖励桥控件列表无效");
  const indices = new Set<number>();
  const elements = response.elements.map(value => {
    const item = object(value); keys(item, ["index", "name", "automationId", "controlType", "enabled", "actionable"]);
    if (!Number.isInteger(item.index) || (item.index as number) < 0 || (item.index as number) >= 500 || indices.has(item.index as number) || typeof item.enabled !== "boolean" || typeof item.actionable !== "boolean")
      throw new Error("Windows 奖励桥控件字段无效");
    indices.add(item.index as number);
    const element: RewardElement = { index: item.index as number, name: text(item.name, 300), automationId: text(item.automationId, 300), controlType: text(item.controlType, 50), enabled: item.enabled, actionable: item.actionable };
    if (element.controlType === "Edit" || !element.controlType || (element.actionable && (!element.enabled || !ACTION_TYPES.has(element.controlType) || (!element.name && !element.automationId)))) throw new Error("Windows 奖励桥返回了不允许的控件");
    return element;
  });
  return { title, elements };
}

export class WindowsRewardsBridge {
  private readonly helperPath: string;
  constructor(helperPath?: string) {
    const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
    const packaged = resources && within(resources, __dirname) && path.join(resources, "rewards", "RewardBridge.exe");
    const root = path.basename(path.dirname(__dirname)) === "dist-electron" ? path.resolve(__dirname, "../..") : path.resolve(__dirname, "..");
    this.helperPath = helperPath || packaged || path.join(root, "native", "bin", "RewardBridge.exe");
  }
  available(): boolean {
    if (process.platform !== "win32") return false;
    try { noLinks(this.helperPath); return fs.statSync(this.helperPath).isFile(); } catch { return false; }
  }
  async inspect(executable: string, windowTitle?: string): Promise<Inspection> {
    const request: Request = { action: "inspect", executable: this.executable(executable) };
    if (windowTitle !== undefined) request.windowTitle = text(windowTitle, 500);
    const result = inspection(await this.request(request));
    if (windowTitle !== undefined && result.title !== windowTitle) throw new Error("Windows 奖励桥返回了不同的窗口标题");
    return result;
  }
  async invoke(executable: string, windowTitle: string, target: RewardSelector, expectedContext?: string[]): Promise<void> {
    const title = text(windowTitle, 500); if (!title) throw new Error("调用控件必须指定唯一窗口标题");
    const request: Request = { action: "invoke", executable: this.executable(executable), windowTitle: title, selector: selector(target) };
    if (expectedContext !== undefined) {
      if (!Array.isArray(expectedContext) || expectedContext.length > 5) throw new Error("奖励上下文必须是不超过 5 项的文本列表");
      request.expectedContext = expectedContext.map(value => { const result = text(value, 300); if (!result.trim()) throw new Error("奖励上下文不能为空"); return result; });
    }
    const response = await this.request(request);
    keys(response, ["ok"]);
  }
  private executable(value: string): string { const result = localPath(value); nativeExecutable(result); return result; }
  private request(request: Request): Promise<Record<string, unknown>> {
    if (!this.available()) return Promise.reject(new Error("Windows 奖励桥不可用，请使用包含原生组件的 Windows 版本"));
    nativeExecutable(this.helperPath);
    return new Promise((resolve, reject) => {
      const child = spawn(this.helperPath, [], { shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
      let settled = false, bytes = 0; const stdout: Buffer[] = [];
      const finish = (error?: Error, response?: Record<string, unknown>) => {
        if (settled) return; settled = true; clearTimeout(timer);
        if (error) reject(error); else resolve(response!);
      };
      const stop = (message: string) => { child.kill(); finish(new Error(message)); };
      const timer = setTimeout(() => stop("Windows 控件读取或调用超时；结果未确认，请重新检查"), TIMEOUT);
      const receive = (chunk: Buffer, keep: boolean) => {
        if (settled) return;
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buffer.length;
        if (bytes > MAX_OUTPUT) { stop("Windows 奖励桥输出超过 1 MiB，已停止本次操作"); return; }
        if (keep) stdout.push(buffer);
      };
      child.stdout.on("data", chunk => receive(chunk, true)); child.stderr.on("data", chunk => receive(chunk, false));
      child.once("error", () => finish(new Error("无法启动 Windows 奖励桥")));
      child.stdin.once("error", () => { if (!settled) stop("Windows 奖励桥请求发送失败；结果未确认"); });
      child.once("close", (code, signal) => {
        if (settled) return;
        try {
          const response = object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(stdout))));
          if (typeof response.ok !== "boolean") throw new Error("Windows 奖励桥缺少有效结果状态");
          if (!response.ok) { keys(response, ["ok", "error"]); throw new Error(text(response.error, 1000) || "Windows 奖励桥操作失败"); }
          if (code !== 0 || signal) throw new Error("Windows 奖励桥异常退出；结果未确认");
          finish(undefined, response);
        } catch (error) { finish(error instanceof Error ? error : new Error("Windows 奖励桥返回无效响应")); }
      });
      child.stdin.end(JSON.stringify(request), "utf8");
    });
  }
}
