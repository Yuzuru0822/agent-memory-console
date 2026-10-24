import { app, BrowserWindow, dialog, ipcMain, shell, session } from "electron";
import type { IpcMainInvokeEvent } from "electron";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import fs from "node:fs";
import { createAdapters } from "./adapters";
import { ConsoleService } from "./service";
import { Processes } from "./processes";
import { RepositoryService } from "./repository-service";
import { RewardsService } from "./rewards-service";
import { WindowsRewardsBridge } from "./rewards-windows";
import type { RewardId } from "../src/rewards-types";
import type { RepositoryAutomation, RepositoryResolution } from "../src/repository-types";
import { noLinks } from "./safety";
import type { AgentId, PickKind, PathKind, SkillAccess } from "../src/shared";
import { resolveSkillPath } from "./skill-paths";
import type { ClaudeNpmInstallation } from "./claude-npm";

app.setName("Agent Memory Console");
const testData = !app.isPackaged ? process.env.CONSOLE_TEST_DATA : undefined;
if (testData) app.setPath("userData", path.resolve(testData));
const dev = !app.isPackaged && process.env.CONSOLE_DEV === "1";
const productionFile = path.join(__dirname, "../../dist/index.html");
const expectedUrl = dev
  ? "http://127.0.0.1:5173/"
  : pathToFileURL(productionFile).href;
let window: BrowserWindow;
let service: ConsoleService;
let processes: Processes;
let repository: RepositoryService;
let rewards: RewardsService;
let busy = false;
const validId = (value: unknown): AgentId => {
  if (typeof value !== "string") throw new Error("Agent 参数无效");
  service.adapter(value as AgentId);
  return value as AgentId;
};
const str = (value: unknown) => {
  if (typeof value !== "string" || value.length > 20000)
    throw new Error("参数无效");
  return value;
};
const confirm = async (message: string, detail: string) => {
  const result = await dialog.showMessageBox(window, {
    type: "warning",
    title: "确认本地操作",
    message,
    detail,
    buttons: ["取消", "确认执行"],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  });
  return result.response === 1;
};
const npmDescription = (npm: ClaudeNpmInstallation) =>
  `npm 包：@anthropic-ai/claude-code ${npm.packageVersion}\n安装入口：${npm.launcher}\n实际程序：${npm.entry}${npm.node ? "\nNode.js：" + npm.node : ""}\n\n将直接启动以上程序，不执行 CMD 脚本。请确认安装来源可信；包名与格式检查不验证厂商签名。`;
const skillsDescription = (access: SkillAccess, source: boolean) =>
  `技能目录：${access.root}\n实际根目录：${access.realRoot}\n\n${access.links.length ? access.links.map(l=>`${l.path}\n  → ${l.target}`).join("\n") : "未发现链接"}\n\n${source ? "这些实际位置将作为共享只读源。" : "同步将写入这些实际位置并保留链接。其他使用这些链接的 Agent 也会看到修改。"}每次同步仍需预览和确认；链接目标改变后须重新授权。`;
