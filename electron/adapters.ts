import path from "node:path";
import type { AgentId } from "../src/shared";
import { npmDiscoveryPaths, type NpmDiscoveryOptions } from "./claude-npm";
import { qoderExecutableCandidates } from "./qoder";

/** Extend this registry to add an adapter. Paths are candidates, never a write grant. */
export interface Adapter {
  id: AgentId;
  name: string;
  subtitle: string;
  accent: string;
  glyph: string;
  integration: "documented" | "candidate";
  mode: "cli" | "desktop";
  note: string;
  memory: string[];
  skills: string[];
  executables: string[];
  npmDiscovery?: NpmDiscoveryOptions;
}
export function createAdapters(home: string, local: string, environment: NodeJS.ProcessEnv = {}): Adapter[] {
  const h = (...s: string[]) => path.join(home, ...s);
  const l = (...s: string[]) => path.join(local, ...s);
  return [
    {
      id: "workbuddy",
      name: "WorkBuddy",
      subtitle: "桌面协作助手",
      accent: "#dbb372",
      glyph: "W",
      integration: "candidate",
      mode: "desktop",
      note: "记忆路径来自参考截图；文件兼容性需在当前版本确认。未接入厂商会话或额度 API。",
      memory: [h(".workbuddy", "MEMORY.md")],
      skills: [h(".workbuddy", "skills")],
      executables: [l("Programs", "WorkBuddy", "WorkBuddy.exe")],
    },
    {
      id: "trae",
      name: "TRAE",
      subtitle: "智能开发环境",
      accent: "#5bd9ba",
      glyph: "T",
      integration: "candidate",
      mode: "desktop",
      note: "检测 .trae-cn 与 .trae 候选目录；不代表已验证厂商加载规则。仅支持用户绑定程序启动。",
      memory: [
        h(".trae-cn", "memory", "user_profile.md"),
        h(".trae", "memory", "user_profile.md"),
      ],
      skills: [h(".trae-cn", "skills"), h(".trae", "skills")],
      executables: [
        l("Programs", "Trae CN", "Trae CN.exe"),
        l("Programs", "Trae", "Trae.exe"),
      ],
    },
    {
      id: "claude",
      name: "Claude Code CLI",
      subtitle: "原生 / npm CLI · 本地任务",
      accent: "#c99b89",
      glyph: "✳",
      integration: "documented",
      mode: "cli",
      note: "支持原生与 npm 安装版的单次任务。npm 版检查 claude.cmd 旁的安装包，直接启动包内 EXE 或 Node + cli.js；不执行 CMD 脚本。需自行安装并登录。",
      npmDiscovery: npmDiscoveryPaths(home, environment),
      memory: [h(".claude", "CLAUDE.md")],
      skills: [h(".claude", "skills")],
      executables: [
        h(".local", "bin", "claude.exe"),
        h(".claude", "local", "claude.exe"),
      ],
    },
    {
      id: "qoder",
      name: "Qoder",
      subtitle: "IDE · 记忆与技能",
      accent: "#94d982",
      glyph: "Qd",
      integration: "documented",
      mode: "desktop",
      note: "技能采用官方 .qoder/skills 目录，可同步或连接统一仓库。AGENTS.md 候选仅是 Qoder CLI 用户静态指令，不是 IDE 自动记忆；IDE 项目 AGENTS.md 请手选，规则或多文件记忆目录请在统一仓库中授权。地区版和自定义路径请手选。授权后可启动 IDE EXE；未接入 CLI 任务、会话或额度。",
      memory: [h(".qoder", "AGENTS.md")],
      skills: [h(".qoder", "skills")],
      executables: qoderExecutableCandidates(local, environment),
    },
    {
      id: "qwen",
      name: "千问 Work",
      subtitle: "桌面工作助手",
      accent: "#b39bea",
      glyph: "Q",
      integration: "candidate",
      mode: "desktop",
      note: "项目记忆路径随安装与项目变化，必须手动选择。未实现会话、额度或任务派发协议。",
      memory: [],
      skills: [],
      executables: [l("Programs", "Qianwen", "Qianwen.exe")],
    },
    {
      id: "zcode",
      name: "智谱 Zcode",
      subtitle: "智谱编码助手",
      accent: "#c294d2",
      glyph: "Z",
      integration: "candidate",
      mode: "desktop",
      note: "未验证默认记忆与技能布局；请手动绑定实际路径。仅提供通用文件管理与程序启动。",
      memory: [],
      skills: [],
      executables: [],
    },
    {
      id: "deepseek",
      name: "DeepSeek Harness",
      subtitle: "Harness · 本地工作流",
      accent: "#7fa9ee",
      glyph: "D",
      integration: "candidate",
      mode: "desktop",
      note: "DeepSeek 已提供官方 Harness；本控制台的 .dsh 仍仅是待核验候选路径。未实现 Harness CLI 协议；仅可绑定独立桌面 EXE。",
      memory: [h(".dsh", "AGENTS.md")],
      skills: [h(".dsh", "skills")],
      executables: [],
    },
  ];
}
