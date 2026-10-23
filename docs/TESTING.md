# 测试与验证记录

本项目将本地服务测试、真实 Electron 窗口测试和厂商集成验证分开记录。测试文件中的示例记忆、技能和 PE 字节均为人工构造的数据，不来自用户的真实 Agent。

## 当前状态

截至 2026-10-23，v0.1.2 验证记录。下表只记录本版已经确认的结果；“待验证”不代表已通过。

| 检查 | 状态 | 说明 |
| --- | --- | --- |
| `npm test` | 86 项通过，2 项跳过，0 失败 | 共 88 项；本地服务、安全边界、npm 安装及真实 junction 回归通过；2 项文件符号链接用例因创建权限 `EPERM` 跳过 |
| `npm run build` | 已通过 | 类型检查、Electron 主进程与 preload 编译、React 界面生产构建 |
| `node tests/process-smoke.cjs` | 已通过 | 使用无害 Node.exe 替身真实启动，检查标准输入/输出、PID、运行状态、退出码、仅停止所属子进程和活动链 |
| `node tests/npm-process-smoke.cjs` | 已通过 | 使用合成 cli.js 与真实 Node，检查固定参数、原样 stdin、禁用继承的启动钩子、输出和退出码 |
| 本机 npm Claude `--version` | 历史验证 | v0.1.1 曾直接执行包内 EXE，输出 2.1.243；未发送任务或验证登录 |
| `npm run test:desktop` | 已通过 | 真实 Electron 45.0.0；既有流程及真实 junction 的展示、取消授权、实际映射确认、同步和备份恢复；原 junction 保留 |
| `npm run pack` / dist 的解包阶段 | 已完成 | Windows x64 `release-0.1.2/win-unpacked/`；ASAR 中 12 个编译文件与本次构建完全一致；保留用户正在运行的旧版 |
| `node tests/packaged.cjs` | 已通过 | v0.1.2、可见窗口、沙箱、六个适配器和隔离配置；本机 npm Claude 2.1.243 候选仍可发现 |
| `npm run dist` | 重定向构建已完成 | 默认输出目录被运行中的旧版占用；使用 `release-0.1.2/` 成功生成本版便携 EXE，102,341,862 字节，未签名 |
| `node tests/portable.cjs` | 已通过 | 本版 NSIS 单文件自动解压启动、隔离配置、六张卡片、原生接口、渲染进程无 Node、页面切换及关闭 |
| 六家厂商真实客户端、真实账户 | 未验证 | 未测试账户登录、实际任务计费、真实会话协议或技能在厂商端加载 |
| 代码签名与外部分发验证 | 未配置 / 未验证 | 本工程不包含签名凭据或签名发布流程 |

源码或依赖变化后应重新运行相应检查，并更新此表。桌面与成品启动通过不证明厂商协议兼容，也不包含真实账户验证。

## 运行命令

在 Windows x64、Node.js 24 环境中，从工程根目录运行：

```powershell
npm ci
npm test
npm run build
node tests/process-smoke.cjs
node tests/npm-process-smoke.cjs
npm run test:desktop
npm run pack
node tests/packaged.cjs
npm run dist
node tests/portable.cjs
```

桌面测试需要可用的图形桌面和完整 Electron 运行时，不能通过单纯浏览器预览替代。electron-builder 从 `node_modules/electron/dist` 取得已安装的 Electron 运行时。解包版使用 `tests/packaged.cjs`，便携单文件使用独立的 `tests/portable.cjs`。

本次默认 `release/` 中的旧版仍被用户打开，打包在覆盖文件时返回 `EPERM`。为保留正在使用的程序，改用独立版本目录；构建和成品测试可使用：

```powershell
npm run dist -- --config.directories.output=release-0.1.2
node tests/packaged.cjs "release-0.1.2/win-unpacked/Agent Memory Console.exe"
node tests/portable.cjs "release-0.1.2/Agent-Memory-Console-0.1.2-win-x64.exe"
```

两个成品测试脚本均接受首个可选参数作为 EXE 路径；省略时仍使用默认 `release/`。单独构建解包目录可运行 `npm run pack -- --config.directories.output=release-0.1.2`。上述重定向构建及成品验证的完成状态以本页表格为准。

本机技能目录另完成只读元数据检查：统计 97 个技能、7 个有效链接，并单独报告 1 个断链；未读取技能正文或修改真实技能文件。该诊断结果不包含私人绝对路径，不代表技能已在厂商客户端成功加载。

## 后端测试覆盖

使用 Node 内置测试器，由 `tsx --test tests/*.test.ts` 执行。`tests/helpers.ts` 为每个测试在操作系统临时目录创建独立根目录，测试结束后清理；适配器的 home、local 与数据目录均指向这些夹具。测试不会读取实际用户的 `.claude` 等目录，也不会启动厂商客户端。

