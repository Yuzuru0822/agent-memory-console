const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

if (process.platform !== "win32") {
  console.log("RewardBridge: skipped on non-Windows; native rewards automation will be unavailable.");
  process.exit(0);
}
const systemRoot = process.env.SystemRoot;
if (!systemRoot || !/^[a-z]:[\\/]/i.test(systemRoot) || systemRoot.slice(2).includes(":")) throw new Error("A local SystemRoot is required to locate the Windows .NET Framework compiler.");
const framework = path.join(systemRoot, "Microsoft.NET", "Framework64", "v4.0.30319");
const compiler = path.join(framework, "csc.exe");
const references = ["System.dll", "System.Core.dll", "System.Web.Extensions.dll", "WPF/WindowsBase.dll", "WPF/UIAutomationClient.dll", "WPF/UIAutomationTypes.dll"].map(value => path.join(framework, value));
for (const file of [compiler, ...references]) if (!fs.statSync(file).isFile()) throw new Error(`Required Windows .NET Framework file is missing: ${file}`);
const root = path.resolve(__dirname, "..");
const source = path.join(root, "native", "RewardBridge.cs"), destination = path.join(root, "native", "bin", "RewardBridge.exe");
fs.mkdirSync(path.dirname(destination), { recursive: true });
const result = spawnSync(compiler, ["/nologo", "/target:exe", "/platform:x64", "/optimize+", "/warn:4", "/codepage:65001", "/utf8output", `/out:${destination}`, ...references.map(file => `/reference:${file}`), source], {
  cwd: root, shell: false, windowsHide: true, encoding: "utf8", timeout: 60000, maxBuffer: 1024 * 1024,
});
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status || 1);
console.log("RewardBridge: built native/bin/RewardBridge.exe (no desktop automation was run).");
