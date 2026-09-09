import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  countConfiguredPrefixes,
  exceedsJsonNestingDepth,
  MAX_SCOPE_IDS_PER_SOURCE,
  MAX_SCOPE_TEXT_LENGTH_PER_SOURCE,
  measureSourceScopeMetrics,
} from "../../src/config/limits.js";

describe("configuration resource limits", () => {
  it("bounds JSONC nesting while ignoring strings and comments", () => {
    assert.equal(exceedsJsonNestingDepth('{"literal":"[[[",/* {{{ */"value":[]}'), false);
    assert.equal(exceedsJsonNestingDepth("[[[0]]]", 2), true);
    assert.equal(exceedsJsonNestingDepth("[[0]]", 2), false);
  });

  it("counts scalar and array prefixes with an early limit", () => {
    assert.equal(countConfiguredPrefixes({
      One: { prefix: "one" },
      Many: { prefix: ["a", "b", "c"] },
      Invalid: null,
    }, 10), 4);
    assert.equal(countConfiguredPrefixes({
      Many: { prefix: ["a", "b", "c"] },
      Later: { prefix: ["d", "e"] },
    }, 2), 3);
  });

  it("measures source scope count boundaries before deduplication", () => {
    const fullSnippetCount = Math.floor(MAX_SCOPE_IDS_PER_SOURCE / 256);
    const remainder = MAX_SCOPE_IDS_PER_SOURCE % 256;
    const snippet_sid = Array.from({ length: fullSnippetCount }, () => ({
      scope: Array.from({ length: 256 }, () => "x"),
    }));
    snippet_sid.push({ scope: Array.from({ length: remainder }, () => "x") });

    const atLimit = measureSourceScopeMetrics(snippet_sid);
    assert.equal(atLimit.status, "ok");
    assert.equal(atLimit.scopeIdCount, MAX_SCOPE_IDS_PER_SOURCE);

    snippet_sid[snippet_sid.length - 1]?.scope.push("x");
    const overLimit = measureSourceScopeMetrics(snippet_sid);
    assert.equal(overLimit.status, "scopeIdLimitExceeded");
    assert.equal(overLimit.scopeIdCount, MAX_SCOPE_IDS_PER_SOURCE + 1);
  });

  it("measures source scope text boundaries in UTF-16 code units", () => {
    const snippet_sid = Array.from({ length: 64 }, () => ({ scope: "x".repeat(4_096) }));
    const atLimit = measureSourceScopeMetrics(snippet_sid);
    assert.deepEqual(atLimit, {
      status: "ok",
      scopeIdCount: 64,
      scopeTextLength: MAX_SCOPE_TEXT_LENGTH_PER_SOURCE,
    });

    const overLimit = measureSourceScopeMetrics([...snippet_sid, { scope: "x" }]);
    assert.equal(overLimit.status, "scopeTextLimitExceeded");
    assert.equal(overLimit.scopeTextLength, MAX_SCOPE_TEXT_LENGTH_PER_SOURCE + 1);
  });

  it("stops source scope measurement immediately after a limit is exceeded", () => {
    const unreachable = {
      get scope(): string {
        throw new Error("scope measurement did not stop");
      },
    };
    assert.doesNotThrow(() => measureSourceScopeMetrics(
      [{ scope: "a,b" }, unreachable],
      1,
      100,
    ));
    assert.equal(measureSourceScopeMetrics([{ scope: "a,b" }], 1, 100).status, "scopeIdLimitExceeded");
  });

  it("fails closed for malformed direct source scope arrays", () => {
    const malformed = measureSourceScopeMetrics([
      { scope: Array.from({ length: 257 }, () => "x") },
    ]);
    assert.equal(malformed.status, "invalid");
  });
});
