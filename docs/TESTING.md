# 测试与验证记录

本地服务测试、真实 Electron 窗口测试和厂商集成验证分别记录。测试中的记忆、技能、脚本和 PE 字节均为人工夹具，不来自真实 Agent，也不执行技能脚本。

## v0.7.0 本轮验证（2026-10-26）

本轮将统一仓库操作及总览文件扫描移至持久后台 Worker，增加阶段进度和分页，减少共享技能的重复扫描、基线读写及 Git 索引写入。所有写入验证均使用隔离人工夹具，未同步用户实际技能和记忆，也未关闭其运行中的旧版应用。

| 检查 | 结果 | 范围 |
| --- | --- | --- |
| `npm run build` | 通过 | Renderer/Main/Worker TypeScript、原生组件、Vite |
| `npm test` | 396 通过、2 跳过、0 失败（共 398 项） | 两项文件符号链接权限跳过保留，目录 junction 测试通过 |
| `repository-git-performance.test.ts` | 2 项通过 | 500 文件批量添加、修改/删除/新增混合、16 MiB 批次、索引写入次数与 Git 历史内容 |
| `repository-performance.test.ts` | 5 项通过 | 单次预览复用共享文件与基线读取、重复基线写入去重、75ms 阶段进度节流、观察者故障不影响同步、失败备份及回滚 |
| `repository-host.test.ts` | 11 项通过 | 真实 Worker 的计划保留、授权变化、主线程心跳、单一审计写入及失败回滚、排队后暂停、自动冲突、崩溃不重试及旧配置写入门禁、空闲 tick、定时缓存与手动实时刷新 |
| `node tests/repository-bulk-desktop.cjs` | 通过 | 660 个共享文件、1320 个引用实际同步；跨页批选、默认推荐、CSV、切页与调整窗口、返回后预览和完成提示保留 |
| `node tests/repository-desktop.cjs` | 通过 | 14 项原有仓库/合并/冲突/备份/junction/自动化/窄窗口流程回归 |
| 成品与构建一致性 | 通过 | ASAR 中 40 个编译文件与构建逐字节一致；原生组件哈希一致、无效协议在 UIA 前拒绝；便携 EXE 状态 NotSigned |
| `packaged.cjs` / `portable.cjs` | 通过 | v0.7.0 解包和便携成品实际启动、Worker 总览扫描、沙箱与隔离配置、全部导航 |
| `repository-packaged.cjs` | 通过 | ASAR 内 Worker 初始化仓库及保存 Git、外部文件实时 dirty 状态、二进制/脚本提交、重启历史、内层 Git 保留，未授权 Agent |

660 文件桌面同步期间采用 100ms 心跳：主进程最长间隔约 **115ms**，Renderer 约 **156ms**；每 300ms 发起的进度 IPC 最长约 **18ms**。采到执行前校验、再次校验、备份、写入、Git、基线及完成阶段。页面列表和推荐清单每页最多 100 行，筛选与批选仍覆盖所有页。阶段进度截图与 1000px 窄窗口预览截图已查看，文字与控件无重叠。这些是本机夹具测试结果，磁盘、杀毒软件、文件体积与机器负载会影响实际耗时；后台执行不表示无需等待文件与 Git 写入。

单独 Git 对比夹具（同一实现前后、同一磁盘）：500 个小文件的索引写入 **500 → 2**，约 **11.90s → 4.93s**；1000 个文件 **1000 → 4**，约 **17.39s → 8.85s**。稳定断言采用索引次数与内容一致性，不把墙钟耗时作为性能承诺。共享文件夹具验证 40 文件、两个 Agent 的中央技能树只扫描一次，每个中央文件读取一次；80 个相同基线只读/写一份内容对象。

```powershell
npm run build
npm test
node tests/repository-desktop.cjs
node tests/repository-bulk-desktop.cjs
npm run dist -- --config.directories.output=release-0.7.0
node tests/packaged.cjs "release-0.7.0/win-unpacked/Agent Memory Console.exe"
node tests/repository-packaged.cjs "release-0.7.0/win-unpacked/Agent Memory Console.exe"
node tests/portable.cjs "release-0.7.0/Agent-Memory-Console-0.7.0-win-x64.exe"
```

后台线程异常后不会自动重试未知写入；需重启应用并核对最近操作。暂停只阻止后续自动步骤，已开始写入的同步仍执行收尾/回滚。应用关闭保护保留，测试并未以强杀在途任务作为取消实现。真实厂商账户、真实数据规模上限与极端低内存环境未在本轮验证。

