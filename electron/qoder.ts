import path from "node:path";
import { localPath } from "./safety";

/** Read-only IDE candidates. A PATH shim is never read or executed as a CLI. */
export function qoderExecutableCandidates(local: string, env: NodeJS.ProcessEnv): string[] {
  const candidates: string[] = [];
  const names = ["Qoder IDE.exe", "Qoder.exe"];
  const add = (directory: string, name: string) => {
    try {
      const candidate = localPath(path.join(localPath(directory), name));
      const key = process.platform === "win32" ? candidate.toLowerCase() : candidate;
      if (!candidates.some(value => (process.platform === "win32" ? value.toLowerCase() : value) === key))
        candidates.push(candidate);
    } catch { /* Ignore relative, network, device and invalid environment paths. */ }
  };
  for (const base of [local, env.ProgramFiles, env["ProgramFiles(x86)"]]) {
    if (!base) continue;
    try {
      const directory = localPath(base);
      const prefix = base === local ? path.join(directory, "Programs") : directory;
      add(path.join(prefix, "Qoder IDE"), "Qoder IDE.exe");
      add(path.join(prefix, "Qoder"), "Qoder.exe");
    } catch { /* Do not resolve invalid roots against the current directory. */ }
  }
  const value = env.PATH ?? env.Path ?? env.path ?? "";
  for (const item of value.split(path.delimiter, 128)) {
    const entry = item.startsWith('"') && item.endsWith('"') ? item.slice(1, -1) : item;
    try {
      const directory = localPath(entry);
      for (const name of names) add(directory, name);
      // The Windows IDE installs a shell launcher in <install>/bin. Find the
      // native desktop EXE beside that directory without interpreting the shim.
      if (path.basename(directory).toLowerCase() === "bin")
        for (const name of names) add(path.dirname(directory), name);
    } catch { /* A malformed PATH entry is not a discoverable installation. */ }
  }
  return candidates;
}
