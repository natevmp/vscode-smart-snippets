import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { evaluatePad } from "../../src/core/index.js";

describe("pad evaluator", () => {
  it("replaces prior generated text to reach the UTF-16 target", () => {
    const result = evaluatePad({
      lineText: "## title---suffix",
      generatedStart: 8,
      generatedEnd: 11,
      previousGeneratedText: "---",
      config: { fill: ".", targetWidth: 20 },
    });

    assert.deepEqual(result, {
      ok: true,
      replacement: "......",
      resultingLineLength: 20,
      overflow: false,
    });
  });

  it("counts UTF-16 code units rather than code points", () => {
    const result = evaluatePad({
      lineText: "🙂x",
      generatedStart: 3,
      generatedEnd: 3,
      previousGeneratedText: "",
      config: { fill: "-", targetWidth: 5 },
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.replacement, "--");
      assert.equal(result.resultingLineLength, 5);
    }
  });

  it("returns empty padding on overflow", () => {
    const result = evaluatePad({
      lineText: "already too long---",
      generatedStart: 16,
      generatedEnd: 19,
      previousGeneratedText: "---",
      config: { fill: "-", targetWidth: 5 },
    });
    assert.deepEqual(result, {
      ok: true,
      replacement: "",
      resultingLineLength: 16,
      overflow: true,
    });
  });

  it("fails without a replacement when generated text mismatches", () => {
    const result = evaluatePad({
      lineText: "prefix-user-edited",
      generatedStart: 7,
      generatedEnd: 11,
      previousGeneratedText: "----",
      config: { fill: "-", targetWidth: 20 },
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, "generated-text-mismatch");
      assert.equal("replacement" in result, false);
    }
  });

  it("rejects invalid ranges and configurations", () => {
    const invalidRange = evaluatePad({
      lineText: "abc",
      generatedStart: 1,
      generatedEnd: 4,
      previousGeneratedText: "bc",
      config: { fill: "-", targetWidth: 10 },
    });
    assert.equal(invalidRange.ok, false);
    if (!invalidRange.ok) {
      assert.equal(invalidRange.reason, "invalid-range");
    }

    const invalidConfig = evaluatePad({
      lineText: "abc",
      generatedStart: 3,
      generatedEnd: 3,
      previousGeneratedText: "",
      config: { fill: "\t", targetWidth: 10 },
    });
    assert.equal(invalidConfig.ok, false);
    if (!invalidConfig.ok) {
      assert.equal(invalidConfig.reason, "invalid-config");
    }
  });
});
