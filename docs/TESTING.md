# 测试与验证记录

本地服务测试、真实 Electron 窗口测试和厂商集成验证分别记录。测试中的记忆、技能、脚本和 PE 字节均为人工夹具，不来自真实 Agent，也不执行技能脚本。

## v0.2.0 当前状态

下表记录本轮已执行结果；待验证项目不能当作通过。厂商账户验证与应用本地功能验证分开。

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

历史参考：v0.1.2 的 88 项后端测试中 86 通过、2 项文件符号链接用例因 Windows `EPERM` 跳过；目录 junction 回归实际通过。该旧版桌面、解包及便携启动曾通过，不能作为 v0.2.0 本轮结果。npm Claude 2.1.243 曾仅执行 `--version`，没有验证登录、任务权限或计费调用。

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
npm run dist -- --config.directories.output=release-0.2.0
node tests/packaged.cjs "release-0.2.0/win-unpacked/Agent Memory Console.exe"
node tests/repository-packaged.cjs "release-0.2.0/win-unpacked/Agent Memory Console.exe"
node tests/portable.cjs "release-0.2.0/Agent-Memory-Console-0.2.0-win-x64.exe"
```

需要更快检查解包产物时使用 `npm run pack -- --config.directories.output=release-0.2.0`。默认打包目录仍为 `release/`，若旧版正在使用它，不要强行终止用户程序；改用版本目录。成品测试脚本首个参数接受自定义 EXE 路径。

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
| `junction-migration.test.ts` | 完整技能字节、脚本仅存储、同名冲突、断链/循环保留、入口身份变化、迁移失败回滚、解除连接保留仓库 |
| `repository-service.test.ts` | 多文件记忆分区、共同版本、双向预览/选择、无删除传播、自动化授权范围、备份与清理策略；具体断言和计数以测试输出为准 |
| `repository-shared.test.ts` | 多 Agent 共享技能的单端文字/二进制更新、独立修改汇总、真实冲突、统一版本选择、人工预览期间暂停自动任务 |

文件符号链接测试若因系统权限不足被跳过，应在顶部结果表记录跳过数及原因；不能将跳过计为通过。目录 junction 通常无需同样权限，需实际创建和验证。模拟 PE 字节只验证格式，不是可运行的程序。

## 桌面 UI 检查

`tests/desktop.cjs` 保留 v0.1.x 的流程覆盖：六张卡片、无 Renderer Node、上下文隔离/沙箱、共享源同步、授权取消与确认、实际链接映射、备份恢复、npm 入口授权及撤销、页面切换和窄窗口。

新增 `tests/repository-desktop.cjs` 启动真实 Electron，通过仅开发模式可用的 `CONSOLE_TEST_HOME` 与 `CONSOLE_TEST_DATA` 隔离到 `../../work/repository-desktop-<时间戳>/`，检查：

- 取消仓库初始化不创建 `.git` 或授权；确认后生成真实仓库、初始提交与工作区状态。
- 纳管成员持久化，但不会隐式创建 junction；记忆目录内多份文档保持相对路径。
- Agent 与仓库不同位置修改可三方合并；同处冲突禁用应用按钮，手动编辑后两端一致。
- 关闭预览使后端计划失效；多个 Agent 对同一技能二进制文件冲突时，可选择一个 Agent 版本用于全部引用方。
- 删除一端文件会从另一端补回，不将删除传播；完整技能脚本按字节保留且不执行。
- 技能同名冲突必须选择；导入后创建真实 junction，保留原目录；解除连接恢复原目录并保留仓库新增内容。
- 自动化启用及关闭、保留策略和手动清理；原生确认显示实际路径并默认取消。
- 1000 × 800 窗口无横向溢出，捕获到的 Renderer 脚本异常为零。

自动化运行与保留期限逻辑另由服务测试覆盖。桌面脚本替换系统文件选择器返回值和原生确认响应，不证明真实人工点击 Windows 文件对话框已完成验证。最终构建后执行全部 14 项场景通过，包含关闭预览使计划失效、多 Agent 二进制统一选择、缺失版本按钮禁用及刷新状态保留，Renderer 异常为零。截图在 `test-results/repository-conflict.png` 与 `repository-compact.png`，已逐张查看，深色布局与冲突编辑区正常，1000 像素窗口没有横向溢出。截图只包含人工夹具。

## 成品与进程检查

`process-smoke.cjs`、`npm-process-smoke.cjs` 使用无害 Node 替身检查真实进程生命周期，不调用真实 Claude 或模型。通用子进程测试验证仅停止本控制台持有的句柄；不会通过名称杀死其他程序。

`packaged.cjs` 用独立 `--user-data-dir` 启动解包 EXE，确认打包状态、版本、可见窗口、沙箱、受限接口、六张卡片和导航。`portable.cjs` 验证 NSIS 单文件解压后启动，使用仅绑定 `127.0.0.1` 的临时 CDP 端口连接并清理测试进程。正常双击不附带这些调试参数。

`repository-packaged.cjs` 在独立配置与空夹具目录中，通过实际成品初始化仓库、保存记忆和完整技能资产，重启后检查历史及提交内容；始终断言没有 Agent 路径或自动同步授权。

打包模式的候选发现仍可能只读检查当前 Windows 用户的默认 Agent 路径。成品脚本不会授权或写入这些目录；成品截图仅供本机诊断，不应作为合成示例公开分享。发布前应核对 ASAR 中当前编译产物，避免旧输出目录混用。

## 尚需人工与厂商验证

目标 Windows 环境仍需验证真正的文件选择器、UAC/文件权限条件、可信 EXE 启停、关闭时仍有子进程的提示、默认数据位置，以及运行中的客户端对 junction 切换和技能更新的反应。不要在客户端仍写入技能目录时迁移；本地并发改动会使预览失效或触发保留现场。

没有执行真实账户端到端调用、完整 Windows 重解析点矩阵、恶意同用户程序隔离、压力测试、专业渗透测试或签名分发验证。Git 版本与可见文件不证明厂商已加载技能。