## v0.6.1 验证（2026-10-26）

本轮增加双向同步冲突的时间推荐、共享来源统一选择、批量处理及 CSV 清单。所有写入与内容断言使用隔离人工夹具，不读取用户截图中的文件正文。

| 检查 | 结果 | 范围 |
| --- | --- | --- |
| `npm run build` | 通过 | Renderer/Main TypeScript、原生桥构建与 Vite 构建 |
| `npm test` | 378 通过、2 跳过、0 失败（共 380 项） | 符号链接权限导致的两项跳过保留；目录 junction 测试通过 |
| `repository-recommendations.test.ts` | 11 项通过 | 空仓库、多 Agent、时间新旧/相同、稳定平局、单 Agent 导入、修改时间失效、自身记忆 sourceKey、自动同步不采纳推荐 |
| `repository-review.test.ts` | 9 项通过 | 660 组推荐初始化、共享引用联动、最新来源、无版本跳过、清除/恢复、单行/手动一致性及记忆隔离 |
| `repository-report.test.ts` | 5 项通过 | 当前选择与推荐来源、未处理/手动/普通合并、正文排除、CSV 转义、错误版本拒绝、逻辑/真实/junction/共享源目录写入拒绝 |
| `node tests/repository-desktop.cjs` | 通过 | 原有仓库初始化、双向合并、人工选择、备份、真实 junction、自动化配置与窄窗口回归 |
| `node tests/repository-bulk-desktop.cjs` | 通过 | 660 个共享文件/1320 个引用：空仓库自动预选最新 Agent、筛选勾选/清除/恢复、跨 Agent 单选切换、CSV 不含正文、三处实际内容一致；仓库较旧时默认来源清单正确，批量采用仓库可覆盖推荐 |
| 成品与构建一致性 | 通过 | 37 个 ASAR 编译文件逐字节一致，原生组件哈希一致，无效协议在 UIA 前拒绝；EXE 为 NotSigned |
| 成品 `packaged.cjs` / `portable.cjs` | 通过 | v0.6.1 解包版与便携启动器实际打开窗口、沙箱、隔离配置、七个 Agent 与全部导航；默认未授予领取和通信权限 |

已查看完整页及预览局部截图，推荐来源、原因、修改时间、当前选择和批量控件可读，无重叠。大批量 Windows 文件与 Git 写入超过自动点击的默认 30 秒等待，测试采用 300 秒上限，并等待预览刷新完成后断言；最终完整脚本退出码为 0。系统文件对话框和确认响应由测试替换，未修改用户的实际记忆、技能或运行中旧版实例。

构建与回归入口：

```powershell
npm run build
npm test
node tests/repository-desktop.cjs
node tests/repository-bulk-desktop.cjs
npm run dist -- --config.directories.output=release-0.6.1
node tests/packaged.cjs "release-0.6.1/win-unpacked/Agent Memory Console.exe"
node tests/portable.cjs "release-0.6.1/Agent-Memory-Console-0.6.1-win-x64.exe"
```

## v0.6.0 历史验证（2026-10-26）

本轮新增 MCP 模板共享、加密变量/配置备份与回滚，以及 A2A/MCP 文本消息桥。私有存储生产测试实际使用 Windows safeStorage/DPAPI；收发测试使用独立 Agent 身份、真实本机 HTTP 和模拟原生远端。原生对话框响应由测试替换，所有写入位于隔离目录。