| 测试文件 | 当前覆盖 |
| --- | --- |
| `tests/safety.test.ts` | 拒绝相对路径、磁盘根、网络/设备路径与 Windows ADS；防止兄弟目录前缀误判和父目录逃逸；严格路径检查仍拒绝 junction；拒绝 NUL、无效 UTF-8、超大文件和目录；允许文本及隐藏/生成文件过滤；同步文件数量上限；原子替换及重命名故障后的临时文件清理；PE 格式检查，拒绝改名脚本和 DLL |
| `tests/service.test.ts` | 发现不授予权限；记忆预览、备份、写入及恢复；源或目标修改后中止；全批次预检查；撤销授权和新预览使旧计划失效；计划只能执行一次；重复实际目标与嵌套技能源/目标拒绝；只复制文本并保留目标独有文件；预览后目标链接变化拒绝；保护应用/数据目录；损坏快照和非法清单拒绝；恢复需当前授权；台账改写、删行、重排检测；台账损坏阻止写入及授权变更；多文件部分失败保留完整写前快照并可恢复；恢复保留后续新增文件 |
| `tests/processes.test.ts` | 必须明确授权程序和工作目录；拒绝空白及超长 Claude 任务；授权后被替换的 EXE 再次检查；无法停止未归属进程；npm 发现不授予权限、授权/撤销/与原生配置互斥、固定程序与参数以及入口变更拒绝 |
| `tests/claude-npm.test.ts` | 新旧包结构、自定义 prefix 的空格和特殊字符、元数据/文本大小限制、错误包名及入口逃逸、缺失 Node、路径变更、同路径升级、nvm/prefix junction 解析、包内链接拒绝、有限环境候选及只读发现 |
| `tests/skill-paths.test.ts` | 根目录、父级、内部 junction 与文件符号链接解析；保留逻辑相对路径；重复实际路径去重；断链、循环、过长链接链、UNC、设备路径和 ADS 拒绝；只读统计与同步文本限制分离；隐藏/脚本排除；遍历深度和条目上限 |
| `tests/linked-service.test.ts` | 链接检查不自动授权；授权前映射变更拒绝；授权后同步和恢复保留 junction；源链接内容复制为普通文本；旧授权及新加链接需确认；实际目标重复或嵌套拒绝；保护目录、断链和循环拒绝；撤销或改绑后旧快照不能绕过当前授权 |

`peFixture()` 只构造格式校验所需的字节，不是可运行的 Windows 程序，单元测试从不执行它。单元测试不覆盖真实进程启动；真实子进程生命周期由下述独立脚本验证。

v0.1.2 的真实 junction 回归已通过，包括根目录及内部目录解析和实际路径去重、统计与文本同步限制分离、循环与断链警告、旧授权重新确认、授权后同步和恢复保留 junction，以及预览后改指、未授权链接和受保护目标拒绝写入。

本机 Windows 不允许测试进程创建文件符号链接，返回 `EPERM`，因此明确跳过以下 2 项：`tests/skill-paths.test.ts` 的文件链接解析、去重和逻辑相对路径用例，以及 `tests/linked-service.test.ts` 的源文件链接指向目标时的实际路径重叠保护用例。这两项未完成实机验证，不能算作通过；目录 junction 测试已实际创建链接并通过。

## 真实子进程生命周期测试

构建主进程后运行 `node tests/process-smoke.cjs`。脚本在 Windows 上创建临时的隔离数据目录，将 `fs.realpathSync(process.execPath)` 得到的实际 Node.exe 绑定为无害测试程序，避免 Node 安装管理器的 junction 路径。它借助 Node 自身的 `-p` 与标准输入行为，测试控制台使用的固定参数和输入管道，不会执行真实 Claude。

脚本检查实际启动、非空 PID、标准输出中的 `helper-output` 与计算结果 `42`、退出码 `0`，以及运行状态变化。第二次启动一个等待中的所属子进程，验证只能停止该进程；另一个无关辅助进程应保持运行，活动哈希链应完整。结束时清理本次辅助进程与经路径校验的临时目录。

这验证了本地进程管理实现，不验证 Claude 登录、模型调用、计费、权限交互或厂商进程树行为。测试通过不能升级为真实 Claude 或其他厂商集成已验证。

## Electron 桌面冒烟脚本

v0.1.2 通过 `tests/npm-process-smoke.cjs`：临时目录中的合成 `cli.js` 接收固定 `-p`，包含 shell 元字符的任务原样进入 stdin，CMD 正文不执行，故意设置的 `NODE_OPTIONS`、`NODE_PATH`、`ELECTRON_RUN_AS_NODE` 不传入子进程，退出码为 0，台账完整。真正的已安装 npm 版此前仅执行了 `--version`；未调用模型。

`tests/desktop.cjs` 使用 Playwright 的 Electron 驱动启动构建后的应用。它通过仅开发版本有效的 `CONSOLE_TEST_HOME` 和 `CONSOLE_TEST_DATA` 设置隔离的用户目录与数据目录，夹具保留在相对于工程的 `../../work/desktop-fixture-<时间戳>/`，便于失败后排查。

