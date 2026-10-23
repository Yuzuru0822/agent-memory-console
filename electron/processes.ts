import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { AgentId, AgentView } from "../src/shared";
import { nativeExecutable, noLinks } from "./safety";
import type { ConsoleService } from "./service";

export class Processes {
  private children = new Map<AgentId, ChildProcess>();
  private states: Partial<Record<AgentId, AgentView["process"]>> = {};
  constructor(private service: ConsoleService) {}
  snapshot() {
    return this.states;
  }
  active() {
    return [...this.children.keys()];
  }
  validate(id: AgentId, prompt?: string) {
    const adapter = this.service.adapter(id),
      config = this.service.settings(id);
    if (this.children.has(id))
      throw new Error("此 Agent 已有一个由控制台启动的进程");
    if (!config.executable || !config.workspace)
      throw new Error("请先选择并授权 EXE 与工作目录");
    noLinks(config.executable);
    noLinks(config.workspace);
    if (
      path.extname(config.executable).toLowerCase() !== ".exe" ||
      !fs.statSync(config.executable).isFile() ||
      !fs.statSync(config.workspace).isDirectory()
    )
      throw new Error("程序或工作目录已失效");
    nativeExecutable(config.executable);
    if (
      adapter.mode === "cli" &&
      (typeof prompt !== "string" || !prompt.trim() || prompt.length > 16000)
    )
      throw new Error("请输入 1–16000 字符的 Claude 任务");
    if (!this.service.verifyAudit().valid)
      throw new Error("台账校验失败，已阻止进程启动");
    return { adapter, config };
  }
  launch(id: AgentId, prompt?: string): void {
    const { adapter, config } = this.validate(id, prompt);
    // No shell, shell command, arbitrary flag, bypass permission mode, or global kill.
    const args = adapter.mode === "cli" ? ["-p"] : [];
    this.service.audit(
      "process.request",
      `${id} · ${config.executable} · cwd=${config.workspace}`,
    );
    const child = spawn(config.executable!, args, {
      cwd: config.workspace,
      windowsHide: true,
      shell: false,
      stdio: adapter.mode === "cli" ? "pipe" : "ignore",
    });
    const state: AgentView["process"] = {
      running: true,
      pid: child.pid,
      output: "",
    };
    this.states[id] = state;
    this.children.set(id, child);
    const record = (action: string, detail: string) => {
      try {
        this.service.audit(action, detail);
      } catch (e) {
        state.error = (e as Error).message;
      }
    };
    const append = (text: string) => {
      state.output = (
        state.output + text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")
      ).slice(-32000);
    };
    for (const stream of [child.stdout, child.stderr]) {
      const decoder = new StringDecoder("utf8");
      stream?.on("data", (data: Buffer) => append(decoder.write(data)));
      stream?.on("end", () => append(decoder.end()));
    }
    child.on("spawn", () =>
      record("process.start", `${id} · PID ${child.pid}`),
    );
    child.on("error", (error) => {
      state.error = error.message;
      state.running = false;
      this.children.delete(id);
      record("process.error", `${id} · ${error.message}`);
    });
    child.on("close", (code) => {
      state.running = false;
      state.exitCode = code;
      this.children.delete(id);
      record("process.exit", `${id} · code=${code}`);
    });
    child.stdin?.on("error", (error) => {
      state.error = error.message;
    });
    if (adapter.mode === "cli") child.stdin?.end(prompt + "\n");
  }
  stop(id: AgentId): void {
    const child = this.children.get(id);
    if (!child) throw new Error("没有可停止的控制台所属进程");
    this.service.audit(
      "process.stop",
      `${id} · PID ${child.pid} · 仅直接子进程`,
    );
    if (!child.kill()) throw new Error("停止请求未成功，进程可能已经退出");
  }
}