| 检查 | 结果 | 范围 |
| --- | --- | --- |
| `npm test` | 353 通过、2 跳过、0 失败（共 355 项） | 保留所有旧功能回归；跳过项仍为缺少文件符号链接权限，真实目录 junction 测试通过 |
| MCP 文件服务 | 21 项通过 | 格式转换、凭据引用、严格 JSON、保留原配置、冲突、预览过期/失效、加密失败、回滚并发修改、损坏存储、精确 Git 范围 |
| A2A/MCP 桥 | 34 项通过 | 独立身份/ACL、真实 HTTP 往返、协议版本、异步任务与阻塞等待、跨重启去重、终态重试、慢请求撤权、远端查询/取消/未知状态、DNS/IPv6/重定向与连接释放 |
| 加密 codec | 2 项通过 | 系统不可用时失败关闭、版本信封、错误不泄露内容 |
| `node tests/interop-runtime.cjs` | 通过 | 真实 Electron 主进程/preload/IPC + DPAPI、配置原文备份回滚、Git 不含私有值、两个 MCP 身份收发/领取/回复、第三身份隔离、A2A Card/Send/Get/List/版本、令牌轮换 |
| `node tests/interop-ui.cjs` | 83 项断言通过 | UI 使用模拟 API；模板、密码输入、冲突、连接时间、ACL、远端配置、消息状态与人工回复、异步错误及 1000px 布局 |
| `node tests/tasks-desktop.cjs` | 73 项断言通过 | 任务中心回归、9 项导航完整、1000px 无横溢 |
| `node tests/desktop.cjs` | 通过 | 原有七个 Agent、npm/Qoder、记忆与技能权限、真实 junction 同步、备份恢复、导航和窄窗口 |
| 成品 `interop-runtime.cjs` | 通过 | 实际 0.6.0 ASAR 的全部互联流程，随后重启验证 DPAPI 解密、消息/绑定/变量恢复、监听仍关闭、连接时间不伪造 |
| 成品 `packaged.cjs` / `repository-packaged.cjs` | 通过 | 可见窗口、沙箱、初始互联权限全关、全部旧页面、打包 Git 初始化/提交/重启/内层仓库排除 |
| 成品与构建一致性 | 通过 | 36 个 ASAR 编译文件与最终构建逐字节一致，原生桥组件 SHA-256 一致；无效原生协议在 UIA 前被拒绝 |
| `node tests/portable.cjs` | 通过 | 0.6.0 单文件启动器成功解压并打开窗口，互联默认关闭、无凭据或新授权；EXE 的 Authenticode 状态为 NotSigned |

已查看互联页截图：模板、通信桥、消息及窄窗口；示例消息、状态和账号均为人工夹具。**没有验证真实厂商客户端加载 MCP、模型主动轮询收件箱、真实公网 A2A 服务或账户费用；不把已部署配置/入队状态当作真实模型执行。** 客户端格式依据与接入步骤见 [互联说明](INTEROP.md)。

本版关键验证命令：

```powershell
npm run build
npm test
node tests/interop-runtime.cjs
node tests/interop-ui.cjs
npm run dist -- --config.directories.output=release-0.6.0
node tests/packaged.cjs "release-0.6.0/win-unpacked/Agent Memory Console.exe"
node tests/interop-runtime.cjs "release-0.6.0/win-unpacked/Agent Memory Console.exe"
node tests/repository-packaged.cjs "release-0.6.0/win-unpacked/Agent Memory Console.exe"
node tests/portable.cjs "release-0.6.0/Agent-Memory-Console-0.6.0-win-x64.exe"
```

## v0.5.0 历史验证

本轮增加任务中心、持久化总暂停、托盘常驻和本地报表。测试使用隔离配置；托盘运行测试替换系统托盘传输层，保留真实 Electron 主进程、preload、IPC、窗口生命周期和 PNG 解码。**未实际操作用户托盘、登录账号或厂商 UIA，不将模拟余额和领取计为真实账号验证。**

| 检查 | 当前状态 | 范围 |
| --- | --- | --- |
| `npm test` | 296 通过、2 跳过、0 失败（共 298 项） | 新增 37 项任务/仓库调度/托盘回归；两项文件符号链接权限用例跳过，目录 junction 实际通过 |
| 任务控制与报表 | 19 项通过 | 持久化暂停与到期、严格配置和损坏时暂停、20 项任务与跨周期领取、稳定问题、导出字段与 CSV 公式防护 |
| 仓库任务状态 | 8 项通过 | 轻量元数据、结构化冲突/授权/错误、预览等待；在途同步收尾后总暂停阻止清理且保留冲突状态 |
| 托盘模块 | 10 项通过 | 注入传输层验证菜单回调、暂停更新、PNG 字节、创建/更新失败、外部失效、幂等销毁及失效旧回调 |
| `node tests/tasks-desktop.cjs` | 72 项断言通过 | 真实 Electron UI + 模拟任务 IPC；20 项任务、分类筛选、问题定位、全局横幅、托盘开关、CSV、异常保留及 1000px 布局 |
| `node tests/tasks-runtime.cjs` | 已通过 | 实际主进程与固定 IPC；暂停阻挡各阶段、在途暂停不启动后续阶段、恢复保留独立授权、取消退出计时器仍运行、CSV 取消/保存/非法目标拒绝、托盘隐藏/显示/失效回退；系统托盘和调度服务用隔离替身 |
| `npm run test:desktop` | 已通过 | 七个 Agent、原有记忆/技能/junction 同步、备份恢复、npm 与 Qoder、权限及布局 |
| `node tests/rewards-balance-desktop.cjs` | 76 项断言通过 | 余额配置、监控、错误/过期/零值、历史与验证后自动领取回归，厂商窗口为夹具 |
| Windows 成品与构建一致性 | 已通过 | 0.5.0 解包与便携解压启动、20 项任务、默认托盘关闭且未增加授权；29 个 ASAR 编译文件与最终构建逐字节一致，原生组件 SHA-256 一致且拒绝无效协议；成品未签名 |
| 成品内 Git 回归 | 已通过 | 实际 0.5.0 ASAR 中初始化、文本/二进制提交、重启历史、内层 Git 保留与排除；无真实 Agent 授权 |

