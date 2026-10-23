import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";
import { createAdapters } from "../electron/adapters";
import { ConsoleService } from "../electron/service";

export function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-console-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = (name: string, data: string | Buffer = "old content") => {
    const target = path.join(root, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data);
    return target;
  };
  const dir = (name: string) => {
    const target = path.join(root, name);
    fs.mkdirSync(target, { recursive: true });
    return target;
  };
  const service = new ConsoleService(
    path.join(root, "storage"),
    createAdapters(path.join(root, "home"), path.join(root, "local")),
    [path.join(root, "protected")],
  );
  return { root, file, dir, service };
}

// Format-check fixture only: never executed by any test.
export function peFixture() {
  const bytes = Buffer.alloc(128);
  bytes.write("MZ");
  bytes.writeUInt32LE(64, 60);
  bytes.write("PE\0\0", 64);
  bytes.writeUInt16LE(0x8664, 68);
  bytes.writeUInt16LE(0x0002, 86);
  bytes.writeUInt16LE(0x20b, 88);
  return bytes;
}
