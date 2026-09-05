import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  countConfiguredPrefixes,
  exceedsJsonNestingDepth,
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
});
