import { deflateSync } from "node:zlib";
import type { Menu, MenuItemConstructorOptions, NativeImage } from "electron";

export interface TaskTrayCallbacks {
  show: () => void;
  togglePause: () => void;
  quit: () => void;
}

export type TaskTrayMenuItem = { type: "separator" } | { label: string; click: () => void };
export interface TaskTrayHandle {
  on(event: "click" | "double-click", callback: () => void): unknown;
  removeAllListeners(): unknown;
  setToolTip(text: string): void;
  setContextMenu(menu: unknown): void;
  isDestroyed(): boolean;
  destroy(): void;
}
/** A small transport boundary keeps Node fixture tests away from the user's tray. */
export interface TaskTrayRuntime {
  createImage(png: Buffer): { isEmpty(): boolean };
  createTray(image: unknown): TaskTrayHandle;
  buildMenu(template: TaskTrayMenuItem[]): unknown;
}

export function taskTrayMenu(paused: boolean, callbacks: TaskTrayCallbacks): TaskTrayMenuItem[] {
  return [
    { label: "打开控制台", click: callbacks.show },
    { type: "separator" },
    { label: paused ? "恢复自动任务" : "暂停全部自动任务", click: callbacks.togglePause },
    { type: "separator" },
    { label: "彻底退出", click: callbacks.quit },
  ];
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function pngChunk(kind: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(kind, "ascii"), data]);
  const size = Buffer.alloc(4), crc = Buffer.alloc(4);
  size.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([size, body, crc]);
}

/** Original 32 px RGBA layered icon, generated locally without image files or downloads. */
export function taskTrayIcon(): Buffer {
  const size = 32, scanlines = Buffer.alloc(size * (1 + size * 4));
  const segmentDistance = (x: number, y: number, ax: number, ay: number, bx: number, by: number) => {
    const t = Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2)));
    return Math.hypot(x - ax - t * (bx - ax), y - ay - t * (by - ay));
  };
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const total = [0, 0, 0, 0];
    for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) {
      const px = x + (sx + 0.5) / 4, py = y + (sy + 0.5) / 4;
      const dx = Math.max(9 - px, 0, px - 23), dy = Math.max(9 - py, 0, py - 23);
      if (dx * dx + dy * dy > 49) continue;
      let color = [121, 82, 163];
      if (Math.abs(px - 16) / 9 + Math.abs(py - 11.5) / 4.5 <= 1) color = [238, 224, 255];
      for (const top of [15.5, 20]) {
        if (Math.min(segmentDistance(px, py, 7, top, 16, top + 4.5), segmentDistance(px, py, 16, top + 4.5, 25, top)) <= 0.85)
          color = [238, 224, 255];
      }
      total[0] += color[0]; total[1] += color[1]; total[2] += color[2]; total[3]++;
    }
    const offset = y * (1 + size * 4) + 1 + x * 4;
    if (total[3]) {
      scanlines[offset] = Math.round(total[0] / total[3]);
      scanlines[offset + 1] = Math.round(total[1] / total[3]);
      scanlines[offset + 2] = Math.round(total[2] / total[3]);
      scanlines[offset + 3] = Math.round(total[3] * 255 / 16);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header), pngChunk("IDAT", deflateSync(scanlines)), pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function electronRuntime(): TaskTrayRuntime {
  // In plain Node, require('electron') is an executable path, not the Electron API.
  // Delay loading until enable(), which the host calls only after app.whenReady().
  const electron = require("electron") as typeof import("electron");
  if (!electron.Tray || !electron.Menu || !electron.nativeImage) throw new Error("当前运行环境不支持系统托盘");
  return {
    createImage: png => electron.nativeImage.createFromBuffer(png),
    createTray: image => {
      const tray = new electron.Tray(image as NativeImage);
      return {
        on: (event, callback) => event === "click" ? tray.on("click", callback) : tray.on("double-click", callback),
        removeAllListeners: () => tray.removeAllListeners(),
        setToolTip: text => tray.setToolTip(text),
        setContextMenu: menu => tray.setContextMenu(menu as Menu),
        isDestroyed: () => tray.isDestroyed(),
        destroy: () => tray.destroy(),
      };
    },
    buildMenu: template => electron.Menu.buildFromTemplate(template as MenuItemConstructorOptions[]),
  };
}

export class TaskTray {
  private tray?: TaskTrayHandle;
  private generation = 0;
  private paused?: boolean;

  constructor(private readonly callbacks: TaskTrayCallbacks, private runtime?: TaskTrayRuntime) {}

  get available(): boolean { return Boolean(this.tray && !this.tray.isDestroyed()); }

  enable(paused: boolean): void {
    if (this.available) { this.update(paused); return; }
    this.destroy();
    let candidate: TaskTrayHandle | undefined;
    try {
      this.runtime ??= electronRuntime();
      const icon = this.runtime.createImage(taskTrayIcon());
      if (icon.isEmpty()) throw new Error("托盘图标无法创建");
      candidate = this.runtime.createTray(icon);
      if (candidate.isDestroyed()) throw new Error("系统托盘不可用");
      const callbacks = this.guardedCallbacks(++this.generation);
      candidate.on("click", callbacks.show);
      candidate.on("double-click", callbacks.show);
      candidate.setToolTip(this.tooltip(paused));
      candidate.setContextMenu(this.runtime.buildMenu(taskTrayMenu(paused, callbacks)));
      this.tray = candidate;
      this.paused = paused;
    } catch (error) {
      this.generation++;
      this.dispose(candidate);
      throw new Error(`无法启用系统托盘：${error instanceof Error ? error.message : "未知错误"}`);
    }
  }

  update(paused: boolean): void {
    if (!this.available || this.paused === paused) return;
    try {
      this.tray!.setToolTip(this.tooltip(paused));
      this.tray!.setContextMenu(this.runtime!.buildMenu(taskTrayMenu(paused, this.guardedCallbacks(this.generation))));
      this.paused = paused;
    } catch (error) {
      this.destroy();
      throw new Error(`无法更新系统托盘：${error instanceof Error ? error.message : "未知错误"}`);
    }
  }

  destroy(): void {
    const previous = this.tray;
    this.tray = undefined;
    this.paused = undefined;
    this.generation++;
    this.dispose(previous);
  }

  private tooltip(paused: boolean): string {
    return `Agent Memory Console · ${paused ? "自动任务已暂停" : "自动任务按各自配置运行"}`;
  }

  private guardedCallbacks(generation: number): TaskTrayCallbacks {
    const invoke = (callback: () => void) => () => { if (generation === this.generation && this.available) callback(); };
    return { show: invoke(this.callbacks.show), togglePause: invoke(this.callbacks.togglePause), quit: invoke(this.callbacks.quit) };
  }

  private dispose(tray?: TaskTrayHandle): void {
    if (!tray) return;
    // Cleanup is best effort; clearing this.tray first always makes the host keep its window visible.
    try { tray.removeAllListeners(); } catch { /* Already disposed by the runtime. */ }
    try { if (!tray.isDestroyed()) tray.destroy(); } catch { /* Keep logical availability false. */ }
  }
}