已查看 `tasks-center.png`、`tasks-compact.png` 与 `tasks-inventory.png`：深色界面、20 项任务和八项导航可用；示例状态均为人工夹具。真实 Windows 托盘菜单外观、系统重启后的用户会话体验、厂商账号实际领取和余额读取仍需人工验证。设计与行为说明见 [自动任务设计](AUTOMATION.md)。

## v0.4.0 历史验证

本轮加入验证后开启自动领取、独立余额监控与领取前后采样。测试均使用隔离配置和人工控件夹具；**未在真实账号领取积分、读取真实余额或验证实际到账**。本机 Windows 桌面锁定后停止真实客户端操作。

| 检查 | 当前状态 | 范围 |
| --- | --- | --- |
| `npm test` | 259 通过、2 跳过、0 失败（共 261 项） | 全量本地后端回归；两项文件符号链接权限用例仍跳过，目录 junction 实际通过 |
| 领取服务 | 38/38 通过 | 验证后自动开启、首次仅已领取不启用、未知暂停、领取前后采样隔离、导航恢复、采样期间仍持有领取锁及既有去重保护 |
| 余额服务 | 26/26 通过 | 单字段解析、直接父容器关联、重复/歧义拒绝、零值、失败保留旧样本、过期和低阈值、单位隔离、持久化、定时轮询及精确只读导航例外 |
| Windows 桥接 | 15/15 通过 | 可见控件直接父索引、隐藏父节点断开关联、500 个可见控件允许且第 501 个使整次观察失败；无效协议与纯投影测试不访问真实 UIA |
| `npm run build` | 已通过 | TypeScript、Vite、原生桥接组件，版本 0.4.0 |
| `npm run test:desktop` | 已通过 | 七个 Agent、既有同步/备份/授权、npm 与 Qoder、沙箱及布局回归 |
| `node tests/rewards-desktop.cjs` | 64 项断言通过 | 原积分配置、领取、授权、持久化和窄窗口回归，厂商桥为模拟对象 |
| `node tests/rewards-balance-desktop.cjs` | 76 项断言通过 | 真实 Electron/preload/IPC/React + 模拟厂商桥；九平台余额、独立绑定/配置/自动确认、字段与导航校准、零值/错误/过期/阈值、采样历史、验证后自动领取、持久化与紧凑布局 |
| Windows 解包与便携成品 | 已通过 | 0.4.0 解包窗口及单文件解压启动、独立配置、原生组件、九平台余额入口、初始无领取/余额授权、沙箱与版本；成品未签名 |
| 成品内 Git 回归 | 已通过 | 实际 0.4.0 ASAR 中初始化、文本/二进制提交、重启历史、内层 Git 保留与排除；隔离配置且无真实 Agent 授权 |
| ASAR 与原生组件一致性 | 已通过 | 26 个成品编译文件与本地最终构建逐字节一致；原生组件 SHA-256 一致，成品 helper 在访问桌面 API 前拒绝无效协议 |
| 真实厂商账号 | 未执行 | 仍需解锁、处理客户端阻塞弹窗、逐项校准 UIA 字段与领取流程，确认账号资格及到账 |

已查看余额卡片、配置、校准及紧凑布局截图。截图中的余额来自人工夹具，不是实际账号。控制台及已绑定客户端需保持打开、可见、已登录，Windows 需解锁；尚未校准的条目不会自动操作。完整能力与限制见 [积分与余额说明](REWARDS.md)。

## v0.3.0 历史验证

本轮新增“积分福利”。所有厂商观察和领取动作均使用隔离夹具；**未在真实账户领取积分，也未验证实际到账**。九个平台条目中的四条 UI 流程需要在真实客户端中校准与试领。

