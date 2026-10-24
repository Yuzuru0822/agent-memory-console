# 集成范围

“文档适配”表示实现参考了公开官方文档；“候选 / 未验证”表示仅提供候选位置或用户绑定的文件与程序管理。两者都不等同于厂商官方合作、认证，或已通过真实账户端到端验证。

下表中的 `~` 指当前 Windows 用户目录，`%LOCALAPPDATA%` 在当前实现中使用用户目录下的 `AppData\Local`。自动发现不读取注册表、不扫描全盘，也不执行可疑程序探测版本。

| Agent | 记忆候选 | 技能候选 | 进程能力与依据 |
| --- | --- | --- | --- |
| Claude Code CLI | `~\.claude\CLAUDE.md` | `~\.claude\skills` | 官方文档适配；原生或 npm 安装版，授权后执行固定 `-p` 单次任务 |
| WorkBuddy | `~\.workbuddy\MEMORY.md` | `~\.workbuddy\skills` | 参考界面的候选布局；通用 EXE 启动，文件兼容性待验证 |
| TRAE | `~\.trae-cn\memory\user_profile.md`、`~\.trae\memory\user_profile.md` | `~\.trae-cn\skills`、`~\.trae\skills` | 候选布局；通用 EXE 启动，加载规则待验证 |
| DeepSeek Harness | `~\.dsh\AGENTS.md` | `~\.dsh\skills` | 参考界面的 `.dsh` 候选；未实现 DSH CLI 协议，支持手动绑定独立桌面 EXE |
| 智谱 Zcode | 无；手动选择 | 无；手动选择 | 通用文件管理与用户绑定 EXE 启动 |
| 千问 Work | 无；手动选择 | 无；手动选择 | 通用文件管理与用户绑定 EXE 启动；未实现任务派发协议 |

`.dsh` 名称不能证明它属于任何官方 DeepSeek 产品。候选路径不存在、发生变化或不适合当前版本时，应手动选择真实文件，不要为了获得“路径完整”状态创建并不存在于厂商规范中的目录。

## Claude Code CLI

