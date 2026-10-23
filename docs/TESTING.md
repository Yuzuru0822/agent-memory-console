# 测试与验证记录

本项目将本地服务测试、真实 Electron 窗口测试和厂商集成验证分开记录。测试文件中的示例记忆、技能和 PE 字节均为人工构造的数据，不来自用户的真实 Agent。

## 当前状态

截至 2026-10-23 本次记录：

| 检查 | 状态 | 说明 |
| --- | --- | --- |
| `npm test` | 已通过，34 项 | 隔离目录内的路径、文件、备份、台账和启动前校验 |
| `npm run build` | 已通过 | 类型检查、Electron 主进程与 preload 编译、React 界面生产构建 |
| `node tests/process-smoke.cjs` | 已通过 | 使用无害 Node.exe 替身真实启动，验证标准输入/输出、PID、运行状态、退出码、仅停止所属子进程和活动链 |
| `npm run test:desktop` | 已通过 | 真实 Electron 45.0.0；六个适配器、隔离与沙箱、预览取消、记忆/技能同步、备份恢复、非法参数、启动授权、页面切换和窄窗口布局 |
| `npm run pack` | 已完成 | 生成 Windows x64 `release/win-unpacked/` 解包成品 |
| `node tests/packaged.cjs` | 已通过 | 实际启动解包成品；确认 `isPackaged=true`、`sandbox=true`，通过 `--user-data-dir` 使用独立测试配置目录 |
| `npm run dist` | 已完成 | 生成 Windows x64 便携单文件 EXE，128,406,095 字节 |
| `node tests/portable.cjs` | 已通过 | NSIS 单文件自动解压启动、隔离配置、六张卡片、原生接口、渲染进程无 Node、页面切换及关闭 |
| 六家厂商真实客户端、真实账户 | 未验证 | 未测试账户登录、实际任务计费、真实会话协议或技能在厂商端加载 |
| 代码签名与外部分发验证 | 未配置 / 未验证 | 本工程不包含签名凭据或签名发布流程 |

这是已确认执行结果的记录，不是长期保证。源码或依赖变化后应重新运行相应检查，并更新此表。桌面与成品启动通过不证明厂商协议兼容，也不包含真实账户验证。

## 运行命令

在 Windows x64、Node.js 24 环境中，从工程根目录运行：

```powershell
npm ci
npm test
npm run build
node tests/process-smoke.cjs
npm run test:desktop
npm run pack
node tests/packaged.cjs
npm run dist
node tests/portable.cjs
```

桌面测试需要可用的图形桌面和完整 Electron 运行时，不能通过单纯浏览器预览替代。electron-builder 从 `node_modules/electron/dist` 取得已安装的 Electron 运行时。解包版使用 `tests/packaged.cjs`，便携单文件使用独立的 `tests/portable.cjs`。

## 后端测试覆盖

使用 Node 内置测试器，由 `tsx --test tests/*.test.ts` 执行。`tests/helpers.ts` 为每个测试在操作系统临时目录创建独立根目录，测试结束后清理；适配器的 home、local 与数据目录均指向这些夹具。测试不会读取实际用户的 `.claude` 等目录，也不会启动厂商客户端。

| 测试文件 | 当前覆盖 |
| --- | --- |
| `tests/safety.test.ts` | 拒绝相对路径、磁盘根、网络/设备路径与 Windows ADS；防止兄弟目录前缀误判和父目录逃逸；拒绝路径中及遍历时的 junction；拒绝 NUL、无效 UTF-8、超大文件和目录；允许文本及隐藏/生成文件过滤；技能文件数量上限；原子替换及重命名故障后的临时文件清理；PE 格式检查，拒绝改名脚本和 DLL |
| `tests/service.test.ts` | 发现不授予权限；记忆预览、备份、写入及恢复；源或目标修改后中止；全批次预检查；撤销授权和新预览使旧计划失效；计划只能执行一次；重复目标与嵌套技能源/目标拒绝；只复制文本并保留目标独有文件；预览后将目标目录替换为 junction 时拒绝；保护应用/数据目录；损坏快照和非法清单拒绝；恢复需当前授权；台账改写、删行、重排检测；台账损坏阻止写入及授权变更；多文件部分失败保留完整写前快照并可恢复；恢复保留后续新增文件 |
| `tests/processes.test.ts` | 必须明确授权 EXE 和工作目录；拒绝空白及超长 Claude 任务；授权后被替换的 EXE 在启动前再次检查；无法停止未归属于控制台的进程 |

`peFixture()` 只构造格式校验所需的字节，不是可运行的 Windows 程序，单元测试从不执行它。上述 34 项单元测试不覆盖真实进程启动；真实子进程生命周期由下述独立脚本验证。

## 真实子进程生命周期测试

