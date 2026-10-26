import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { assertRepositoryReportDestination, repositoryReport } from "../electron/repository-report";
import type { RepositoryFile, RepositoryPlan } from "../src/repository-types";
import type { Config } from "../src/shared";

const file = (key: string, overrides: Partial<RepositoryFile> = {}): RepositoryFile => ({
  key, agent: "claude", kind: "skills", relative: "example/SKILL.md",
  agentPath: path.resolve("fixture", key, "example/SKILL.md"), repositoryPath: path.resolve("fixture/repository/skills/example/SKILL.md"),
  localExists: true, repositoryExists: false, localModifiedMs: 1000000, localText: "PRIVATE_AGENT_CONTENT",
  repositoryText: "PRIVATE_REPOSITORY_CONTENT", baseText: "PRIVATE_BASE", mergedText: "PRIVATE_MERGED",
  binary: false, conflict: true, description: "多个 Agent 提供不同版本", ...overrides,
});
const plan = (files: RepositoryFile[]): RepositoryPlan => ({id:"fixture-plan", expiresAt:"2026-10-26T00:00:00.000Z", warnings:[], files});

test("sync report includes recommendations and current shared source without content", () => {
  const files = [file("older", {agent:"workbuddy", recommendation:{sourceKey:"newer",reason:"repository-missing",tied:true}}),
    file("newer", {recommendation:{sourceKey:"newer",reason:"repository-missing",tied:true}, localModifiedMs:2000000})];
  const csv = repositoryReport(plan(files), {older:{choice:"agent",sourceKey:"newer"}, newer:{choice:"agent",sourceKey:"newer"}});
  assert.ok(csv.startsWith("\uFEFF"));
  assert.match(csv, /仓库没有此文件/);
  assert.match(csv, /最新时间相同且内容不同/);
  assert.match(csv, /1970-01-01T00:33:20.000Z/);
  assert.equal(csv.split("\r\n").length, 4);
  assert.equal(csv.includes("PRIVATE_"), false);
});

test("sync report includes unresolved, manual and non-conflicting outcomes", () => {
  const csv = repositoryReport(plan([file("pending"), file("manual"), file("merged", {conflict:false}),
    file("repository", {repositoryExists:true, repositoryModifiedMs:3000000})]),
    {manual:{choice:"manual",text:"PRIVATE_MANUAL"},repository:{choice:"repository"}});
  assert.match(csv, /待处理/); assert.match(csv, /手动合并/); assert.match(csv, /自动合并\/单端补齐/); assert.match(csv, /采用仓库/);
  assert.equal(csv.includes("PRIVATE_"), false);
});

test("sync report escapes formula paths, commas, quotes and line breaks", () => {
  const csv = repositoryReport(plan([file("escaped", {relative:'\t=HYPERLINK("fixture"),\nnext'})]), {});
  assert.ok(csv.includes('"\'\t=HYPERLINK(""fixture""),\nnext"'));
});

test("sync report rejects nonexistent versions, foreign source keys and invalid choices", () => {
  const view = plan([file("one"),file("other",{repositoryPath:path.resolve("fixture/other.md")}),file("missing",{localExists:false})]);
  for (const choices of [null, [], {unknown:{choice:"agent"}}, {one:{choice:"invalid"}},
    {one:{choice:"repository"}}, {missing:{choice:"agent"}}, {one:{choice:"agent",sourceKey:"other"}}, {one:{choice:"agent",sourceKey:"missing-key"}}]) {
    assert.throws(() => repositoryReport(view, choices));
  }
});

test("sync report cannot be saved inside a managed junction target or shared source", () => {
  const root = path.resolve("report-fixture");
  const inside = (relative: string) => path.join(root, relative);
  const config: Config = {
    version:1,
    agents:{claude:{skills:inside("logical"), skillsAccess:{
      root:inside("logical"), realRoot:inside("real"),
      links:[{path:inside("logical/nested"),target:inside("external"),kind:"directory"}],
    }}},
    canonicalSkills:inside("canonical"),
    canonicalSkillsAccess:{root:inside("canonical"),realRoot:inside("source-real"),links:[]},
  };
  for (const location of ["logical", "real", "external", "canonical", "source-real"]) {
    assert.throws(() => assertRepositoryReportDestination(config, inside(`${location}/report.csv`)), /纳管/);
  }
  assert.doesNotThrow(() => assertRepositoryReportDestination(config, inside("reports/report.csv")));
});
