import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { inflateSync } from "node:zlib";
import { TaskTray, taskTrayIcon, taskTrayMenu, type TaskTrayHandle, type TaskTrayMenuItem, type TaskTrayRuntime } from "../electron/task-tray";

class FixtureTray extends EventEmitter implements TaskTrayHandle {
  destroyed = false;
  destroyedCount = 0;
  tooltip = "";
  menu: TaskTrayMenuItem[] = [];
  menuFailure = false;
  setToolTip(value: string) { this.tooltip = value; }
  setContextMenu(value: unknown) {
    if (this.menuFailure) throw new Error("menu unavailable");
    this.menu = value as TaskTrayMenuItem[];
  }
  isDestroyed() { return this.destroyed; }
  destroy() { this.destroyedCount++; this.destroyed = true; }
}

function fixture() {
  const calls: string[] = [], handles: FixtureTray[] = [];
  const callbacks = { show: () => { calls.push("show"); }, togglePause: () => { calls.push("toggle"); }, quit: () => { calls.push("quit"); } };
  const runtime: TaskTrayRuntime = {
    createImage: png => { assert.equal(png.subarray(1, 4).toString(), "PNG"); return { isEmpty: () => false }; },
    createTray: () => { const tray = new FixtureTray(); handles.push(tray); return tray; },
    buildMenu: template => template,
  };
  return { calls, handles, callbacks, runtime, tray: new TaskTray(callbacks, runtime) };
}

function item(menu: TaskTrayMenuItem[], label: string) {
  const found = menu.find(value => "label" in value && value.label === label);
  assert.ok(found && "click" in found, `Missing menu item: ${label}`);
  return found;
}

test("tray menu exposes only the three host actions and describes the current pause state", () => {
  const f = fixture(), running = taskTrayMenu(false, f.callbacks), paused = taskTrayMenu(true, f.callbacks);
  assert.deepEqual(running.map(value => "label" in value ? value.label : value.type), ["打开控制台", "separator", "暂停全部自动任务", "separator", "彻底退出"]);
  item(running, "打开控制台").click();
  item(running, "暂停全部自动任务").click();
  item(paused, "恢复自动任务").click();
  item(paused, "彻底退出").click();
  assert.deepEqual(f.calls, ["show", "toggle", "toggle", "quit"]);
});

test("tray construction and pre-enable update do not load Electron or create native resources", () => {
  const tray = new TaskTray({ show() {}, togglePause() {}, quit() {} });
  assert.equal(tray.available, false);
  tray.update(false);
  tray.destroy();
  assert.equal(tray.available, false);
});

test("enable installs one fixture tray, click and double click open the host, and update changes the menu", () => {
  const f = fixture();
  f.tray.enable(false);
  assert.equal(f.tray.available, true);
  const handle = f.handles[0];
  handle.emit("click"); handle.emit("double-click");
  item(handle.menu, "暂停全部自动任务").click();
  item(handle.menu, "彻底退出").click();
  assert.deepEqual(f.calls, ["show", "show", "toggle", "quit"]);
  assert.match(handle.tooltip, /各自配置运行/);
  f.tray.enable(true);
  assert.equal(f.handles.length, 1);
  assert.match(handle.tooltip, /已暂停/);
  item(handle.menu, "恢复自动任务").click();
  assert.equal(f.calls.at(-1), "toggle");
  f.tray.destroy();
});

test("destroy is idempotent and invalidates retained event and menu callbacks even after re-enable", () => {
  const f = fixture(); f.tray.enable(false);
  const handle = f.handles[0], oldMenu = handle.menu, oldClick = handle.listeners("click")[0] as () => void;
  f.tray.destroy(); f.tray.destroy();
  assert.equal(f.tray.available, false);
  assert.equal(handle.destroyedCount, 1);
  assert.equal(handle.listenerCount("click"), 0);
  oldClick(); item(oldMenu, "彻底退出").click();
  f.tray.enable(true);
  oldClick(); item(oldMenu, "暂停全部自动任务").click();
  assert.deepEqual(f.calls, []);
  f.handles[1].emit("click");
  assert.deepEqual(f.calls, ["show"]);
  f.tray.destroy();
});

test("unchanged periodic updates preserve the open native menu until pause state changes", () => {
  const f = fixture();
  let builds = 0;
  f.runtime.buildMenu = template => { builds++; return template; };
  f.tray.enable(false);
  const originalMenu = f.handles[0].menu;
  for (let tick = 0; tick < 12; tick++) f.tray.update(false);
  assert.equal(builds, 1);
  assert.equal(f.handles[0].menu, originalMenu);
  f.tray.update(true);
  assert.equal(builds, 2);
  assert.notEqual(f.handles[0].menu, originalMenu);
  for (let tick = 0; tick < 12; tick++) f.tray.update(true);
  assert.equal(builds, 2);
  f.tray.update(false);
  assert.equal(builds, 3);
  f.tray.destroy();
});