构建主进程后运行 `node tests/process-smoke.cjs`。脚本在 Windows 上创建临时的隔离数据目录，将 `fs.realpathSync(process.execPath)` 得到的实际 Node.exe 绑定为无害测试程序，避免 Node 安装管理器的 junction 路径。它借助 Node 自身的 `-p` 与标准输入行为，测试控制台使用的固定参数和输入管道，不会执行真实 Claude。

本次通过了实际启动、非空 PID、标准输出中的 `helper-output` 与计算结果 `42`、退出码 `0`，以及运行状态变化。第二次启动一个等待中的所属子进程，验证只能停止该进程；另一个无关辅助进程保持运行，活动哈希链仍然完整。结束时清理本次辅助进程与经路径校验的临时目录。

这验证了本地进程管理实现，不验证 Claude 登录、模型调用、计费、权限交互或厂商进程树行为。测试通过不能升级为真实 Claude 或其他厂商集成已验证。

## Electron 桌面冒烟脚本

`tests/desktop.cjs` 使用 Playwright 的 Electron 驱动启动构建后的应用。它通过仅开发版本有效的 `CONSOLE_TEST_HOME` 和 `CONSOLE_TEST_DATA` 设置隔离的用户目录与数据目录，夹具保留在相对于工程的 `../../work/desktop-fixture-<时间戳>/`，便于失败后排查。

本次执行已通过以下检查：

- 六张 Agent 卡片与 preload API 出现，渲染页面没有 `window.require`；运行时确认沙箱、上下文隔离和 Node 集成设置。
- 记忆同步预览展示前后文本；取消确认不写入，确认后同步、备份及台账结果符合预期。
- 技能文本同步，以及从快照生成恢复计划并还原原始内容。
- 非法 Agent ID 被拒绝；未经授权的 EXE 不启动，详情中的启动按钮禁用。
- 页面切换、详情面板，以及 1000 × 800 窗口下无横向溢出；没有捕获到的页面脚本异常。

脚本把原生确认框替换为可控响应，以验证取消与确认两条分支。它不会实际操作系统文件选择器，因此不证明人工路径授权对话流程已经完成验证，也不会替用户启动真实 Agent。

运行截图保存到 `test-results/`：`sync-preview.png`、`agent-details.png`、`dashboard.png` 和 `dashboard-compact.png`。这些截图展示人工构造的测试夹具，不是实际账户数据。

## 解包成品测试

`tests/packaged.cjs` 实际启动 `release/win-unpacked/Agent Memory Console.exe`，通过 Chromium 的 `--user-data-dir` 参数将配置与日志隔离到相对于工程的 `../../work/packaged-profile-<时间戳>/`。测试检查了打包状态、沙箱、数据目录隔离、六个 Agent 卡片、渲染进程没有 `window.require`，以及集成页面与总览之间的切换。

这项测试没有写入 Agent 文件，没有授权或启动厂商程序。它隔离的是控制台配置目录；打包模式下候选发现仍使用当前 Windows 用户的真实 home，因此可能只读检查已有候选文件。`packaged-dashboard.png` 仅供本机诊断，不应当成合成数据截图直接分享；交付演示应使用上一节的隔离夹具截图。文档不记录本机用户的私人绝对路径。

## 便携单文件测试

`tests/portable.cjs` 启动 `release/Agent-Memory-Console-0.1.0-win-x64.exe`，验证 NSIS 启动器自动解压并打开实际应用。测试使用独立的 `../../work/portable-profile-<时间戳>/` 配置目录，通过只绑定 `127.0.0.1` 的临时 CDP 测试端口连接界面，完成后关闭窗口与测试进程。正常双击启动不包含这些调试参数。

本次已确认六张 Agent 卡片、可调用的 preload 接口、配置目录隔离、渲染页面没有 `window.require`，以及集成页面导航。此脚本不授权或写入 Agent 文件，也不启动厂商程序；候选发现仍可能只读检查当前用户 home。`portable-integrations.png` 保存于 `test-results/`，仅作为本机成品验证记录。

便携测试单独使用 CDP，是因为 NSIS 外层启动器与直接 Electron 启动的调试输出转发不同。复现时直接运行 `node tests/portable.cjs`，无需额外传递成品路径。

## 尚需人工验证

对外发布前，应在目标 Windows 机器上验证原生路径选择与默认取消行为、真正的可信 EXE 启停、关闭时仍有子进程的提示和默认数据目录位置。解包版与便携单文件均已在本机通过成品启动测试，仍需按目标分发环境做兼容性检查。Claude 需使用用户自行安装和登录的版本验证单次任务及其权限失败行为；另外五个适配器需逐一确认当前厂商版本的路径与文件加载规则。

当前没有厂商账户凭据，也没有模拟余额、登录状态或会话成功结果。没有执行压力测试、完整系统重解析点矩阵、专业渗透测试或签名发布验证。
