// The CommonJS entry is part of node-diff3's public exports. Its current package
// exposes types through exports, while this Electron project uses Node resolution.
const { diff3Merge } = require("node-diff3") as {
  diff3Merge<T>(a: T[], base: T[], b: T[], options: { excludeFalseConflicts: boolean }):
    Array<{ ok?: T[]; conflict?: unknown }>;
};

export type TextMerge = { text?: string; conflict: boolean };
const MAX_BYTES = 1024 * 1024;
const MAX_LINES = 20_000;
const MAX_COMPARISONS = 8_000_000;

/** Preserve line terminators and final-newline state; never insert conflict markers. */
export function mergeText(base: string | undefined, local: string, repository: string): TextMerge {
  if (local === repository) return { text: local, conflict: false };
  if (base === undefined) return { conflict: true };
  if (local === base) return { text: repository, conflict: false };
  if (repository === base) return { text: local, conflict: false };
  const values = [local, base, repository];
  if (values.some(value => value.includes("\0") || Buffer.byteLength(value, "utf8") > MAX_BYTES))
    return { conflict: true };
  const lines = values.map(value => value.match(/[^\n]*\n|[^\n]+$/g) || []);
  if (lines.some(value => value.length > MAX_LINES) ||
      lines[1].length * (lines[0].length + lines[2].length) > MAX_COMPARISONS)
    return { conflict: true };
  const blocks = diff3Merge(lines[0], lines[1], lines[2], { excludeFalseConflicts: true });
  if (blocks.some(block => block.conflict !== undefined)) return { conflict: true };
  const text = blocks.flatMap(block => block.ok || []).join("");
  if (Buffer.byteLength(text, "utf8") > MAX_BYTES) return { conflict: true };
  return { text, conflict: false };
}
