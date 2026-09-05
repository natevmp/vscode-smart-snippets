import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  isLanguageInScope,
  normalizePrefixes,
  normalizeScopes,
} from "../../src/config/helpers.js";

describe("configuration normalization", () => {
  it("normalizes scalar and duplicate prefixes without changing punctuation", () => {
    assert.deepEqual(normalizePrefixes("#h1"), ["#h1"]);
    assert.deepEqual(normalizePrefixes(["one", "one", "#two"]), ["one", "#two"]);
  });

  it("trims, splits, and deduplicates native-like scopes", () => {
    assert.deepEqual(
      normalizeScopes([" markdown, typescript ", "typescript", " julia, "]),
      ["markdown", "typescript", "julia"],
    );
    assert.deepEqual(normalizeScopes(undefined), []);
  });

  it("treats absent or empty scope as all languages", () => {
    assert.equal(isLanguageInScope("markdown", []), true);
    assert.equal(isLanguageInScope(" markdown ", ["markdown", "julia"]), true);
    assert.equal(isLanguageInScope("typescript", ["markdown", "julia"]), false);
  });
});
