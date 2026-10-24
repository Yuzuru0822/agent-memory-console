# 集成范围

“文档适配”表示实现参考了公开官方文档；“候选 / 未验证”表示仅提供候选位置或用户绑定的文件与程序管理。两者都不等同于厂商官方合作、认证，或已通过真实账户端到端验证。

下表中的 `~` 指当前 Windows 用户目录，`%LOCALAPPDATA%` 在当前实现中使用用户目录下的 `AppData\Local`。自动发现不读取注册表、不扫描全盘，也不执行可疑程序探测版本。

| Agent | 记忆候选 | 技能候选 | 进程能力与依据 |
| --- | --- | --- | --- |
| Claude Code CLI | `~\.claude\CLAUDE.md` | `~\.claude\skills` | 官方文档适配；原生或 npm 安装版，授权后执行固定 `-p` 单次任务 |
| Qoder | `~\.qoder\AGENTS.md`，仅 CLI 用户静态指令 | `~\.qoder\skills` | 官方文件路径适配；授权后启动 IDE EXE，未接入 Qoder CLI 任务协议或 IDE 自动记忆 |
| WorkBuddy | `~\.workbuddy\MEMORY.md` | `~\.workbuddy\skills` | 参考界面的候选布局；通用 EXE 启动，文件兼容性待验证 |
| TRAE | `~\.trae-cn\memory\user_profile.md`、`~\.trae\memory\user_profile.md` | `~\.trae-cn\skills`、`~\.trae\skills` | 候选布局；通用 EXE 启动，加载规则待验证 |
| DeepSeek Harness | `~\.dsh\AGENTS.md` | `~\.dsh\skills` | 参考界面的 `.dsh` 候选；未实现 DSH CLI 协议，支持手动绑定独立桌面 EXE |
| 智谱 Zcode | 无；手动选择 | 无；手动选择 | 通用文件管理与用户绑定 EXE 启动 |
| 千问 Work | 无；手动选择 | 无；手动选择 | 通用文件管理与用户绑定 EXE 启动；未实现任务派发协议 |

