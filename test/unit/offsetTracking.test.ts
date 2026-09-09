import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  isOffsetTrackingWorkWithinLimit,
  prepareContentChanges,
  rebaseOffset,
  rebaseOffsetWithPreparedChanges,
  rebaseProtectedRange,
  rebaseProtectedRangeWithPreparedChanges,
  rebaseRange,
  rebaseRangeWithPreparedChanges,
  type ContentChange,
} from "../../src/core/index.js";

describe("offset tracking", () => {
  it("honors left and right affinity at an insertion boundary", () => {
    const change_cid: ContentChange[] = [{ rangeOffset: 5, rangeLength: 0, text: "abc" }];
    assert.equal(rebaseOffset(5, change_cid, "left"), 5);
    assert.equal(rebaseOffset(5, change_cid, "right"), 8);
    assert.equal(rebaseOffset(9, change_cid, "left"), 12);
  });

  it("maps offsets inside replacement according to affinity", () => {
    const change_cid: ContentChange[] = [{ rangeOffset: 3, rangeLength: 5, text: "xy" }];
    assert.equal(rebaseOffset(5, change_cid, "left"), 3);
    assert.equal(rebaseOffset(5, change_cid, "right"), 5);
    assert.equal(rebaseOffset(8, change_cid, "left"), 5);
  });

  it("handles unordered multiple changes based on pre-change offsets", () => {
    const change_cid: ContentChange[] = [
      { rangeOffset: 10, rangeLength: 2, text: "X" },
      { rangeOffset: 2, rangeLength: 1, text: "long" },
    ];
    assert.equal(rebaseOffset(15, change_cid, "right"), 17);
    assert.deepEqual(rebaseRange({ start: 6, end: 9 }, change_cid), { start: 9, end: 12 });
  });

  it("keeps boundary insertions outside a non-empty protected range", () => {
    const change_cid: ContentChange[] = [
      { rangeOffset: 5, rangeLength: 0, text: "before" },
      { rangeOffset: 8, rangeLength: 0, text: "after" },
    ];
    assert.deepEqual(rebaseProtectedRange({ start: 5, end: 8 }, change_cid), {
      valid: true,
      range: { start: 11, end: 14 },
    });
  });

  it("moves an empty generated range with preceding driver input", () => {
    const result = rebaseProtectedRange(
      { start: 5, end: 5 },
      [{ rangeOffset: 5, rangeLength: 0, text: "driver" }],
    );
    assert.deepEqual(result, { valid: true, range: { start: 11, end: 11 } });
  });

  it("invalidates insertions within and edits crossing a protected range", () => {
    const inside = rebaseProtectedRange(
      { start: 5, end: 10 },
      [{ rangeOffset: 7, rangeLength: 0, text: "!" }],
    );
    assert.equal(inside.valid, false);
    if (!inside.valid) {
      assert.equal(inside.reason, "protected-range-overlap");
      assert.equal(inside.changeIndex, 0);
    }

    const crossing = rebaseProtectedRange(
      { start: 5, end: 10 },
      [{ rangeOffset: 3, rangeLength: 10, text: "replacement" }],
    );
    assert.equal(crossing.valid, false);
    if (!crossing.valid) {
      assert.equal(crossing.reason, "protected-range-overlap");
    }
  });

  it("rejects overlapping pre-change edits safely", () => {
    const result = rebaseProtectedRange(
      { start: 20, end: 22 },
      [
        { rangeOffset: 2, rangeLength: 5, text: "x" },
        { rangeOffset: 4, rangeLength: 1, text: "y" },
      ],
    );
    assert.equal(result.valid, false);
    if (!result.valid) {
      assert.equal(result.reason, "invalid-change-set");
    }
  });

  it("reuses one prepared change set with the public offset and range semantics", () => {
    const laterChange = { rangeOffset: 10, rangeLength: 2, text: "X" };
    const change_cid: ContentChange[] = [
      laterChange,
      { rangeOffset: 2, rangeLength: 1, text: "long" },
    ];
    const prepared = prepareContentChanges(change_cid);
    laterChange.text = "mutated";

    assert.equal(rebaseOffsetWithPreparedChanges(15, prepared, "right"), 17);
    assert.deepEqual(
      rebaseRangeWithPreparedChanges({ start: 6, end: 9 }, prepared),
      { start: 9, end: 12 },
    );
    assert.deepEqual(
      rebaseProtectedRangeWithPreparedChanges({ start: 6, end: 9 }, prepared),
      { valid: true, range: { start: 9, end: 12 } },
    );
    assert.equal(isOffsetTrackingWorkWithinLimit(512, prepared), true);
    assert.equal(isOffsetTrackingWorkWithinLimit(600_000, prepared), false);
  });

  it("preserves original event indices in prepared protected-range failures", () => {
    const prepared = prepareContentChanges([
      { rangeOffset: 20, rangeLength: 0, text: "later" },
      { rangeOffset: 7, rangeLength: 0, text: "inside" },
    ]);
    const result = rebaseProtectedRangeWithPreparedChanges({ start: 5, end: 10 }, prepared);
    assert.equal(result.valid, false);
    if (!result.valid) {
      assert.equal(result.reason, "protected-range-overlap");
      assert.equal(result.changeIndex, 1);
    }
  });
});
