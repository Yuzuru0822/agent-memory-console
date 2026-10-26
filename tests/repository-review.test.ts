import test from "node:test";
import assert from "node:assert/strict";
import type { RepositoryFile } from "../src/repository-types";
import { bulkReviewResolution, indexRepositoryReview, newestReviewAgent, recommendedReviewResolutions, setReviewResolution } from "../src/repository-review";

function file(agent: "claude" | "trae", relative = "demo/SKILL.md", extra: Partial<RepositoryFile> = {}): RepositoryFile {
  return { key: `${agent}:skills:${relative}`, agent, kind: "skills", relative,
    agentPath: `C:\\${agent}\\skills\\${relative}`, repositoryPath: `E:\\central\\skills\\${relative}`,
    localExists: true, repositoryExists: false, localModifiedMs: agent === "claude" ? 2000 : 1000,
    conflict: true, binary: false, description: "shared conflict", ...extra };
}

test("missing repository recommendations preselect one Agent across 660 shared conflicts", () => {
  const files: RepositoryFile[] = [];
  for (let i = 0; i < 330; i++) {
    const claude = file("claude", `skill-${i}/SKILL.md`), trae = file("trae", `skill-${i}/SKILL.md`);
    const recommendation = { sourceKey: claude.key, reason: "repository-missing" as const, tied: false };
    files.push({ ...trae, recommendation }, { ...claude, recommendation });
  }
  const index = indexRepositoryReview(files);
  const choices = recommendedReviewResolutions(index);
  assert.equal(Object.keys(choices).length, 660);
  assert.equal(index.groups.size, 330);
  for (const group of index.groups.values()) {
    assert.deepEqual(choices[group[0].key], choices[group[1].key]);
    assert.equal(choices[group[0].key].sourceKey, group.find(f => f.agent === "claude")?.key);
  }
});

test("bulk selection includes hidden shared references and picks the latest existing Agent", () => {
  const claude = file("claude"), trae = file("trae"), index = indexRepositoryReview([trae, claude]);
  const result = bulkReviewResolution(index, {}, [trae.key], "agent");
  assert.equal(result.changedGroups, 1);
  assert.equal(result.skippedGroups, 0);
  assert.deepEqual(result.resolutions[trae.key], { choice: "agent", sourceKey: claude.key });
  assert.deepEqual(result.resolutions[claude.key], result.resolutions[trae.key]);
});

test("equal timestamps choose stable Agent identifiers independently of display order", () => {
  const claude = file("claude", undefined, { localModifiedMs: 1000 }), trae = file("trae");
  assert.equal(newestReviewAgent([trae, claude])?.key, claude.key);
  assert.equal(newestReviewAgent([claude, trae])?.key, claude.key);
  assert.equal(newestReviewAgent([{ ...claude, localExists: false }, trae])?.key, trae.key);
});

test("batch repository choice skips absent versions without clearing previous choices", () => {
  const absent = file("claude"), present = file("claude", "available/SKILL.md", { repositoryExists: true });
  const index = indexRepositoryReview([absent, present]);
  const initial = { [absent.key]: { choice: "agent" as const, sourceKey: absent.key } };
  const result = bulkReviewResolution(index, initial, [absent.key, present.key], "repository");
  assert.equal(result.changedGroups, 1);
  assert.equal(result.skippedGroups, 1);
  assert.deepEqual(result.resolutions[absent.key], initial[absent.key]);
  assert.equal(result.resolutions[present.key].choice, "repository");
});

test("restore recommendation and clear apply once per shared destination", () => {
  const claude = file("claude"), trae = file("trae");
  const recommendation = { sourceKey: claude.key, reason: "agent-newer" as const, tied: false };
  const index = indexRepositoryReview([{ ...claude, recommendation }, { ...trae, recommendation }]);
  const result = bulkReviewResolution(index, {}, [claude.key, trae.key], "recommended");
  assert.equal(result.changedGroups, 1);
  assert.equal(Object.keys(result.resolutions).length, 2);
  const cleared = bulkReviewResolution(index, result.resolutions, [trae.key], "clear");
  assert.deepEqual(cleared.resolutions, {});
  assert.equal(cleared.changedGroups, 1);
});

test("single row Agent and manual choices keep all shared rows consistent", () => {
  const claude = file("claude"), trae = file("trae");
  const index = indexRepositoryReview([claude, { ...trae, repositoryPath: trae.repositoryPath.toUpperCase().replace(/\\/g, "/") }]);
  const choices = setReviewResolution(index, {}, trae.key, { choice: "agent" });
  assert.deepEqual(choices[claude.key], { choice: "agent", sourceKey: trae.key });
  const manual = setReviewResolution(index, choices, claude.key, { choice: "manual", text: "chosen merged contents" });
  assert.deepEqual(manual[claude.key], manual[trae.key]);
  assert.equal(manual[trae.key].text, "chosen merged contents");
});

test("no bulk or single-row path invents missing content or changes ordinary merge results", () => {
  const missing = file("claude", "missing/SKILL.md", { localExists: false });
  const merged = file("trae", "merged/SKILL.md", { conflict: false });
  const index = indexRepositoryReview([missing, merged]);
  assert.deepEqual(setReviewResolution(index, {}, missing.key, { choice: "agent" }), {});
  assert.deepEqual(setReviewResolution(index, {}, missing.key, { choice: "repository" }), {});
  const result = bulkReviewResolution(index, {}, [missing.key, merged.key], "agent");
  assert.equal(result.skippedGroups, 1);
  assert.equal(result.changedGroups, 0);
  assert.deepEqual(result.resolutions, {});
});

test("manual merge rejects an entire shared group when another reference cannot be safely edited", () => {
  const claude = file("claude"), trae = file("trae", undefined, { previewTruncated: true });
  const index = indexRepositoryReview([claude, trae]);
  assert.deepEqual(setReviewResolution(index, {}, claude.key, { choice: "manual", text: "incomplete" }), {});
});

test("Agent memory files remain independent even with the same relative filename", () => {
  const claude = file("claude", "MEMORY.md", { kind: "memory" }), trae = file("trae", "MEMORY.md", { kind: "memory" });
  const index = indexRepositoryReview([claude, trae]);
  const choices = setReviewResolution(index, {}, claude.key, { choice: "agent" });
  assert.equal(index.groups.size, 2);
  assert.deepEqual(Object.keys(choices), [claude.key]);
});