| 检查 | 当前状态 | 范围 |
| --- | --- | --- |
| `npm test` | 219 通过、2 跳过、0 失败（共 221 项） | 包含 28 项积分服务及 11 项 Windows 桥接回归；原有文件符号链接权限用例跳过，目录 junction 实际通过 |
| 积分服务 | 28/28 通过 | 平台分类、校准令牌、危险控件/余额上下文拒绝、明确成功、日切去重、跨界未知、并发锁、未知结果重启暂停、EXE 变化与台账损坏 |
| Windows 桥接 | 11/11 通过 | 固定 EXE、JSON stdin、无 shell、输入/输出限额、超时、上下文参数；实际原生组件拒绝无效协议及纯投影隐藏元素过滤，不访问真实 UIA 窗口 |
| `npm run build` | 已通过 | TypeScript、Vite、系统 .NET Framework 编译原生组件，版本 0.3.0 |
| `npm run test:desktop` | 已通过 | 七个 Agent、既有同步/备份/授权、npm 与 Qoder、沙箱及布局回归 |
| `node tests/rewards-desktop.cjs` | 64 项断言通过 | 真实 Electron/preload/IPC/React + 模拟厂商桥；九类条目、绑定取消/确认、导航/领取记录、试领/自动确认、去重、未知暂停、持久化及窄窗口 |
| Windows 解包成品 | 已通过 | 0.3.0 启动、隔离配置、沙箱、七个 Agent、九个福利条目、四条可校准流程、初始自动关闭、原生组件资源路径及 PE 格式 |
| 原生组件交付 | 已通过 | 成品 helper 可启动并在访问桌面 API 前拒绝无效协议；与本地编译组件 SHA-256 一致 |
| 统一仓库桌面回归 | 14 场景通过 | 本地 Git、多文件记忆、双向冲突、完整技能/junction 导入解除、保留删除内容、自动任务与布局 |
| ASAR 内 Git 与资源一致性 | 已通过 | 成品内 Git 初始化/提交/重启历史、内层 Git 保留；24 个 ASAR 编译文件与最终构建字节一致，版本 0.3.0 |
| Windows 便携成品 | 已通过 | 单文件自动解压与启动、隔离配置、九个福利条目、原生组件随包解压、默认无领取授权与界面导航 |
| 真实厂商领取 | 未执行 | 桌面锁定后停止真实客户端检查；仍需解锁后逐项验证控件兼容性、账号资格、成功文本和到账 |

已查看积分页面截图，深色布局及紧凑窗口正常。自动领取依赖控制台运行、Windows 解锁、已绑定客户端可见且已登录；未验证的流程不能启用自动。详细规则及未集成活动见 [积分活动说明](REWARDS.md)。

## v0.2.2 历史验证

本轮接入第七个 Agent Qoder，已有六个 Agent 配置保持兼容。测试使用隔离夹具，不修改真实 Qoder 的技能或记忆。

| 检查 | 当前状态 | 范围 |
| --- | --- | --- |
| `npm test` | 180 通过、2 跳过、0 失败（共 182 项） | 新增 7 项 Qoder 回归；两项 Windows 文件符号链接权限跳过，目录 junction 实际通过 |
| Qoder 发现与授权 | 已通过 | 默认新旧 IDE EXE、Program Files、有空格的 PATH / bin 父目录、128 项上限、非法路径过滤、发现不授权、旧配置原样加载 |
| Qoder 仓库同步与连接 | 已通过 | 多文件记忆、两端修改及不传播删除；完整 Git 历史、hooks、忽略资产、二进制和空目录的 junction 导入与解除；不执行脚本 |
| Qoder 启动校验 | 已通过 | 需要已授权 EXE 与工作目录、固定空参数、不使用 Claude CLI 参数、拒绝 CMD 和变化后的无效 PE；不真实启动 Qoder |
| `npm run build` | 已通过 | TypeScript 与 Vite 生产构建、版本 0.2.2 |
| `npm run test:desktop` | 已通过 | 七张卡片、动态计数、Qoder 配置/发现/授权取消/确认/撤销、文件路径能力标签，以及既有桌面回归；Renderer 异常为零，窄窗口无横向溢出 |
| 本机 Qoder 只读发现 | 已通过 | 找到已安装 IDE EXE 和用户级技能目录；13 个技能、无自动授权；未更改真实 Agent 文件 |
| `node tests/repository-desktop.cjs` | 14 场景通过 | 仓库初始化、多文件记忆、冲突处理、完整技能/Git 导入与解除、自动任务和布局 |
| Windows x64 解包与便携成品 | 已通过 | 0.2.2 可见窗口、沙箱、七个适配器、Qoder 详情与能力、独立配置、便携自动解压；成品未签名 |
| 内嵌 Git 与构建一致性 | 已通过 | 成品内 Git 初始化/提交/重启历史读取，内层 Git 保留；20 个 ASAR 编译文件与最终构建字节一致 |

