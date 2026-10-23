# 集成范围

“文档适配”表示实现参考了公开官方文档；“候选 / 未验证”表示仅提供候选位置或用户绑定的文件与程序管理。两者都不等同于厂商官方合作、认证，或已通过真实账户端到端验证。

下表中的 `~` 指当前 Windows 用户目录，`%LOCALAPPDATA%` 在当前实现中使用用户目录下的 `AppData\Local`。自动发现不读取注册表、不扫描全盘，也不执行可疑程序探测版本。

| Agent | 记忆候选 | 技能候选 | 进程能力与依据 |
| --- | --- | --- | --- |
| Claude Code CLI | `~\.claude\CLAUDE.md` | `~\.claude\skills` | 官方文档适配；用户绑定原生 `claude.exe` 后执行固定 `-p` 单次任务 |
| WorkBuddy | `~\.workbuddy\MEMORY.md` | `~\.workbuddy\skills` | 参考界面的候选布局；通用 EXE 启动，文件兼容性待验证 |
| TRAE | `~\.trae-cn\memory\user_profile.md`、`~\.trae\memory\user_profile.md` | `~\.trae-cn\skills`、`~\.trae\skills` | 候选布局；通用 EXE 启动，加载规则待验证 |
| DeepSeek Harness | `~\.dsh\AGENTS.md` | `~\.dsh\skills` | 参考界面的 `.dsh` 候选；未实现 DSH CLI 协议，支持手动绑定独立桌面 EXE |
| 智谱 Zcode | 无；手动选择 | 无；手动选择 | 通用文件管理与用户绑定 EXE 启动 |
| 千问 Work | 无；手动选择 | 无；手动选择 | 通用文件管理与用户绑定 EXE 启动；未实现任务派发协议 |

`.dsh` 名称不能证明它属于任何官方 DeepSeek 产品。候选路径不存在、发生变化或不适合当前版本时，应手动选择真实文件，不要为了获得“路径完整”状态创建并不存在于厂商规范中的目录。

## Claude Code CLI

当前管理的 `CLAUDE.md` 是用户维护的持久化指令。Claude 的自动记忆是另一套机制；控制台不扫描或合并项目自动记忆目录，不处理完整的项目层级、规则导入或会话历史。用户级路径的依据见 [Claude 记忆文档](https://code.claude.com/docs/en/memory)。

技能候选采用用户级 `.claude/skills`，按 `SKILL.md` 统计。控制台仅复制安全范围内的文本，不验证 frontmatter、依赖、工具权限或技能执行结果。技能可以含脚本和其他资源，这些资源不会被此工程完整迁移。目录规范见 [Claude 技能文档](https://code.claude.com/docs/en/skills)。

EXE 发现候选为 `~\.local\bin\claude.exe` 和 `~\.claude\local\claude.exe`；它们是查找提示，需用户选择和授权。启动形式为固定参数 `-p`，任务正文通过标准输入传入，等待进程退出并展示输出。CLI 的单次任务及管道输入依据见 [Claude CLI 参考](https://code.claude.com/docs/en/cli-reference)。

用户需事先完成原生 CLI 安装和登录。控制台不创建登录令牌、不读取账户余额、不添加跳过权限的选项，也不提供交互式终端。需要交互审批的任务可能无法在此模式完成，应在 CLI 自身环境中处理。支持范围并不涵盖官方 CLI 文档中的其他命令。

## 桌面程序候选

| Agent | EXE 候选 |
| --- | --- |
| WorkBuddy | `%LOCALAPPDATA%\Programs\WorkBuddy\WorkBuddy.exe` |
| TRAE | `%LOCALAPPDATA%\Programs\Trae CN\Trae CN.exe`、`%LOCALAPPDATA%\Programs\Trae\Trae.exe` |
| 千问 Work | `%LOCALAPPDATA%\Programs\Qianwen\Qianwen.exe` |
| 智谱 Zcode、DeepSeek Harness | 无；需要手动选择 |

这些候选不是经验证的安装规范。实际启动一律要求显式绑定 EXE 与工作目录，并由用户确认。控制台不验证 EXE 的厂商签名；其他五个适配器不传递任务参数。桌面启动器若把工作转交给既有实例后退出，控制台只会显示这个启动器的退出结果。

## 已实现与未实现

已实现：只读候选发现、真实文件状态和 SHA-256、文本技能检查、明确路径授权、共享源单向同步预览、写前备份、恢复预览、活动台账、受限 EXE 启停，以及 Claude 单次任务输出。

未实现：厂商登录与额度 API、历史会话检索、跨厂商会话迁移、其他五家任务派发、已运行进程接管、自动同步、双向合并、自动删除、链接写入、脚本技能执行、完整技能包迁移、任意 shell 命令和 npm `.cmd` 启动器。

官方依据核对日期：2026-10-23。厂商能力和路径可能变化，发布前仍需使用实际安装版本逐项验证；候选布局没有升级为官方文档依据。
