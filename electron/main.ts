import { app, BrowserWindow, dialog, ipcMain, shell, session } from "electron";
import type { IpcMainInvokeEvent } from "electron";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import fs from "node:fs";
import { createAdapters } from "./adapters";
import { ConsoleService } from "./service";
import { Processes } from "./processes";
import { noLinks } from "./safety";
import type { AgentId, PickKind, PathKind } from "../src/shared";

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
  handler("snapshot", () => service.snapshot(processes.snapshot()), false);
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
    const chosen = await dialog.showOpenDialog(window, {
      title: `选择${k}（本地路径）`,
      properties: [folder ? "openDirectory" : "openFile"],
      filters: folder
        ? undefined
        : [
            {
              name: k === "executable" ? "Windows 程序" : "Markdown",
              extensions: [k === "executable" ? "exe" : "md"],
            },
          ],
    });
    if (chosen.canceled || !chosen.filePaths[0])
      return { message: "已取消选择" };
    const file = chosen.filePaths[0];
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
      .map((i) => `${i.before ? "替换" : "新增"} ${i.target}`)
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
    const { adapter, config } = processes.validate(agent, input);
    if (
      !(await confirm(
        `启动 ${adapter.name}`,
        `程序：${config.executable}\n目录：${config.workspace}\n\n${adapter.mode === "cli" ? "将向已安装的 Claude CLI 发送单次任务。可能产生费用、联网和文件修改，沿用 CLI 本身的权限规则。\n\n任务：" + input : "此第三方程序将以当前用户权限运行。程序退出启动器后，控制台无法追踪其独立子进程。"}`,
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
    noLinks(p);
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
        createAdapters(home, path.join(home, "AppData", "Local")),
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
      let closing = false;
      window.on("close", (event) => {
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
