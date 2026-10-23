import fs from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { AgentId, AgentView } from "../src/shared";
import { nativeExecutable, noLinks } from "./safety";
import type { ConsoleService } from "./service";
import { validateClaudeNpm } from "./claude-npm";

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
    if ((!config.executable && !config.claudeNpm) || !config.workspace)
      throw new Error("请先选择并授权程序与工作目录");
    noLinks(config.workspace);
    if (!fs.statSync(config.workspace).isDirectory())
      throw new Error("程序或工作目录已失效");
    let executable: string;
    let args: string[];
    if (config.claudeNpm) {
      if (id !== "claude") throw new Error("仅 Claude 支持 npm 安装");
      const npm = validateClaudeNpm(config.claudeNpm, adapter.npmDiscovery || { prefixes: [], nodeCandidates: [] });
      executable = npm.kind === "node" ? npm.node! : npm.entry;
      args = npm.kind === "node" ? [npm.entry, "-p"] : ["-p"];
    } else {
      executable = config.executable!;
      nativeExecutable(executable);
      args = adapter.mode === "cli" ? ["-p"] : [];
    }
    if (
      adapter.mode === "cli" &&
      (typeof prompt !== "string" || !prompt.trim() || prompt.length > 16000)
    )
      throw new Error("请输入 1–16000 字符的 Claude 任务");
    if (!this.service.verifyAudit().valid)
      throw new Error("台账校验失败，已阻止进程启动");
    return { adapter, config, executable, args };
  }
  launch(id: AgentId, prompt?: string): void {
    const { adapter, config, executable, args } = this.validate(id, prompt);
    // No shell, shell command, arbitrary flag, bypass permission mode, or global kill.
    const env = { ...process.env };
    // Preserve provider/login environment while preventing injected Node startup hooks.
    if (config.claudeNpm) for (const name of Object.keys(env)) {
      if (["NODE_OPTIONS", "NODE_PATH", "ELECTRON_RUN_AS_NODE"].includes(name.toUpperCase())) delete env[name];
    }
    this.service.audit(
      "process.request",
      `${id} · ${executable}${config.claudeNpm?.kind === "node" ? " · " + config.claudeNpm.entry : ""} · cwd=${config.workspace}`,
    );
    const child = spawn(executable, args, {
      cwd: config.workspace,
      windowsHide: true,
      shell: false,
      env,
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
