import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../src/standalone.js", import.meta.url), "utf8");

assert.doesNotMatch(
  source,
  /orderBy\("createdAt", "desc"\)\.limit\(/,
  "Firebase sales history must not be limited by count"
);
assert.match(
  source,
  /sales:\s*sales\.slice\(\)/,
  "Cloud sales snapshots must keep the full result set in memory"
);
assert.match(
  source,
  /sales:\s*mergeSaleHistories\(currentSales,/,
  "Legacy cached state must not replace a longer in-memory sales history"
);
assert.doesNotMatch(
  source,
  /sales:\s*\[sale\]\.concat\(current\.sales\)\.slice\(/,
  "Saving a sale must not discard older in-memory history"
);
assert.match(
  source,
  /MAX_CACHED_SALES\s*=\s*500/,
  "The bounded sales count is reserved for local and legacy caches"
);

console.log("history retention tests passed");