已查看 `test-results/qoder-details.png` 与 `dashboard-compact.png`，确认配置说明、七卡片和深色布局正常。尚未验证真实 Qoder 登录、技能加载、任务运行或 IDE 自动记忆内部存储；本版不提供 Qoder CLI 任务派发。路径与产品差异见 [集成说明](INTEGRATIONS.md)。

## v0.2.1 历史验证

本轮增加技能迁移保留普通内层 Git 仓库的能力。以下状态独立于 v0.2.0 的历史结果，使用当前源码与 0.2.1 成品验证。

| 检查 | 当前状态 | 需要核验的范围 |
| --- | --- | --- |
| `npm test` | 173 通过、2 跳过、0 失败（共 175 项） | 全量本地后端回归；文件符号链接用例因 Windows 权限限制跳过，未计为通过 |
| 普通技能 Git 仓库迁移 | 后端测试已通过 | 根及嵌套 `.git`、packed 历史、refs/index/hooks/忽略资产与空目录保留；同名完整元数据复用、不同元数据整仓库冲突；导入中失败回滚 |
| 中央 Git 与独立副本同步 | 后端与解包成品均通过 | 工作文件纳入中央版本和双向同步；排除内层 `.git`，不生成 gitlink、不传播内层历史；ASAR 中提交及重启读取成功 |
| junction 与 Git | 后端与桌面均通过 | 连接保留完整工作树与原入口；解除连接恢复原目录和原元数据，仓库内容保留 |
| 外部依赖与执行边界 | 后端测试已通过 | 外置指针、共享工作树/对象库、路径配置、锁与元数据链接拒绝；注释/续行配置解析；目标及父目录被替换时停止连接并保留现场；普通文件 32 MiB / Git pack 128 MiB 边界 |
| `npm run build` | 已通过 | Renderer 类型检查、Electron 主进程/preload、Vite 生产构建 |
| 桌面 UI 回归 | 原有桌面回归及 14 个仓库场景均通过 | 新增真实 Git 技能夹具：迁移提示、配置正文不展示、提交历史和远程配置保留、中央索引排除元数据、解除连接恢复 |
| Windows x64 解包成品 | 已通过 | 0.2.1 可见窗口、沙箱及原生接口；只读发现 npm Claude 2.1.243；19 个 ASAR 编译文件与构建结果一致 |
| Windows x64 便携成品 | 已通过 | 自动解压、独立测试配置、可见窗口与原生接口；成品未签名 |

## v0.2.0 历史验证

下表记录 v0.2.0 已执行结果。厂商账户验证与应用本地功能验证分开。

| 检查 | 当前状态 | 范围 |
| --- | --- | --- |
| `npm test` | 149 通过、2 跳过、0 失败（共 151 项） | 既有安全、npm 与链接回归；新增 Git 仓库、三方合并、完整技能迁移、仓库服务及自动化 |
| `npm run build` | 已通过 | Renderer 类型检查、Electron 主进程/preload、Vite 生产构建 |
| `node tests/process-smoke.cjs` | 已通过 | 无害 Node.exe 替身，真实启动、stdin/stdout、退出码、只停止所属进程 |
| `node tests/npm-process-smoke.cjs` | 已通过 | 合成 cli.js、固定参数、原样输入、启动钩子环境清理 |
| `npm run test:desktop` | 已通过 | 原有共享源兼容流程、授权取消、npm 绑定、链接读写与备份恢复 |
| `node tests/repository-desktop.cjs` | 14 场景全部通过 | 新仓库 UI、Git 初始化、纳管成员、多文件记忆、三方/手动合并、junction 导入与解除、自动化设置、清理与布局；追加预览取消、多 Agent 二进制统一选择 |
| Windows x64 打包 | 已通过 | `release-0.2.0/` 包含解包版与便携 EXE；保留旧版目录，成品未签名 |
| `node tests/packaged.cjs` | 已通过 | 解包成品可见窗口、0.2.0 版本、沙箱、固定 API、独立测试配置；只读发现 npm Claude 2.1.243 |
| `node tests/repository-packaged.cjs` | 已通过 | ASAR 内嵌 Git、独立仓库初始化、文本/二进制提交、重启和版本读取，无 Agent 授权 |
| ASAR 与构建产物一致性 | 18 个编译文件一致，版本 0.2.0 | 界面 JS/CSS/HTML、主进程及 preload；不沿用旧版资源 |
| `node tests/portable.cjs` | 已通过 | 单文件自动解压、成品窗口和退出、独立配置、六个适配器及原生接口 |
| 六家厂商真实账户与技能加载 | 未验证 | 没有代替用户登录、运行付费任务或证明跨厂商技能兼容 |
| 代码签名 / 自动更新 | 未配置 | 工程不包含签名凭据或自动更新服务 |