function trusted(event: IpcMainInvokeEvent) {
  if (
    event.sender !== window.webContents ||
    event.senderFrame !== window.webContents.mainFrame ||
    event.senderFrame?.url.split("#")[0] !== expectedUrl
  )
    throw new Error("拒绝非受信页面的调用");
}
function handler(
  channel: string,
  fn: (...args: any[]) => unknown,
  mutation = true,
) {
  ipcMain.handle(`console:${channel}`, async (event, ...args) => {
    trusted(event);
    if (mutation && busy) throw new Error("另一项操作尚未完成");
    if (mutation) busy = true;
    try {
      return await fn(...args);
    } finally {
      if (mutation) busy = false;
    }
  });
}
function register() {
  const rewardId = (value: unknown): RewardId => rewards.definition(value).id;
  handler("rewardsSnapshot", () => rewards.snapshot(), false);
  handler("rewardsBind", async (value: unknown) => {
    const id = rewardId(value), definition = rewards.definition(id);
    if (definition.kind !== "ui") throw new Error("此平台没有已支持的免费领取流程");
    const chosen = await dialog.showOpenDialog(window, { title: `选择 ${definition.name} 的领取客户端 EXE`, properties: ["openFile"], filters: [{name:"Windows 程序", extensions:["exe"]}] });
    if (chosen.canceled || !chosen.filePaths[0]) return {message:"已取消绑定"};
    const executable = chosen.filePaths[0];
    if (!(await confirm("绑定积分领取客户端", `${definition.name}\n${executable}\n\n将核验并绑定此程序。后续只操作该 EXE 的唯一已打开窗口，不读取登录凭据。客户端升级后需重新绑定。Qoder 每日奖励必须选择新桌面客户端，不能选择 Qoder IDE。`))) return {message:"未绑定客户端"};
    rewards.bind(id, executable); return {message:"已绑定客户端，请打开并登录后校准活动流程"};
  });
  handler("rewardsInspect", (id: unknown) => rewards.inspect(rewardId(id)));
  handler("rewardsRecord", async (id: unknown, token: unknown, index: number, kind: "navigate"|"claim") => {
    await rewards.record(rewardId(id), str(token), index, kind); return {message:kind === "navigate" ? "已记录并打开导航，请重新检查窗口" : "已记录领取按钮，尚未执行领取"};
  });
  handler("rewardsChecks", (id: unknown, token: unknown, indices: number[], successTexts: string[], resetHour: number) => {
    rewards.checks(rewardId(id), str(token), indices, successTexts, resetHour); return {message:"活动识别条件已保存，请试领验证"};
  });
  handler("rewardsReset", (id: unknown) => { rewards.reset(rewardId(id)); return {message:"流程已清空，自动领取已关闭；未修改客户端"}; });
  handler("rewardsRun", async (value: unknown) => {
    const id = rewardId(value), provider = rewards.snapshot().providers.find(p => p.id === id)!;
    if (!(await confirm("试领当前免费活动", `${provider.name}\n${provider.profile?.executable || "尚未绑定"}\n\n将依次打开已记录的导航，并点击一次已记录的免费领取按钮。仅平台明确显示成功才计为领取。若上次结果未知，请先在客户端核对；不会购买、邀请、发送任务或使用重置卡。`))) return {message:"已取消试领"};
    return rewards.run(id);
  });
  handler("rewardsAutomation", async (value: unknown, enabled: boolean) => {
    const id = rewardId(value), provider = rewards.snapshot().providers.find(p => p.id === id)!;
    if (typeof enabled !== "boolean") throw new Error("自动领取参数无效");
    if (enabled && !(await confirm("启用自动领取", `${provider.name}\n${provider.profile?.executable || "尚未绑定"}\n北京时间 ${provider.profile?.resetHour ?? provider.resetHour}:00 起的新窗口，每窗口最多记录一次成功。\n\n仅控制台与已登录客户端均打开、桌面解锁时执行；客户端需要停留在已校准流程能识别的页面。账号切换或活动变化后请重新校准。未知结果会暂停，不会反复提交。`))) return {message:"自动领取设置未更改"};
    rewards.automation(id, enabled); return {message:enabled ? "自动领取已启用" : "自动领取已关闭"};
  });
  handler("rewardsRule", async (value: unknown) => { await shell.openExternal(rewards.definition(rewardId(value)).sourceUrl); return {message:"已打开官方规则"}; });
  handler("repositorySnapshot", () => repository.snapshot(), false);
  handler("repositoryChoose", async () => {
    const chosen = await dialog.showOpenDialog(window, { title: "选择独立的记忆与技能 Git 仓库目录", properties: ["openDirectory", "createDirectory"] });
    const selected = chosen.filePaths[0];
    if (chosen.canceled || !selected) return { message: "已取消选择仓库" };
    if (!(await confirm("创建或打开本地 Git 仓库", `${selected}\n\n请使用独立的空目录，或本控制台已创建的仓库。仓库会包含 memories/<Agent>/ 和共享 skills/，并保留本地 Git 历史。现有 Agent 内容不会在此步骤移动；后续同步和 junction 连接都有单独预览。不会上传或推送远程。`))) return { message: "已取消创建仓库" };
    await repository.choose(selected); return { message: "本地 Git 仓库已就绪" };
  });
  handler("repositoryReveal", async () => {
    const root = service.config.repository?.root;
    if (!root) throw new Error("请先选择仓库"); noLinks(root);
    const error = await shell.openPath(root); if (error) throw new Error(error);
    return { message: "已打开仓库目录" };
  });
  handler("repositoryMembers", (ids: unknown) => {
    if (!Array.isArray(ids)) throw new Error("Agent 参数无效"); repository.members(ids.map(validId));
    return { message: "纳管 Agent 已保存；变更范围后需重新启用自动同步" };
  });
  handler("repositoryMemoryFolder", async (id: unknown) => {
    const agent = validId(id);
    const chosen = await dialog.showOpenDialog(window,{title:`选择 ${service.adapter(agent).name} 记忆目录`,properties:["openDirectory"]});
    if (chosen.canceled || !chosen.filePaths[0]) return { message: "已取消记忆目录选择" };
    const selected = chosen.filePaths[0];
    if (!(await confirm("授权多文件记忆目录", `${selected}\n\n该目录中的 Markdown、文本、JSON 和 YAML 会与仓库 memories/${agent}/ 双向同步。双方同时修改时进行三方合并，冲突需要人工解决，不传播删除。请勿选择整个用户目录或含凭据的配置目录。`))) return { message: "未授权记忆目录" };
    repository.memoryFolder(agent,selected); return { message: "记忆目录已保存；自动同步已暂停，待重新启用" };
  });
  handler("repositoryPreview", () => repository.preview());
  handler("repositoryCancelPreview", () => { repository.cancelPreview(); return {message:"预览已关闭，自动任务可继续运行"}; });
  handler("repositoryApply", async (id: unknown, choices: Record<string,RepositoryResolution>) => {
    const plan = repository.review(str(id));
    const paths = plan.files.slice(0,40).map(f=>`${f.agentPath}\n  ↔ ${f.repositoryPath}`).join("\n");
    if (!(await confirm("执行仓库双向合并", `${plan.files.length} 项合并结果\n${paths}${plan.files.length>40?"\n其余路径见预览列表":""}\n\n写入前保存 Git 版本和原内容快照。不会传播删除，也不会执行技能脚本。`))) return {message:"已取消仓库同步"};
    const count = await repository.apply(plan.id,choices); return {message:`仓库同步完成：${count} 个文件，已保存 Git 版本`};
  });
  handler("repositoryCommit", async () => ({message:await repository.commit()}));
  handler("repositoryAutomation", async (options: RepositoryAutomation) => {
    if (!options || typeof options !== "object") throw new Error("自动任务参数无效");
    const c = service.config.repository;
    if (!c) throw new Error("请先选择仓库");
    if ((options.enabled || options.cleanupEnabled) && !(await confirm("启用本地自动任务", `仓库：${c.root}\n纳管 Agent：${c.agentIds.join(", ")}\n自动同步：${options.enabled ? `每 ${options.intervalSeconds} 秒` : "关闭"}\n自动清理：${options.cleanupEnabled ? `保留最近 ${options.retentionDays} 天，至少 ${options.minBackups} 份备份` : "关闭"}\n\n仅在控制台打开时运行。此授权允许上述路径后续自动写入；冲突或授权改变会暂停同步，不传播删除。清理仅涉及本程序完成的过期快照，不删除 Agent 原目录、仓库内容或 Git 历史。`))) return {message:"自动任务设置未更改"};
    repository.automation(options); return {message:"自动任务设置已保存"};
  });
  handler("repositoryCleanup", async () => {
    if (!(await confirm("清理过期仓库快照", "按当前保留天数与最少份数清理本程序完成的旧快照。未完成快照、原 Agent 目录、记忆、技能和 Git 历史均保留。"))) return {message:"已取消清理"};
    return {message:`已清理 ${repository.cleanup()} 份过期快照`};
  });
  handler("repositoryLinkPreview", (id: unknown) => repository.linkPreview(validId(id)));
  handler("repositoryLinkApply", async (id: unknown, choices: Record<string,"agent"|"repository">) => {
    const plan=repository.linkReview(str(id));
    if (!(await confirm("将 Agent 技能目录连接到仓库", `Agent 入口：${plan.source}\n实际仓库：${plan.target}\n原目录保留在：${plan.backupPath}\n\n将按预览结果汇入完整技能文件，保留脚本与资源但不执行，然后创建 Windows junction。所有已连接 Agent 会立即看到共享技能的修改和直接删除；同步器本身不传播删除。原目录保留，之后可解除连接恢复。${plan.warnings.length?"\n\n注意："+plan.warnings.join("\n"):""}`))) return {message:"已取消技能连接"};
    return {message:await repository.linkApply(plan.id,choices)};
  });
  handler("repositoryUnlink", async (id: unknown) => {
    const agent=validId(id), receipt=repository.unlinkReview(agent);
    if (!(await confirm("解除连接并恢复原技能目录", `入口：${receipt.source}\n保留的原目录：${receipt.backupPath}\n\n只移除指向当前仓库的 junction，并还原原目录名称。仓库及其中新内容会保留；连接之后在仓库内新增的内容不会复制到原目录。`))) return {message:"已取消解除连接"};
    await repository.unlink(agent); return {message:"已恢复原技能目录，仓库内容保留"};
  });
  handler("snapshot", () => service.snapshot(processes.snapshot()), false);
  handler("approveSkillLinks", async (id: unknown) => {
    const agent = id === null ? null : validId(id);
    const selected = agent === null ? service.config.canonicalSkills : service.paths(agent).skills;
    if (!selected) throw new Error("请先选择技能目录");
    const access = service.prepareSkills(selected);
    if (!(await confirm("授权技能链接与实际位置", skillsDescription(access, agent === null)))) return { message: "未授权技能链接" };
    service.bindSkills(agent, access);
    return { message: `已授权技能目录与 ${access.links.length} 个链接映射` };
  });
  handler("approveNpm", async () => {
    const npm = service.npmCandidate();
    if (!npm) throw new Error("未发现可用 npm 安装，请手动选择 claude.cmd");
    if (!(await confirm("授权检测到的 npm 安装", npmDescription(npm)))) return { message: "未授权 npm 安装" };
    service.bindNpm(npm);
    return { message: `已授权 Claude Code npm ${npm.packageVersion}；请选择工作目录后运行任务` };
  });
  handler("pick", async (id: unknown, kind: unknown) => {
    const kinds: PickKind[] = [
      "memory",
      "skills",
      "executable",
      "workspace",
      "canonicalMemory",
      "canonicalSkills",
    ];
    if (!kinds.includes(kind as PickKind)) throw new Error("路径类型无效");
    const k = kind as PickKind;
    const agent = id === null ? null : validId(id);
    if (k.startsWith("canonical") !== (agent === null))
      throw new Error("路径参数无效");
    const folder = ["skills", "workspace", "canonicalSkills"].includes(k);
    const npmAllowed = agent === "claude" && k === "executable";
    const chosen = await dialog.showOpenDialog(window, {
      title: `选择${k}（本地路径）`,
      properties: [folder ? "openDirectory" : "openFile"],
      defaultPath: npmAllowed ? service.npmCandidate()?.launcher : undefined,
      filters: folder
        ? undefined
        : [
            {
              name: npmAllowed ? "Claude 程序 / npm claude.cmd" : k === "executable" ? "Windows 程序" : "Markdown",
              extensions: npmAllowed ? ["exe", "cmd"] : [k === "executable" ? "exe" : "md"],
            },
          ],
    });
    if (chosen.canceled || !chosen.filePaths[0])
      return { message: "已取消选择" };
    const file = chosen.filePaths[0];
    if (k === "skills" || k === "canonicalSkills") {
      const access = service.prepareSkills(file);
      if (!(await confirm("授权技能目录与实际位置", skillsDescription(access, k === "canonicalSkills")))) return { message: "未授权技能目录" };
      service.bindSkills(agent, access);
      return { message: `已授权技能目录与 ${access.links.length} 个链接映射` };
    }
    if (npmAllowed && path.extname(file).toLowerCase() === ".cmd") {
      const npm = service.resolveNpm(file);
      if (!(await confirm("授权 npm 安装", npmDescription(npm)))) return { message: "未授权 npm 安装" };
      service.bindNpm(npm);
      return { message: `已授权 Claude Code npm ${npm.packageVersion}` };
    }
    if (
      !(await confirm(
        "授权此路径",
        `${file}\n\n${k === "executable" ? "此程序以后可由控制台启动。请确认其来源可信；控制台不验证厂商签名。" : k.startsWith("canonical") ? "此路径将作为共享只读源。同步时仍需预览与确认。" : "此路径将保存到本机。记忆与技能目标可在预览确认后被备份或写入。"}`,
      ))
    )
      return { message: "未授权路径" };
    service.bind(agent, k, file);
    return { message: "路径已保存" };
  });
  handler("clear", (id: unknown, kind: unknown) => {
    if (!["memory", "skills", "executable", "workspace"].includes(String(kind)))
      throw new Error("路径类型无效");
    service.clear(validId(id), kind as PathKind);
    return { message: "已撤销授权；候选路径仍会只读发现" };
  });
  handler("preview", (mode: unknown, ids: unknown) => {
    if (!Array.isArray(ids) || !["memory", "skills"].includes(String(mode)))
      throw new Error("同步参数无效");
    return service.preview(mode as "memory" | "skills", ids.map(validId));
  });
  handler("apply", async (id: unknown) => {
    const planId = str(id),
      plan = service.review(planId);
    if (!plan.items.length) return { message: "文件已一致，无需写入" };
    const details = plan.items
      .map((i) => `${i.before ? "替换" : "新增"} ${i.target}${i.targetLogical && i.targetLogical !== i.target ? "\n  技能路径：" + i.targetLogical : ""}`)
      .join("\n");
    if (
      !(await confirm(
        `将写入 ${plan.items.length} 个文件`,
        `${details}\n\n现有目标会先备份。此操作按文件执行；中途失败时，已完成的文件可通过快照恢复。`,
      ))
    )
      return { message: "已取消，未写入文件" };
    const count = service.apply(planId);
    return { message: `已写入并校验 ${count} 个文件` };
  });
  handler("backup", (id: unknown) => ({
    message: `已备份 ${service.backup(validId(id))} 个文件`,
  }));
  handler("restore", (id: unknown) => service.restore(str(id)));
  handler("launch", async (id: unknown, prompt: unknown) => {
    const agent = validId(id);
    const input = prompt === undefined ? undefined : str(prompt);
    const { adapter, config, executable } = processes.validate(agent, input);
    if (
      !(await confirm(
        `启动 ${adapter.name}`,
        `程序：${executable}${config.claudeNpm?.kind === "node" ? "\nCLI 入口：" + config.claudeNpm.entry : ""}\n目录：${config.workspace}\n\n${adapter.mode === "cli" ? "将向已安装的 Claude CLI 发送单次任务。可能产生费用、联网和文件修改，沿用 CLI 本身的权限规则。\n\n任务：" + input : "此第三方程序将以当前用户权限运行。程序退出启动器后，控制台无法追踪其独立子进程。"}`,
      ))
    )
      return { message: "已取消启动" };
    processes.launch(agent, input);
    return { message: "已发起启动；可在详情查看进程结果" };
  });
  handler("stop", async (id: unknown) => {
    const agent = validId(id);
    if (
      !(await confirm(
        "停止此控制台启动的进程",
        "Windows 上停止可能中断未保存的工作。只结束直接子进程，不终止进程树或其他已打开的程序。",
      ))
    )
      return { message: "已取消停止" };
    processes.stop(agent);
    return { message: "停止请求已发送" };
  });
  handler("reveal", (id: unknown, kind: unknown) => {
    if (!["memory", "skills", "storage"].includes(String(kind)))
      throw new Error("路径类型无效");
    let p: string | undefined;
    if (kind === "storage") p = service.storage;
    else if (id === null)
      p =
        kind === "memory"
          ? service.config.canonicalMemory
          : service.config.canonicalSkills;
    else {
      const paths = service.paths(validId(id));
      p = kind === "memory" ? paths.memory : paths.skills;
    }
    if (!p || !fs.existsSync(p)) throw new Error("路径不存在");
    if (kind === "skills") p = resolveSkillPath(p).real;
    else noLinks(p);
    shell.showItemInFolder(p);
    return { message: "已在资源管理器定位" };
  });
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => {
    window?.show();
    window?.focus();
  });
  app
    .whenReady()
    .then(() => {
      const home =
        !app.isPackaged && process.env.CONSOLE_TEST_HOME
          ? path.resolve(process.env.CONSOLE_TEST_HOME)
          : os.homedir();
      service = new ConsoleService(
        path.join(app.getPath("userData"), "console-data"),
        createAdapters(home, path.join(home, "AppData", "Local"), !app.isPackaged && process.env.CONSOLE_TEST_HOME ? {} : process.env),
        [
          app.getAppPath(),
          path.dirname(process.execPath),
          process.resourcesPath,
          process.env.SystemRoot,
          process.env.ProgramFiles,
          process.env["ProgramFiles(x86)"],
        ].filter((s): s is string => !!s),
      );
      processes = new Processes(service);
      repository = new RepositoryService(service);
      rewards = new RewardsService(service, new WindowsRewardsBridge(app.isPackaged
        ? path.join(process.resourcesPath, "rewards", "RewardBridge.exe")
        : path.join(app.getAppPath(), "native", "bin", "RewardBridge.exe")));
      session.defaultSession.setPermissionRequestHandler(
        (_wc, _permission, callback) => callback(false),
      );
      session.defaultSession.setPermissionCheckHandler(() => false);
      window = new BrowserWindow({
        width: 1460,
        height: 1000,
        minWidth: 980,
        minHeight: 700,
        backgroundColor: "#16141d",
        title: "Agent Memory Console",
        autoHideMenuBar: true,
        webPreferences: {
          preload: path.join(__dirname, "preload.js"),
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          webSecurity: true,
          webviewTag: false,
        },
      });
      window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      window.webContents.on("will-navigate", (event, url) => {
        if (url !== expectedUrl) event.preventDefault();
      });
      window.webContents.on("will-attach-webview", (event) =>
        event.preventDefault(),
      );
      register();
      const repositoryTimer = setInterval(() => {
        if (busy || !window || window.isDestroyed()) return;
        busy = true;
        void repository.tick().catch(error => console.error("Repository automatic task failed:", String(error)))
          .then(() => rewards.tick()).catch(error => console.error("Rewards automatic task failed:", String(error))).finally(() => { busy = false; });
      }, 5000);
      app.once("before-quit", () => clearInterval(repositoryTimer));
      let closing = false;
      window.on("close", (event) => {
        if (busy) {
          event.preventDefault();
          void dialog.showMessageBox(window, {type:"info",message:"本地操作尚未完成",detail:"请等待当前同步、备份、积分领取或 Git 保存完成后再关闭控制台。",buttons:["返回控制台"],defaultId:0,noLink:true});
          return;
        }
        if (closing || !processes.active().length) return;
        event.preventDefault();
        void dialog
          .showMessageBox(window, {
            type: "warning",
            message: "仍有控制台启动的进程",
            detail:
              "关闭控制台将失去进程追踪；第三方进程可能继续运行。可以取消后逐个停止。",
            buttons: ["返回控制台", "关闭并放弃追踪"],
            defaultId: 0,
            cancelId: 0,
          })
          .then((r) => {
            if (r.response === 1) {
              closing = true;
              window.close();
            }
          });
      });
      if (dev) void window.loadURL(expectedUrl);
      else void window.loadFile(productionFile);
    })
    .catch((error) => {
      dialog.showErrorBox("控制台启动失败", String(error));
      app.quit();
    });
  app.on("window-all-closed", () => app.quit());
}
