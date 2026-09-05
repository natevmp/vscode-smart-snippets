import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  getDriverSelectionTransitions,
  isPadInsertionSnapshot,
  matchSelectionRangesToDriverRanges,
} from "../../src/session/helpers.js";

const validSnapshot = {
  snippetName: "heading",
  sourceUri: "file:///snippets.jsonc",
  targetDocumentUri: "file:///target.jl",
  targetDocumentVersion: 4,
  driverTabstop: 1,
  fill: "-",
  targetWidth: 80,
};

describe("session helpers", () => {
  it("validates a complete plain insertion snapshot", () => {
    assert.equal(isPadInsertionSnapshot(validSnapshot), true);
    assert.equal(isPadInsertionSnapshot({ ...validSnapshot, fill: "🙂" }), false);
    assert.equal(isPadInsertionSnapshot({ ...validSnapshot, targetWidth: 0 }), false);
    assert.equal(isPadInsertionSnapshot({ ...validSnapshot, driverTabstop: 1.5 }), false);
    assert.equal(isPadInsertionSnapshot({ ...validSnapshot, sourceUri: "" }), false);
    assert.equal(isPadInsertionSnapshot({ ...validSnapshot, targetDocumentUri: "" }), false);
    assert.equal(isPadInsertionSnapshot({ ...validSnapshot, targetDocumentVersion: -1 }), false);
  });

  it("rejects arrays, class instances, and hostile snapshot accessors", () => {
    assert.equal(isPadInsertionSnapshot([validSnapshot]), false);
    assert.equal(isPadInsertionSnapshot(new (class Snapshot {
      public readonly snippetName = "heading";
      public readonly sourceUri = "file:///snippets.jsonc";
      public readonly targetDocumentUri = "file:///target.jl";
      public readonly targetDocumentVersion = 4;
      public readonly driverTabstop = 1;
      public readonly fill = "-";
      public readonly targetWidth = 80;
    })()), false);
    const hostile = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(hostile, "snippetName", { get: () => { throw new Error("nope"); } });
    assert.equal(isPadInsertionSnapshot(hostile), false);
    const accessorSnapshot = { ...validSnapshot } as Record<string, unknown>;
    Object.defineProperty(accessorSnapshot, "fill", { get: () => "-", enumerable: true });
    assert.equal(isPadInsertionSnapshot(accessorSnapshot), false);
  });

  it("matches selections to drivers by offsets rather than primary-selection order", () => {
    const matchedDriverIndex_did = matchSelectionRangesToDriverRanges(
      [{ start: 21, end: 21 }, { start: 3, end: 5 }],
      [{ start: 20, end: 25 }, { start: 2, end: 8 }],
    );
    assert.deepEqual(matchedDriverIndex_did, [1, 0]);
    assert.equal(matchSelectionRangesToDriverRanges(
      [{ start: 3, end: 9 }, { start: 21, end: 21 }],
      [{ start: 20, end: 25 }, { start: 2, end: 8 }],
    ), undefined);
    assert.equal(matchSelectionRangesToDriverRanges(
      [{ start: 3, end: 3 }],
      [{ start: 2, end: 8 }, { start: 20, end: 25 }],
    ), undefined);
  });

  it("detects pending exits and re-entry into driver ranges", () => {
    const transitions = getDriverSelectionTransitions(
      [{ start: 4, end: 4 }, { start: 30, end: 30 }],
      [{ start: 12, end: 12 }, { start: 22, end: 23 }],
      [{ start: 2, end: 8 }, { start: 20, end: 25 }, { start: 30, end: 30 }],
      [true, false, false],
    );
    assert.deepEqual(transitions, {
      enteredDriverIndex_did: [1],
      exitedPendingDriverIndex_did: [0],
    });
  });
});