桌面脚本覆盖以下检查；本版执行结果见顶部状态表：

- 六张 Agent 卡片与 preload API 出现，渲染页面没有 `window.require`；运行时确认沙箱、上下文隔离和 Node 集成设置。
- 记忆同步预览展示前后文本；取消确认不写入，确认后同步、备份及台账结果符合预期。
- 技能文本同步，以及从快照生成恢复计划并还原原始内容。
- 真实 junction 的技能统计和界面展示；取消“授权技能链接”不保存，原生确认内容包含实际映射；确认后的同步、备份恢复均保留 junction 本身。
- 非法 Agent ID 被拒绝；未经授权的 EXE 不启动，详情中的启动按钮禁用。
- npm 合成安装被发现但未自动授权；取消确认不保存，确认框包含实际入口与版本，确认后显示已授权，撤销后不能继续使用。未选择工作目录和任务时运行按钮保持禁用。
- 页面切换、详情面板，以及 1000 × 800 窗口下无横向溢出；没有捕获到的页面脚本异常。

脚本把原生确认框替换为可控响应，以验证取消与确认两条分支。它不会实际操作系统文件选择器，因此不证明人工路径授权对话流程已经完成验证，也不会替用户启动真实 Agent。

运行截图保存到 `test-results/`：`sync-preview.png`、`agent-details.png`、`linked-skills.png`、`dashboard.png` 和 `dashboard-compact.png`。这些截图展示人工构造的测试夹具，不是实际账户数据。

## 解包成品测试

`tests/packaged.cjs` 实际启动 `release/win-unpacked/Agent Memory Console.exe`，通过 Chromium 的 `--user-data-dir` 参数将配置与日志隔离到相对于工程的 `../../work/packaged-profile-<时间戳>/`。测试检查打包状态、沙箱、数据目录隔离、六个 Agent 卡片、渲染进程没有 `window.require`，以及集成页面与总览之间的切换。

本次通过自定义路径启动 `release-0.1.2/win-unpacked/Agent Memory Console.exe`，确认版本 0.1.2、窗口可见、沙箱开启、六个适配器和隔离配置，并保留 npm Claude 2.1.243 候选发现。另核对 ASAR 内 12 个编译文件，均与本次构建逐字节一致。

另以隔离配置打开本版 Claude 详情，确认显示本机的 97 个技能、7 个有效链接、实际目标及独立断链警告，授权按钮可见且没有横向溢出。该检查仅观察界面，没有新增授权或修改真实技能目录。

这项测试没有写入 Agent 文件，没有授权或启动厂商程序。它隔离的是控制台配置目录；打包模式下候选发现仍使用当前 Windows 用户的真实 home，因此可能只读检查已有候选文件。`packaged-dashboard.png` 仅供本机诊断，不应当成合成数据截图直接分享；交付演示应使用上一节的隔离夹具截图。文档不记录本机用户的私人绝对路径。

## 便携单文件测试

`tests/portable.cjs` 按 package.json 版本启动 `release/Agent-Memory-Console-0.1.2-win-x64.exe`，验证 NSIS 启动器自动解压并打开实际应用。测试使用独立的 `../../work/portable-profile-<时间戳>/` 配置目录，通过只绑定 `127.0.0.1` 的临时 CDP 测试端口连接界面，完成后关闭窗口与测试进程。正常双击启动不包含这些调试参数。

脚本检查六张 Agent 卡片、可调用的 preload 接口、配置目录隔离、渲染页面没有 `window.require`，以及集成页面导航。此脚本不授权或写入 Agent 文件，也不启动厂商程序；候选发现仍可能只读检查当前用户 home。`portable-integrations.png` 保存于 `test-results/`，仅作为本机成品验证记录。

本次传入 `release-0.1.2/Agent-Memory-Console-0.1.2-win-x64.exe`，全部检查通过，测试窗口已关闭。

便携测试单独使用 CDP，是因为 NSIS 外层启动器与直接 Electron 启动的调试输出转发不同。默认成品可直接运行 `node tests/portable.cjs`；使用本次版本目录时，应传入上文的 `release-0.1.2/` EXE 路径。

## 尚需人工验证

对外发布前，应在目标 Windows 机器上验证原生路径选择与默认取消行为、链接实际指向确认、真正的可信 EXE 启停、关闭时仍有子进程的提示和默认数据目录位置。解包版与便携单文件仍需按目标分发环境做兼容性检查。Claude 需使用用户自行安装和登录的版本验证单次任务及其权限失败行为；另外五个适配器需逐一确认当前厂商版本的路径与文件加载规则。

当前没有厂商账户凭据，也没有模拟余额、登录状态或会话成功结果。没有执行压力测试、完整系统重解析点矩阵、专业渗透测试或签名发布验证。
