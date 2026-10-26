import type { RepositoryFile, RepositoryResolution } from "./repository-types";

export interface RepositoryReviewIndex {
  files: Map<string, RepositoryFile>;
  groups: Map<string, RepositoryFile[]>;
  groupKeys: Map<string, string>;
}

/** Shared skills must have one result, even when only one Agent row is selected. */
export function indexRepositoryReview(files: RepositoryFile[]): RepositoryReviewIndex {
  const index: RepositoryReviewIndex = { files: new Map(), groups: new Map(), groupKeys: new Map() };
  for (const file of files) {
    const groupKey = file.kind === "skills"
      ? `skills:${file.repositoryPath.replace(/\\/g, "/").toLowerCase()}`
      : `memory:${file.key}`;
    index.files.set(file.key, file);
    index.groupKeys.set(file.key, groupKey);
    const group = index.groups.get(groupKey) || [];
    group.push(file);
    index.groups.set(groupKey, group);
  }
  return index;
}

export function reviewGroup(index: RepositoryReviewIndex, key: string): RepositoryFile[] {
  return index.groups.get(index.groupKeys.get(key) || "") || [];
}

export function newestReviewAgent(group: RepositoryFile[]): RepositoryFile | undefined {
  return group.filter(file => file.localExists === true).sort((a, b) => {
    const time = (b.localModifiedMs ?? -Infinity) - (a.localModifiedMs ?? -Infinity);
    if (time && Number.isFinite(time)) return time;
    if (a.localModifiedMs === undefined && b.localModifiedMs !== undefined) return 1;
    if (b.localModifiedMs === undefined && a.localModifiedMs !== undefined) return -1;
    const left = `${a.agent}:${a.key}`;
    const right = `${b.agent}:${b.key}`;
    return left < right ? -1 : left > right ? 1 : 0;
  })[0];
}

function recommendationFor(group: RepositoryFile[]): RepositoryResolution | undefined {
  const recommendation = group.find(file => file.recommendation)?.recommendation;
  if (!recommendation || !group.some(file => file.key === recommendation.sourceKey && file.localExists === true)) return undefined;
  return { choice: "agent", sourceKey: recommendation.sourceKey };
}

export function recommendedReviewResolutions(index: RepositoryReviewIndex): Record<string, RepositoryResolution> {
  const result: Record<string, RepositoryResolution> = {};
  for (const group of index.groups.values()) {
    const resolution = recommendationFor(group);
    if (resolution) for (const file of group) if (file.conflict) result[file.key] = resolution;
  }
  return result;
}

function validResolution(group: RepositoryFile[], source: RepositoryFile, resolution: RepositoryResolution): boolean {
  if (resolution.choice === "agent") return group.some(file => file.key === (resolution.sourceKey || source.key) && file.localExists === true);
  if (resolution.choice === "repository") return group.every(file => file.repositoryExists === true);
  return group.every(file => !file.binary && !file.previewTruncated);
}

export function setReviewResolution(
  index: RepositoryReviewIndex,
  current: Record<string, RepositoryResolution>,
  key: string,
  resolution: RepositoryResolution,
): Record<string, RepositoryResolution> {
  const source = index.files.get(key);
  const group = reviewGroup(index, key);
  if (!source || !validResolution(group, source, resolution)) return current;
  const next = { ...current };
  const normalized = resolution.choice === "agent" ? { ...resolution, sourceKey: resolution.sourceKey || key } : resolution;
  for (const file of group) if (file.conflict) next[file.key] = normalized;
  return next;
}

export type ReviewBulkAction = "agent" | "repository" | "recommended" | "clear";

export function bulkReviewResolution(
  index: RepositoryReviewIndex,
  current: Record<string, RepositoryResolution>,
  keys: Iterable<string>,
  action: ReviewBulkAction,
): { resolutions: Record<string, RepositoryResolution>; changedGroups: number; skippedGroups: number } {
  const next = { ...current };
  const selected = new Set(Array.from(keys, key => index.groupKeys.get(key)).filter((key): key is string => !!key));
  let changedGroups = 0;
  let skippedGroups = 0;
  for (const groupKey of selected) {
    const group = index.groups.get(groupKey)!;
    if (!group.some(file => file.conflict)) continue;
    if (action === "clear") {
      for (const file of group) if (file.conflict) delete next[file.key];
      changedGroups++;
      continue;
    }
    const source = newestReviewAgent(group);
    const resolution: RepositoryResolution | undefined = action === "recommended" ? recommendationFor(group)
      : action === "agent" ? source && { choice: "agent", sourceKey: source.key }
      : { choice: "repository" };
    if (!resolution || !validResolution(group, group[0], resolution)) { skippedGroups++; continue; }
    for (const file of group) if (file.conflict) next[file.key] = resolution;
    changedGroups++;
  }
  return { resolutions: next, changedGroups, skippedGroups };
}