默认候选 `CLAUDE.md` 是用户维护的持久化指令。Claude 的自动记忆是另一套机制；控制台不自动扫描项目自动记忆目录。v0.2.0 可由用户明确选择某个记忆目录，将其允许的文档按相对路径纳入 `memories/claude/` 并做双向文件合并；这不等于理解项目层级、规则导入或会话历史语义。用户级路径的依据见 [Claude 记忆文档](https://code.claude.com/docs/en/memory)。

技能候选采用用户级 `.claude/skills`，按实际路径去重后的 `SKILL.md` 统计。v0.1.2 支持技能目录本身或其内部的本地符号链接、junction：可只读检查，明确授权实际指向后可同步允许的文本和备份。目录链接可以用于多个 Agent 共用同一份技能；写入共同目标会影响所有引用方。断链、循环和超过检查范围会提示统计不完整；网络与设备路径不支持。

旧版共享源兼容模式只复制允许文本。v0.2.0 统一仓库支持完整技能包（包含脚本和二进制资产）的字节导入、版本管理以及显式 junction 连接；导入期间不执行脚本。控制台不验证 frontmatter、依赖、工具权限或厂商端执行结果。正常源链接被解析为实际文件导入，失效或循环入口保留在原目录备份并单独提示。目录规范见 [Claude 技能文档](https://code.claude.com/docs/en/skills)。

EXE 发现候选为 `~\.local\bin\claude.exe` 和 `~\.claude\local\claude.exe`；它们是查找提示，需用户选择和授权。启动形式为固定参数 `-p`，任务正文通过标准输入传入，等待进程退出并展示输出。CLI 的单次任务及管道输入依据见 [Claude CLI 参考](https://code.claude.com/docs/en/cli-reference)。

用户需事先完成原生或 npm CLI 安装和登录。控制台不创建登录令牌、不读取账户余额、不添加跳过权限的选项，也不提供交互式终端。需要交互审批的任务可能无法在此模式完成，应在 CLI 自身环境中处理。支持范围并不涵盖官方 CLI 文档中的其他命令。

### npm 安装

支持 `npm install -g @anthropic-ai/claude-code`，安装方式见 [Claude 安装文档](https://code.claude.com/docs/en/setup)。控制台只读检查 npm prefix 环境变量、默认 `%APPDATA%\npm`、nvm 路径以及最多 128 个 PATH 目录中的 `claude.cmd`；也可手动选择该文件。发现不会自动授权或执行程序。

`claude.cmd` 仅是定位文件，正文不读取、不执行。解析相邻 `node_modules/@anthropic-ai/claude-code/package.json`，核对包名、版本与已知 `bin.claude` 布局：`bin/claude.exe` 直接执行包内原生程序；`cli.js` 用检查过的本地 `node.exe` 执行。包名和 PE 格式检查不代表签名认证；未知布局拒绝启动并显示错误。当前机器的 npm 2.1.243 布局及 `--version` 已验证；旧版布局用隔离夹具测试，未运行真实计费任务。

支持自定义 prefix 的空格路径及 nvm 外层 junction：授权时解析出实际入口与 Node 路径并在确认框显示，包内链接仍拒绝。每次启动重新检查；入口、运行时或 prefix 重定向变化需要重新授权，同路径版本更新在重新校验后可使用。命令参数使用数组传入，固定为 `-p`，不经过 CMD 或 PowerShell。

## 桌面程序候选

| Agent | EXE 候选 |
| --- | --- |
| WorkBuddy | `%LOCALAPPDATA%\Programs\WorkBuddy\WorkBuddy.exe` |
| TRAE | `%LOCALAPPDATA%\Programs\Trae CN\Trae CN.exe`、`%LOCALAPPDATA%\Programs\Trae\Trae.exe` |
| 千问 Work | `%LOCALAPPDATA%\Programs\Qianwen\Qianwen.exe` |
| 智谱 Zcode、DeepSeek Harness | 无；需要手动选择 |

这些候选不是经验证的安装规范。实际启动一律要求显式绑定 EXE 与工作目录，并由用户确认。控制台不验证 EXE 的厂商签名；其他五个适配器不传递任务参数。桌面启动器若把工作转交给既有实例后退出，控制台只会显示这个启动器的退出结果。

## 已实现与未实现

已实现：只读候选发现、真实文件状态和 SHA-256、技能目录检查、本地技能链接解析及实际目标授权、共享源兼容同步、写前备份、恢复预览、活动台账、受限 EXE 启停，以及 Claude 单次任务输出。v0.2.0 增加独立 Git 仓库、多文件记忆分区、双向三方合并及人工冲突处理、应用运行期间定时同步、受控备份清理、完整技能包导入和可解除的 junction 连接。实现不等于已通过各厂商客户端验证；本版执行证据见 [测试记录](TESTING.md)。

v0.2.1 的统一仓库迁移可保留技能根或子目录内普通 `.git` 目录中的原历史与远程配置，适用于所有已授权的 Agent 技能目录。中央 Git 只记录工作文件；独立副本的双向同步排除 `.git`，不合并或传播内层历史。junction 连接后直接访问同一份内层 Git。控制台不调用内层 hooks 或远程操作；外置 `.git` 文件、worktree、`alternates` 依赖需先转为独立 clone 再迁移。保留这些数据不等于验证厂商会如何使用它们。

不提供：厂商登录与额度 API、历史会话检索、跨厂商会话迁移、其他五家任务派发、已运行进程接管、网络链接目标、脚本技能执行、任意 shell 命令或任意 npm 包启动。Git 仅保存在本地，不自动 push；应用退出后定时同步停止。同步不传播删除，自动清理不删记忆或技能；junction 连接后访问的是同一份文件，Agent 自身的修改和删除会直接作用于仓库。

官方依据核对日期：2026-10-23。厂商能力和路径可能变化，发布前仍需使用实际安装版本逐项验证；候选布局没有升级为官方文档依据。
