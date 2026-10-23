import test from "node:test";
import assert from "node:assert/strict";
import { mergeText } from "../electron/merge";

test("merge preserves identical text and one-sided changes exactly", () => {
  assert.deepEqual(mergeText(undefined, "same\r\n", "same\r\n"), { text: "same\r\n", conflict: false });
  assert.deepEqual(mergeText("old", "old", "new"), { text: "new", conflict: false });
  assert.deepEqual(mergeText("old", "new", "old"), { text: "new", conflict: false });
});

test("different initial documents require a choice without inventing a common ancestor", () => {
  assert.deepEqual(mergeText(undefined, "left", "right"), { conflict: true });
  assert.deepEqual(mergeText(undefined, "", "right"), { conflict: true });
});

test("independent edits on distant lines merge", () => {
  assert.deepEqual(mergeText("one\ntwo\nthree\nfour\n", "ONE\ntwo\nthree\nfour\n", "one\ntwo\nthree\nFOUR\n"),
    { text: "ONE\ntwo\nthree\nFOUR\n", conflict: false });
});

test("independent insertions merge with ordering and no duplicate unchanged lines", () => {
  assert.deepEqual(mergeText("a\nb\nc\nd\n", "start\na\nb\nc\nd\n", "a\nb\nc\nd\nend\n"),
    { text: "start\na\nb\nc\nd\nend\n", conflict: false });
});

test("a line deletion and a separate edit merge", () => {
  assert.deepEqual(mergeText("a\nb\nc\nd\ne\n", "a\nc\nd\ne\n", "a\nb\nc\nd\nE\n"),
    { text: "a\nc\nd\nE\n", conflict: false });
});

test("overlapping edits and same-location incompatible insertions remain conflicts", () => {
  for (const args of [["a\nb\nc\n", "a\nleft\nc\n", "a\nright\nc\n"],
    ["a\nb\n", "a\nx\nb\n", "a\ny\nb\n"], ["a\nb\nc\n", "a\nc\n", "a\nB\nc\n"]])
    assert.deepEqual(mergeText(args[0], args[1], args[2]), { conflict: true });
});

test("matching overlapping edits are not false conflicts", () => {
  assert.deepEqual(mergeText("a\nb\nc\nd\ne\n", "A\nb\nc\nd\nE\n", "A\nb\nc\nd\ne\n"),
    { text: "A\nb\nc\nd\nE\n", conflict: false });
});

test("CRLF, Unicode, blank lines and missing final newline survive merging", () => {
  assert.deepEqual(mergeText("甲\r\n\r\n乙\r\n丙", "甲一\r\n\r\n乙\r\n丙", "甲\r\n\r\n乙\r\n丙二"),
    { text: "甲一\r\n\r\n乙\r\n丙二", conflict: false });
});

test("cost and binary bounds produce a conflict instead of unsafe partial output", () => {
  assert.deepEqual(mergeText("a", "x".repeat(1024 * 1024 + 1), "b"), { conflict: true });
  assert.deepEqual(mergeText("a", "x\0", "b"), { conflict: true });
  const text = "unchanged\n".repeat(3000);
  assert.deepEqual(mergeText(text, "start\n" + text, text + "end\n"), { conflict: true });
});
