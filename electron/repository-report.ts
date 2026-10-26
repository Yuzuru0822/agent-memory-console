import type { RepositoryPlan, RepositoryResolution } from "../src/repository-types";
import { pathKey } from "./repository-files";
import { within } from "./safety";
import type { Config } from "../src/shared";

export function assertRepositoryReportDestination(config: Config, destination: string): void {
  const agents = Object.values(config.agents);
  const access = [config.canonicalSkillsAccess, ...agents.map(agent => agent?.skillsAccess)];
  const managed = [config.repository?.root, config.canonicalMemory, config.canonicalSkills,
    ...Object.values(config.repository?.memoryFolders ?? {}), ...agents.flatMap(agent => [agent?.skills, agent?.memory]),
    ...access.flatMap(item => item ? [item.root, item.realRoot, ...item.links.map(link => link.target)] : [])]
    .filter((entry): entry is string => !!entry);
  if (managed.some(root => within(root, destination))) throw new Error("请将处理清单保存到纳管记忆、技能和仓库以外的位置");
}

/** Export only review metadata. Never include any version's file contents or manual merge text. */
export function repositoryReport(plan: RepositoryPlan, choices: unknown): string {
  if (!choices || typeof choices !== "object" || Array.isArray(choices)) throw new Error("同步选择参数无效");
  const files = new Map(plan.files.map(file => [file.key, file]));
  const resolutions = choices as Record<string, RepositoryResolution>;
  for (const [key, value] of Object.entries(resolutions)) {
    const file = files.get(key);
    if (!file?.conflict || !value || typeof value !== "object" || !["agent", "repository", "manual"].includes(value.choice)) throw new Error("同步选择参数无效");
    if (value.choice === "repository" && !file.repositoryExists) throw new Error("仓库版本不存在");
    if (value.choice === "agent") {
      const source = value.sourceKey === undefined ? file : files.get(value.sourceKey);
      if (!source?.localExists || source.key !== file.key && (source.kind !== "skills" || file.kind !== "skills" || pathKey(source.repositoryPath) !== pathKey(file.repositoryPath))) throw new Error("Agent 来源不属于同一共享文件");
    }
  }
  const timestamp = (value?: number) => value === undefined ? "" : new Date(value).toISOString();
  const rows: (string | number)[][] = [["预览ID", "有效期", "Agent", "类型", "相对路径", "Agent路径", "仓库路径", "Agent修改时间(UTC)", "仓库修改时间(UTC)", "当前处理", "采用来源Agent", "采用来源路径", "采用来源修改时间(UTC)", "默认建议", "推荐原因", "时间相同说明", "预览说明"]];
  for (const file of plan.files) {
    const choice = resolutions[file.key];
    const source = choice?.choice === "agent" ? files.get(choice.sourceKey ?? file.key) : undefined;
    const recommended = file.recommendation && files.get(file.recommendation.sourceKey);
    rows.push([plan.id, plan.expiresAt, file.agent, file.kind === "skills" ? "技能" : "记忆", file.relative, file.agentPath, file.repositoryPath,
      timestamp(file.localModifiedMs), timestamp(file.repositoryModifiedMs),
      !file.conflict ? "自动合并/单端补齐" : !choice ? "待处理" : choice.choice === "agent" ? "采用 Agent" : choice.choice === "repository" ? "采用仓库" : "手动合并",
      source?.agent ?? "", source?.agentPath ?? (choice?.choice === "repository" ? file.repositoryPath : ""),
      timestamp(source?.localModifiedMs ?? (choice?.choice === "repository" ? file.repositoryModifiedMs : undefined)),
      recommended ? `采用 ${recommended.agent}` : "", file.recommendation?.reason === "repository-missing" ? "仓库没有此文件" : file.recommendation?.reason === "agent-newer" ? "Agent 文件修改时间较新" : "",
      file.recommendation?.tied ? "最新时间相同且内容不同，按 Agent ID 和文件键排序选择" : "", file.description]);
  }
  const cell = (value: string | number) => {
    let text = String(value);
    if (/^[\s\x00-\x1f\uFEFF]*[=+\-@]/.test(text)) text = "'" + text;
    return `"${text.replace(/"/g, '""')}"`;
  };
  return "\uFEFF" + rows.map(row => row.map(cell).join(",")).join("\r\n") + "\r\n";
}