历史参考：v0.1.2 的 88 项后端测试中 86 通过、2 项文件符号链接用例因 Windows `EPERM` 跳过；目录 junction 回归实际通过。该旧版桌面、解包及便携启动曾通过，不能代替其他版本的验证。npm Claude 2.1.243 曾仅执行 `--version`，没有验证登录、任务权限或计费调用。

## 运行命令

在 Windows x64、Node.js 24 的工程根目录执行：

```powershell
npm ci
npm test
npm run build
node tests/process-smoke.cjs
node tests/npm-process-smoke.cjs
npm run test:desktop
node tests/repository-desktop.cjs
node tests/rewards-desktop.cjs
node tests/rewards-balance-desktop.cjs
node tests/tasks-desktop.cjs
node tests/tasks-runtime.cjs
npm run dist -- --config.directories.output=release-0.5.0
node tests/packaged.cjs "release-0.5.0/win-unpacked/Agent Memory Console.exe"
node tests/repository-packaged.cjs "release-0.5.0/win-unpacked/Agent Memory Console.exe"
node tests/portable.cjs "release-0.5.0/Agent-Memory-Console-0.5.0-win-x64.exe"
```

需要更快检查解包产物时使用 `npm run pack -- --config.directories.output=release-0.5.0`。默认打包目录仍为 `release/`，若旧版正在使用它，不要强行终止用户程序；改用版本目录。成品测试脚本首个参数接受自定义 EXE 路径。以上命令是本版验证入口，是否已执行以顶部结果表为准。

桌面测试需要完整 Electron 运行时和可用图形桌面，不能用单纯浏览器预览替代。electron-builder 使用已安装的 `node_modules/electron/dist`。

## 后端覆盖

`npm test` 使用 `tsx` 和 Node 测试器。所有写入测试都使用隔离临时目录，结束后按路径范围检查清理；不会读取真实 `.claude` 配置或启动厂商客户端。

| 测试文件 | 主要覆盖 |
| --- | --- |
| `safety.test.ts` | 绝对本地路径、UNC/设备/ADS 拒绝、链接及父目录逃逸、文本容量和编码、原子替换、PE 格式 |
| `service.test.ts` | 发现不授权、兼容同步及恢复、过期/改动计划、批次预检、重复目标、保护目录、损坏备份与台账、部分失败恢复 |
| `processes.test.ts` / `claude-npm.test.ts` | 原生和 npm 授权、固定参数、未知结构拒绝、入口改动、旧版 Node 与新版 EXE、有限 PATH/prefix 发现 |
| `skill-paths.test.ts` / `linked-service.test.ts` | 根/父级/内部 junction、实际路径去重、断链和循环、旧授权不扩大、目标改指拒绝、链接保留与恢复 |
| `merge.test.ts` | 单端变化、双方独立变化、真实冲突、无共同版本、换行保留及容量限制 |
| `repository-git.test.ts` | 独立空目录初始化、标识校验、状态/提交/历史、仓库链接拒绝、路径与对象范围约束 |
| `junction-migration.test.ts` | 完整技能字节、脚本仅存储、同名冲突、断链/循环保留、入口身份变化、迁移失败回滚、解除连接保留仓库；普通内层 Git 保留、整仓库冲突与复用、外部依赖/锁拒绝、pack 容量 |
| `repository-service.test.ts` | 多文件记忆分区、共同版本、双向预览/选择、无删除传播、自动化授权范围、备份与清理策略；具体断言和计数以测试输出为准 |
| `repository-shared.test.ts` | 多 Agent 共享技能的单端文字/二进制更新、独立修改汇总、真实冲突、统一版本选择、人工预览期间暂停自动任务 |
| `rewards-service.test.ts` | 领取校准、风险控件拒绝、活动窗口去重、未知结果暂停、持久化与并发；验证后自动开启及余额前后采样隔离 |
| `rewards-balance.test.ts` | 余额字段/数字/父容器校验、单字段历史、真实零值、错误保留、过期、低阈值、轮询及导航恢复 |
| `rewards-windows.test.ts` | 固定原生程序及受限 JSON 协议、超时/输出限额、直接父索引；纯原生投影和无效协议，不操作厂商界面 |
| `task-center.test.ts` | 暂停持久化和到期、损坏设置保持暂停、任务/问题优先级与跨周期领取、固定字段 CSV |
| `repository-tasks.test.ts` | 轻量调度状态、预览/冲突/授权变化、在途暂停阻止后续清理但不打断同步 |
| `task-tray.test.ts` | 隔离菜单回调、PNG、创建/更新/外部失效、销毁与旧回调失效 |

