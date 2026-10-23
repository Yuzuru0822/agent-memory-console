# Agent Memory Console

用于 Windows 的本地 Agent 管理控制台，采用 Electron、React 和 TypeScript。深色界面提供六个 Agent 卡片、记忆指纹、技能目录检查、共享源同步、备份恢复和活动日志。

这是可运行的本地文件与进程管理工程。Claude Code CLI 按官方文档适配用户级记忆、技能路径及单次任务；WorkBuddy、TRAE、DeepSeek Harness、智谱 Zcode、千问 Work 使用候选路径或手动绑定，尚未验证厂商协议兼容性。界面不会把文件发现结果显示成登录、额度或会话状态。完整范围见 [集成说明](docs/INTEGRATIONS.md)。

私有源码仓库：[Yuzuru0822/agent-memory-console](https://github.com/Yuzuru0822/agent-memory-console)，需使用有访问权限的 GitHub 账户。

## 运行

便携单文件版可直接双击 `Agent-Memory-Console-0.1.0-win-x64.exe` 启动，无需安装 Node.js，也不需要另装 Electron。启动器会自动解压所需运行文件；本次交付文件为 128,406,095 字节，已通过实际启动测试。工程中的对应位置为 `release/Agent-Memory-Console-0.1.0-win-x64.exe`。

已取得解包版时，无需安装 Node.js：保留 `win-unpacked` 整个目录及其中所有资源，双击目录内的 `Agent Memory Console.exe`。不能只复制这一个 EXE，或直接在压缩包预览窗口内运行它。工程中的对应位置为 `release/win-unpacked/`，该解包成品已通过实际启动验证。

从源码运行或重新打包时，按以下步骤操作。

使用 Windows 10/11 x64、Node.js 24 和随附的 npm。先解压完整工程，在包含 `package.json` 的目录打开 PowerShell：

```powershell
npm ci
npm run dev
```

开发模式会编译 Electron 主进程，在 `127.0.0.1:5173` 启动界面并打开桌面窗口。不要只用浏览器打开开发地址；浏览器没有桌面文件和进程接口。修改 `electron/` 后需重新启动开发命令。

若 PowerShell 的脚本策略阻止 `npm.ps1`，使用同名命令 `npm.cmd`，例如 `npm.cmd ci`；无需修改系统执行策略。

生产模式运行：

```powershell
npm run build
npm start
```

`npm start` 使用已有构建结果，不会自动编译。首次安装需下载 npm 包及 Electron 运行时；打包还可能下载构建工具。项目 `.npmrc` 使用 npm 官方源，并将 npm 缓存设置为工程内的 `.cache/npm`，相对于本工程解析；`.cache/` 已加入 Git 忽略规则。请将工程解压到当前用户可写的位置。

## 第一次使用

1. 点击卡片的“查看检查与配置”。自动发现只检查内置候选位置，未发现时可以手动选择真实路径。
2. 对需要管理的记忆文件、技能目录点击“选择并授权”，并在系统对话框确认。记忆文件必须是已有的 UTF-8 `.md` 文件，技能目标必须是已有目录。空目标请先在资源管理器创建；选择候选路径也需明确授权。
3. 在“共享记忆源”选择一份作为来源的 Markdown；需要同步技能时，再选择“共享技能源”。共享源与目标技能目录不得相同或互相嵌套。
4. 勾选目标 Agent，点击“预览记忆同步”或“预览技能同步”。查看每个文件的当前内容、写入后内容以及跳过原因。
5. 点击“确认并执行”，核对第二次系统确认中的实际目标路径。现有目标会先备份，再逐文件写入并校验。预览五分钟后失效，来源、目标或授权配置变化也会阻止旧预览执行。
6. 在“备份快照”可手动备份，或对已有快照生成恢复预览。恢复仍需确认，且目标路径必须保持授权。恢复不会删除同步后新增的文件。

同步是从共享源向目标的单向文本复制；同名文件被替换，不做内容合并，也不会删除目标独有文件。技能仅复制允许的文本文件，不复制脚本、二进制或隐藏文件，因此不保证搬运后的技能可独立运行。

自动检查默认开启：空闲时每 30 秒读取一次，有所属进程运行时每 2 秒刷新。它不会自动同步、启动程序或删除文件。“路径完整”表示记忆与技能路径可读取，不表示 Agent 已安装完整、已登录或已经运行。

## 启动 Agent

在 Agent 详情中选择并授权本地 `.exe` 和运行工作目录，然后点击“启动程序”。其他五个适配器只提供通用 EXE 启动，不向厂商派发任务。

Claude Code 需要事先安装原生 Windows CLI，并自行完成登录。绑定 `claude.exe` 后填写单次任务；控制台用固定参数 `-p` 启动，将任务经标准输入传入，展示输出和退出码。它不会安装 Claude、代管密钥或绕过 Claude 的权限规则。任务可能联网、产生费用或修改工作目录中的文件；确认启动前请阅读任务内容。

不接受 `.cmd`、`.bat`、PowerShell 脚本、快捷方式或任意命令字符串。控制台只追踪自己启动的直接子进程。“停止所属进程”不会结束外部已运行程序或整个进程树；桌面程序启动器退出后，独立运行的应用状态可能未知。关闭控制台后也不能恢复此前的进程追踪。

## 检查与打包

```powershell
npm test
npm run build
node tests/process-smoke.cjs
npm run test:desktop
npm run pack
node tests/packaged.cjs
npm run dist
node tests/portable.cjs
```

| 命令 | 用途 |
| --- | --- |
| `npm test` | 执行本地服务和安全边界测试 |
| `npm run build` | 类型检查并构建界面、主进程和 preload |
| `node tests/process-smoke.cjs` | 使用无害 Node.exe 替身验证真实子进程启动、输出、退出和仅停止所属进程；不启动厂商 Agent |
| `npm run test:desktop` | 对构建后的 Electron 应用做桌面冒烟验证；需可用的图形桌面 |
| `npm run pack` | 构建 Windows x64 解包版，输出至 `release/win-unpacked/` |
| `node tests/packaged.cjs` | 启动上述解包成品并检查打包状态、沙箱、原生接口和页面切换；使用独立测试配置目录 |
| `npm run dist` | 构建便携 EXE，输出 `release/Agent-Memory-Console-0.1.0-win-x64.exe` |
| `node tests/portable.cjs` | 启动便携单文件成品并检查自动解压、隔离配置、原生接口和页面切换 |

打包后的应用携带 Electron，用户运行时不需要 Node.js。便携版不等于数据随 EXE 存放：数据仍写入 Windows 用户数据目录。此工程没有配置代码签名、自动更新或安装器；Windows 可能对未签名程序显示提示。项目测试不代表已完成六家厂商客户端的真实账户端到端测试。

依赖中 Electron 固定为 `45.0.0`；构建配置的 `electronDist` 指向 `node_modules/electron/dist`，直接使用安装好的 Electron 运行时。因此打包前须完成 `npm ci` 和 Electron 运行时下载，不能仅保留 Electron 的 JavaScript 包或缺失其 `dist` 目录。

已通过 34 项后端测试、完整构建、真实 Electron 桌面测试、解包成品和便携单文件成品启动测试；另通过 Node.exe 无害替身的真实子进程生命周期测试，不代表真实 Claude 集成已经验证。测试覆盖内容、隔离方式与当前验证状态见 [测试说明](docs/TESTING.md)。

## 本地数据

应用通过 Electron 的 `userData` 定位数据目录，在其下创建 `console-data/`；默认通常为 `%APPDATA%\Agent Memory Console\console-data`。以应用“备份快照”中的数据目录定位结果为准。

```text
console-data/
  config.json                 授权路径和共享源
  activity.jsonl              操作台账
  backups/<快照 ID>/
    manifest.json             原目标路径和内容校验值
    0.txt, 1.txt, ...          备份的原始文本字节
```

控制台没有云端同步或遥测实现。配置、日志、备份为本机明文；应按原始记忆文件的敏感程度保护。日志含路径和操作结果，不保存任务正文；CLI 输出仅保留在当前进程内存，最多 32,000 字符。第三方 Agent 自身的联网及日志行为由其自身决定。

## 常见问题

- **显示“未配置”**：内置发现只覆盖少量固定候选路径，不扫描注册表、全盘或 PATH。通过详情手动选择实际位置。
- **有文件但同步被跳过**：只读发现不授予写权限。请先选择并授权目标，随后重新预览。
- **提示链接或 junction**：使用实际本地目录。控制台不会沿符号链接或 junction 同步。
- **预览后文件发生变化**：重新刷新并生成预览，不要直接重复执行旧计划。
- **台账校验异常或超过 32 MiB**：同步写入、备份、启动和路径授权变更会被阻止。关闭应用，保留完整 `console-data` 备份并检查 `activity.jsonl`；需归档时将原台账完整移出数据目录后重启，新日志会形成新的链。不要将手工改写的旧日志当作完整审计记录。
- **源/目标很大或包含脚本**：查看 [安全限制](docs/SECURITY.md)。单文件上限 1 MiB，单次计划上限 200 个文件、16 MiB。

开发扩展请阅读 [架构说明](docs/ARCHITECTURE.md)；厂商能力与官方依据见 [集成说明](docs/INTEGRATIONS.md)；安全边界见 [安全说明](docs/SECURITY.md)。