test("empty icons and failed native creation throw and leave no available tray", () => {
  const f = fixture();
  f.runtime.createImage = () => ({ isEmpty: () => true });
  assert.throws(() => f.tray.enable(false), /无法启用系统托盘.*图标/);
  assert.equal(f.tray.available, false);
  assert.equal(f.handles.length, 0);
  f.runtime.createImage = () => ({ isEmpty: () => false });
  f.runtime.createTray = () => { throw new Error("native unavailable"); };
  assert.throws(() => f.tray.enable(false), /无法启用系统托盘.*native unavailable/);
  assert.equal(f.tray.available, false);
});

test("menu setup failure disposes the partial tray and invalidates its callbacks", () => {
  const f = fixture();
  f.runtime.buildMenu = () => { throw new Error("menu unavailable"); };
  assert.throws(() => f.tray.enable(false), /无法启用系统托盘.*menu unavailable/);
  assert.equal(f.tray.available, false);
  assert.equal(f.handles[0].destroyedCount, 1);
  assert.equal(f.handles[0].listenerCount("click"), 0);
  assert.deepEqual(f.calls, []);
});

test("update failure removes the unusable tray instead of leaving stale pause controls", () => {
  const f = fixture(); f.tray.enable(false);
  const handle = f.handles[0], oldMenu = handle.menu;
  handle.menuFailure = true;
  assert.throws(() => f.tray.update(true), /无法更新系统托盘.*menu unavailable/);
  assert.equal(f.tray.available, false);
  assert.equal(handle.destroyedCount, 1);
  item(oldMenu, "彻底退出").click();
  assert.deepEqual(f.calls, []);
  f.tray.destroy();
  assert.equal(handle.destroyedCount, 1);
});

test("externally destroyed tray is unavailable and can be replaced without stale callbacks", () => {
  const f = fixture(); f.tray.enable(false);
  const old = f.handles[0], oldMenu = old.menu;
  old.destroy();
  assert.equal(f.tray.available, false);
  f.tray.update(true);
  f.tray.enable(true);
  assert.equal(f.handles.length, 2);
  assert.equal(old.destroyedCount, 1);
  item(oldMenu, "打开控制台").click();
  assert.deepEqual(f.calls, []);
  assert.equal(f.tray.available, true);
  f.tray.destroy();
});

test("self-contained tray icon is a valid 32 px RGBA PNG with transparent corners and visible layers", () => {
  const png = taskTrayIcon();
  assert.deepEqual(png.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const chunks: { type: string; data: Buffer }[] = [];
  const crcTable = Array.from({ length: 256 }, (_, index) => {
    let value = index;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
    return value >>> 0;
  });
  let offset = 8;
  while (offset < png.length) {
    const length = png.readUInt32BE(offset), body = png.subarray(offset + 4, offset + 8 + length);
    const crc = body.reduce((value, byte) => crcTable[(value ^ byte) & 0xff] ^ (value >>> 8), 0xffffffff);
    assert.equal(png.readUInt32BE(offset + 8 + length), (crc ^ 0xffffffff) >>> 0);
    chunks.push({ type: body.subarray(0, 4).toString("ascii"), data: body.subarray(4) });
    offset += 12 + length;
  }
  assert.equal(offset, png.length);
  assert.deepEqual(chunks.map(chunk => chunk.type), ["IHDR", "IDAT", "IEND"]);
  assert.equal(chunks[0].data.readUInt32BE(0), 32);
  assert.equal(chunks[0].data.readUInt32BE(4), 32);
  assert.deepEqual([...chunks[0].data.subarray(8)], [8, 6, 0, 0, 0]);
  const pixels = inflateSync(chunks[1].data);
  assert.equal(pixels.length, 32 * 129);
  for (let y = 0; y < 32; y++) assert.equal(pixels[y * 129], 0);
  const pixel = (x: number, y: number) => [...pixels.subarray(y * 129 + 1 + x * 4, y * 129 + 5 + x * 4)];
  assert.equal(pixel(0, 0)[3], 0);
  assert.equal(pixel(31, 31)[3], 0);
  assert.deepEqual(pixel(16, 11), [238, 224, 255, 255]);
  assert.deepEqual(pixel(16, 27), [121, 82, 163, 255]);
});
