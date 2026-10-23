import { contextBridge, ipcRenderer } from "electron";
import type { ConsoleApi } from "../src/shared";
const api: ConsoleApi = {
  snapshot: () => ipcRenderer.invoke("console:snapshot"),
  pick: (id, kind) => ipcRenderer.invoke("console:pick", id, kind),
  clear: (id, kind) => ipcRenderer.invoke("console:clear", id, kind),
  preview: (mode, ids) => ipcRenderer.invoke("console:preview", mode, ids),
  apply: (id) => ipcRenderer.invoke("console:apply", id),
  backup: (id) => ipcRenderer.invoke("console:backup", id),
  restore: (id) => ipcRenderer.invoke("console:restore", id),
  launch: (id, prompt) => ipcRenderer.invoke("console:launch", id, prompt),
  stop: (id) => ipcRenderer.invoke("console:stop", id),
  reveal: (id, kind) => ipcRenderer.invoke("console:reveal", id, kind),
};
contextBridge.exposeInMainWorld("consoleApi", Object.freeze(api));