文件符号链接测试若因系统权限不足被跳过，应在顶部结果表记录跳过数及原因；不能将跳过计为通过。目录 junction 通常无需同样权限，需实际创建和验证。模拟 PE 字节只验证格式，不是可运行的程序。

## 桌面 UI 检查

`tests/desktop.cjs` 保留 v0.1.x 的流程覆盖，并扩展为七张卡片、无 Renderer Node、上下文隔离/沙箱、共享源同步、授权取消与确认、实际链接映射、备份恢复、npm 入口授权及撤销、页面切换和窄窗口。

新增 `tests/repository-desktop.cjs` 启动真实 Electron，通过仅开发模式可用的 `CONSOLE_TEST_HOME` 与 `CONSOLE_TEST_DATA` 隔离到 `../../work/repository-desktop-<时间戳>/`，检查：

- 取消仓库初始化不创建 `.git` 或授权；确认后生成真实仓库、初始提交与工作区状态。
- 纳管成员持久化，但不会隐式创建 junction；记忆目录内多份文档保持相对路径。
- Agent 与仓库不同位置修改可三方合并；同处冲突禁用应用按钮，手动编辑后两端一致。
- 关闭预览使后端计划失效；多个 Agent 对同一技能二进制文件冲突时，可选择一个 Agent 版本用于全部引用方。
- 删除一端文件会从另一端补回，不将删除传播；完整技能脚本按字节保留且不执行。
- 技能同名冲突必须选择；导入后创建真实 junction，保留原目录；解除连接恢复原目录并保留仓库新增内容。
- 自动化启用及关闭、保留策略和手动清理；原生确认显示实际路径并默认取消。
- 1000 × 800 窗口无横向溢出，捕获到的 Renderer 脚本异常为零。

自动化运行与保留期限逻辑另由服务测试覆盖。桌面脚本替换系统文件选择器返回值和原生确认响应，不证明真实人工点击 Windows 文件对话框已完成验证。v0.2.0 最终构建后执行全部 14 项场景通过，包含关闭预览使计划失效、多 Agent 二进制统一选择、缺失版本按钮禁用及刷新状态保留，Renderer 异常为零。该轮截图在 `test-results/repository-conflict.png` 与 `repository-compact.png`，已逐张查看，深色布局与冲突编辑区正常，1000 像素窗口没有横向溢出。截图只包含人工夹具；不替代 v0.2.1 的测试结果。

## 成品与进程检查

`process-smoke.cjs`、`npm-process-smoke.cjs` 使用无害 Node 替身检查真实进程生命周期，不调用真实 Claude 或模型。通用子进程测试验证仅停止本控制台持有的句柄；不会通过名称杀死其他程序。

`packaged.cjs` 用独立 `--user-data-dir` 启动解包 EXE，确认打包状态、版本、可见窗口、沙箱、受限接口、七张卡片和导航。`portable.cjs` 验证 NSIS 单文件解压后启动，使用仅绑定 `127.0.0.1` 的临时 CDP 端口连接并清理测试进程。正常双击不附带这些调试参数。

`repository-packaged.cjs` 在独立配置与空夹具目录中，通过实际成品初始化仓库、保存记忆和完整技能资产，重启后检查历史及提交内容；始终断言没有 Agent 路径或自动同步授权。

打包模式的候选发现仍可能只读检查当前 Windows 用户的默认 Agent 路径。成品脚本不会授权或写入这些目录；成品截图仅供本机诊断，不应作为合成示例公开分享。发布前应核对 ASAR 中当前编译产物，避免旧输出目录混用。

## 尚需人工与厂商验证

目标 Windows 环境仍需验证真正的文件选择器、UAC/文件权限条件、可信 EXE 启停、关闭时仍有子进程的提示、默认数据位置，以及运行中的客户端对 junction 切换和技能更新的反应。不要在客户端仍写入技能目录时迁移；本地并发改动会使预览失效或触发保留现场。

没有执行真实账户端到端调用、完整 Windows 重解析点矩阵、恶意同用户程序隔离、压力测试、专业渗透测试或签名分发验证。Git 版本与可见文件不证明厂商已加载技能。