DeepSeek 已发布官方 [DeepSeek Harness](https://www.deepseek.com/harness/)。本应用的 `.dsh` 文件候选仍来自参考界面，尚未按当前官方客户端逐版本核实；官方产品存在不等于这些候选路径或本应用的 CLI 协议已得到验证。候选路径不存在、发生变化或不适合当前版本时，应手动选择真实文件，不要为了获得“路径完整”状态创建并不存在于厂商规范中的目录。

## Claude Code CLI

默认候选 `CLAUDE.md` 是用户维护的持久化指令。Claude 的自动记忆是另一套机制；控制台不自动扫描项目自动记忆目录。v0.2.0 可由用户明确选择某个记忆目录，将其允许的文档按相对路径纳入 `memories/claude/` 并做双向文件合并；这不等于理解项目层级、规则导入或会话历史语义。用户级路径的依据见 [Claude 记忆文档](https://code.claude.com/docs/en/memory)。

技能候选采用用户级 `.claude/skills`，按实际路径去重后的 `SKILL.md` 统计。v0.1.2 支持技能目录本身或其内部的本地符号链接、junction：可只读检查，明确授权实际指向后可同步允许的文本和备份。目录链接可以用于多个 Agent 共用同一份技能；写入共同目标会影响所有引用方。断链、循环和超过检查范围会提示统计不完整；网络与设备路径不支持。

旧版共享源兼容模式只复制允许文本。v0.2.0 统一仓库支持完整技能包（包含脚本和二进制资产）的字节导入、版本管理以及显式 junction 连接；导入期间不执行脚本。控制台不验证 frontmatter、依赖、工具权限或厂商端执行结果。正常源链接被解析为实际文件导入，失效或循环入口保留在原目录备份并单独提示。目录规范见 [Claude 技能文档](https://code.claude.com/docs/en/skills)。

EXE 发现候选为 `~\.local\bin\claude.exe` 和 `~\.claude\local\claude.exe`；它们是查找提示，需用户选择和授权。启动形式为固定参数 `-p`，任务正文通过标准输入传入，等待进程退出并展示输出。CLI 的单次任务及管道输入依据见 [Claude CLI 参考](https://code.claude.com/docs/en/cli-reference)。

用户需事先完成原生或 npm CLI 安装和登录。CLI 任务链不创建登录令牌、不查询账户余额、不添加跳过权限的选项，也不提供交互式终端。v0.4.0 的可见余额文字监控是另行绑定和校准的独立能力，不通过 Claude CLI 查询账号。需要交互审批的任务可能无法在此模式完成，应在 CLI 自身环境中处理。支持范围并不涵盖官方 CLI 文档中的其他命令。

### npm 安装

支持 `npm install -g @anthropic-ai/claude-code`，安装方式见 [Claude 安装文档](https://code.claude.com/docs/en/setup)。控制台只读检查 npm prefix 环境变量、默认 `%APPDATA%\npm`、nvm 路径以及最多 128 个 PATH 目录中的 `claude.cmd`；也可手动选择该文件。发现不会自动授权或执行程序。

`claude.cmd` 仅是定位文件，正文不读取、不执行。解析相邻 `node_modules/@anthropic-ai/claude-code/package.json`，核对包名、版本与已知 `bin.claude` 布局：`bin/claude.exe` 直接执行包内原生程序；`cli.js` 用检查过的本地 `node.exe` 执行。包名和 PE 格式检查不代表签名认证；未知布局拒绝启动并显示错误。当前机器的 npm 2.1.243 布局及 `--version` 已验证；旧版布局用隔离夹具测试，未运行真实计费任务。

支持自定义 prefix 的空格路径及 nvm 外层 junction：授权时解析出实际入口与 Node 路径并在确认框显示，包内链接仍拒绝。每次启动重新检查；入口、运行时或 prefix 重定向变化需要重新授权，同路径版本更新在重新校验后可使用。命令参数使用数组传入，固定为 `-p`，不经过 CMD 或 PowerShell。

## Qoder

v0.2.2 新增统一 Qoder 卡片，使用桌面启动模式。用户级技能候选为 `~\.qoder\skills`；完整技能通常位于 `<skill-name>\SKILL.md`，项目级技能位于 `<project>\.qoder\skills`。授权后的文件可使用备份、双向同步及统一仓库 junction 连接。官方 IDE 文档要求手动安装技能后重启 IDE 并通过 `/` 检查加载结果；控制台发现文件或创建 junction 不等于验证 Qoder 已加载它。依据见 [Qoder IDE Skills](https://docs.qoder.com/extensions/skills) 和 [Qoder CLI Skills](https://docs.qoder.com/cli/Skills)。

记忆候选 `~\.qoder\AGENTS.md` 明确属于 **Qoder CLI 的用户静态指令**，不是 Qoder IDE 的自动记忆。CLI 的项目指令还包括 `<project>\AGENTS.md`、`AGENTS.local.md`，项目规则位于 `<project>\.qoder\rules`；IDE 也公开了项目 `.qoder/rules` 规则目录。项目文件需要手动选择，规则或多文件记忆目录需要在“统一仓库”中单独授权；不扫描全部项目，也不因候选不存在而自动创建文件。依据见 [CLI Memory](https://docs.qoder.com/cli/memory) 和 [IDE Rules](https://docs.qoder.com/user-guide/rules)。

IDE 的自动记忆通过知识中心或 IDE 设置管理，官方 Memory 文档未公布可直接同步的 Markdown 文件路径，本版未接入其内部记忆存储。CLI 的可选 Auto-Memory 另使用 `~\.qoder\projects\<project>\memory` 与可选的 `~\.qoder\memory`，也不会自动扫描；如需纳管，应先在 CLI 的 `/memory` 确认实际位置，再手动授权对应目录，不能把整个 `.qoder` 用户目录当成记忆库。依据见 [IDE Memory](https://docs.qoder.com/user-guide/knowledge-engine/memory) 和 [CLI Memory](https://docs.qoder.com/cli/memory)。

不同发行版和产品的目录不能混用：国际 CLI 的用户目录默认为 `~\.qoder`，可由 `QODER_CONFIG_DIR` 改写；CN CLI 默认为 `~\.qoder-cn`，可由 `QODERCN_CONFIG_DIR` 改写；CN IDE 文档中的技能和项目规则仍使用 `~\.lingma\skills`、`<project>\.lingma\rules`。本版仅自动发现国际版默认候选，地区版与自定义目录都需手动选择。依据见 [国际 CLI 配置范围](https://docs.qoder.com/cli/config-scope)、[CN CLI 配置范围](https://docs.qoder.cn/cli/config-scope)、[CN IDE Skills](https://docs.qoder.cn/user-guide/skills) 和 [CN IDE Rules](https://docs.qoder.cn/user-guide/rules)。

IDE Windows 入口在 1.25.1 起改名为 `Qoder IDE.exe`，保留旧版 `Qoder.exe` 作为候选，依据见 [IDE 更新日志](https://docs.qoder.com/release-notes/desktop)。除常见安装目录外，只读检查最多 128 个 PATH 目录及其 `bin` 父目录，不读取或执行 `qoder.cmd`。同名 PATH 命令可能只是 IDE 启动器，不能据此判定已安装 CLI。本机仅验证了 `D:\Program Files\Qoder IDE\Qoder IDE.exe` 及技能候选目录存在，未启动 Qoder、读取其记忆或凭据正文，也未验证真实账户、技能加载或任务执行。本版不运行 `qoder -p`、`qodercn` 或 npm Qoder 包。

v0.3.0 的积分校准与上述 IDE 发现是独立能力。每日积分活动要求对应地区的**新 Qoder 桌面端**；Qoder IDE 和 CLI 可以使用已到账积分，但不是该活动的领取客户端。国际/CN 两项需要分别绑定实际领取 EXE，不能复用 IDE 启动器推断领取支持。其他限时活动与未接入的交互式 `/claim` 见 [积分活动说明](REWARDS.md)。

## 桌面程序候选

| Agent | EXE 候选 |
| --- | --- |
| WorkBuddy | `%LOCALAPPDATA%\Programs\WorkBuddy\WorkBuddy.exe` |
| TRAE | `%LOCALAPPDATA%\Programs\Trae CN\Trae CN.exe`、`%LOCALAPPDATA%\Programs\Trae\Trae.exe` |
| Qoder | `%LOCALAPPDATA%\Programs\Qoder IDE\Qoder IDE.exe`、旧版 `Programs\Qoder\Qoder.exe`；也检查 Program Files 与有限 PATH / `bin` 父目录 |
| 千问 Work | `%LOCALAPPDATA%\Programs\Qianwen\Qianwen.exe` |
| 智谱 Zcode、DeepSeek Harness | 无；需要手动选择 |

候选路径需与实际安装核对；Qoder 的 EXE 名称有上述官方更新日志依据，其他候选不是经验证的安装规范。实际启动一律要求显式绑定 EXE 与工作目录，并由用户确认。控制台不验证 EXE 的厂商签名；除 Claude 外的六个适配器不传递任务参数。桌面启动器若把工作转交给既有实例后退出，控制台只会显示这个启动器的退出结果。

这些是进程启动候选和授权规则，不授予第三方窗口操作权限。积分领取和余额监控分别要求独立绑定 EXE，并由用户自行打开、登录和校准可见窗口；它们不使用任务工作目录，也不启动客户端或接管其进程生命周期。

## 积分领取与余额监控（v0.4.0）

七个 Agent 展示九个平台条目。以下分类表示主动领取范围，**不代表已经在真实登录账号上领取、验证到账或读到余额**：

| 平台 | 实现范围 |
| --- | --- |
| Qoder 国际版 | 可校准新 Qoder 桌面端每日奖励 UI；验证成功后可直接开启自动领取 |
| Qoder CN | 独立校准对应地区新桌面端，与国际版分开保存 |
| TRAE CN | 可校准当前客户端签到 UI；重置时间需按实际活动核对 |
| WorkBuddy | 可校准当前 Buddy 加油站免费领取 UI；不把月度配额当成每日活动 |
| 千问办公 | 自动或条件赠送说明；不代替登录，也不将打开页面视为到账 |
| 智谱 ZCode | 自动或条件赠送说明；不消耗现有重置卡 |
| Claude Code | 人工权益说明；不代选 Console 组织或修改账单设置 |
| TRAE 国际版 | 未核实可执行的主动领取流程，未接入自动点击 |
| DeepSeek Harness | 官方产品已存在；尚未核实可执行的主动领取流程，未接入自动点击 |

四条 UI 流程只调用用户校准的导航和明确领取控件，要求固定 EXE、唯一可见窗口、活动上下文及明确成功文案。“验证并开启自动领取”先试领，成功后自动开启每日窗口任务；首次只看到已领取不会开启。锁屏拒绝操作，提交后结果未知则暂停，重启不静默重试。没有公开领取 API 的项目不会以内部端点、客户端令牌提取或任意命令替代。五条说明类项目不在后台自动执行任何领取操作。

全部九个平台另提供独立余额监控入口，需手动绑定 Windows 客户端，选择真实可见的余额标题和数值；这是通用的只读 UI 文字校准，**不是九家开箱即用的余额接口**。客户端若不向 UIA 提供明确 Text 字段，当前版本不能读取其余额。领取与余额的 EXE、规则、开关分别保存；不支持主动领取的平台仍可在具备可识别余额页面时配置监控。

每个平台只监控一个选定字段并显示字段标题，单位可选积分、Credits、CNY 或 USD。套餐、活动、加量包可能属于不同余额字段，不自动推算总额或跨平台求和。定时读取周期 5–1440 分钟，默认 15 分钟，可配置低余额阈值；最近 100 次成功采样保存于独立的明文 `balances.json`，界面展示最近 20 次。明确的零值与未读到分开，失败保留旧值并标记过期；差值不等于领取收益。

Qoder 官方明确 Usage 页面的 Credits 卡片显示可用余额，Credits Log 只显示获取记录，不能作为当前余额。[Qoder Credits](https://docs.qoder.com/zh/Credits) WorkBuddy 的“订阅和用量”页可查看分类积分与资源包明细；控制台仅对该精确页面名开放只读导航，购买、充值和续费仍不允许自动操作。[WorkBuddy 更新日志](https://www.codebuddy.cn/docs/workbuddy/Changelog)

已配置的余额在领取前尝试读取当前页，领取后可按已录导航刷新；余额失败不会让已确认的领取再次提交。自动领取与余额监控都要求控制台、目标窗口可用且 Windows 解锁。客户端更新提示或错误弹窗、登录失效和验证码需先人工处理；本版不绕过这些状态，不代登录，也不保存密钥。

官方规则核对日期为 2026-10-24，完整链接、活动时间及“自动发放”和“主动领取”的区别见 [积分活动说明](REWARDS.md)。校准、协议和模拟桌面测试只能证明本应用流程；账号资格、实际客户端 UIA 可见性、活动变化和到账需本机逐项验证。平台窗口去重不识别账号切换，换号后应重新校准。

## 已实现与未实现

已实现：只读候选发现、真实文件状态和 SHA-256、技能目录检查、本地技能链接解析及实际目标授权、共享源兼容同步、写前备份、恢复预览、活动台账、受限 EXE 启停，以及 Claude 单次任务输出。v0.2.0 增加独立 Git 仓库、多文件记忆分区、双向三方合并及人工冲突处理、应用运行期间定时同步、受控备份清理、完整技能包导入和可解除的 junction 连接。实现不等于已通过各厂商客户端验证；本版执行证据见 [测试记录](TESTING.md)。

v0.3.0 增加独立积分平台分类、四条可校准 UI 流程、成功试领后的自动执行、按领取窗口去重、未知结果暂停与活动日志。Windows 原生桥接只接受固定 JSON，通过 UIA 精确检查和调用目标窗口，不执行脚本或全桌面坐标点击。服务和桌面流程使用隔离模拟验证，尚未完成真实账号领取验证。

v0.4.0 增加“验证并开启自动领取”、九个平台独立的余额字段校准、定时监控、低余额提示、采样历史及领取前后余额刷新。原生桥保留原始 UIA 直接父关系，拒绝用无关联页面数字拼成余额。实际领取、到账和余额仍未在真实账号上验证；模拟测试数值不是用户余额。

v0.2.1 的统一仓库迁移可保留技能根或子目录内普通 `.git` 目录中的原历史与远程配置，适用于所有已授权的 Agent 技能目录。中央 Git 只记录工作文件；独立副本的双向同步排除 `.git`，不合并或传播内层历史。junction 连接后直接访问同一份内层 Git。控制台不调用内层 hooks 或远程操作；外置 `.git` 文件、worktree、`alternates` 依赖需先转为独立 clone 再迁移。保留这些数据不等于验证厂商会如何使用它们。

不提供：厂商登录与额度 API、历史会话检索、跨厂商会话迁移、除 Claude 外的六家任务派发、外部进程生命周期接管、任意第三方 UI 操作、网络链接目标、脚本技能执行、任意 shell 命令或任意 npm 包启动。积分功能仅限明确校准并授权的免费领取与只读余额流程，不购买、充值、兑换或制造对话活跃。Git 仅保存在本地，不自动 push；应用退出后定时同步、积分领取与余额调度停止。同步不传播删除，自动清理不删记忆或技能；junction 连接后访问的是同一份文件，Agent 自身的修改和删除会直接作用于仓库。

文件与启动依据核对日期：Claude 为 2026-10-23，Qoder 为 2026-10-24；积分活动及官方 DeepSeek Harness 产品存在性于 2026-10-24 核对。厂商能力和路径可能变化，发布前仍需使用实际安装版本逐项验证；其他候选布局没有因活动文档或产品主页而升级为官方路径依据。
