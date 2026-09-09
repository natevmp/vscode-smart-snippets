import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { indexDuplicatePrefixConflicts } from "../../src/config/conflicts.js";

describe("config registry duplicate-prefix indexing", () => {
  it("finds global and shared-language conflicts but ignores disjoint scopes", () => {
    const result = indexDuplicatePrefixConflicts([
      { name: "Julia", prefix_pid: ["shared"], scope_lid: ["julia"] },
      { name: "Markdown", prefix_pid: ["shared"], scope_lid: ["markdown"] },
      { name: "Both", prefix_pid: ["shared"], scope_lid: ["typescript", "julia"] },
      { name: "Global", prefix_pid: ["shared"], scope_lid: [] },
      { name: "After global", prefix_pid: ["shared"], scope_lid: ["python"] },
    ]);

    assert.deepEqual(result, {
      status: "ok",
      conflict_cid: [
        { snippetIndex: 2, prefix: "shared", conflictingSnippetName: "Julia" },
        { snippetIndex: 3, prefix: "shared", conflictingSnippetName: "Julia" },
        { snippetIndex: 4, prefix: "shared", conflictingSnippetName: "Global" },
      ],
      omittedCount: 0,
      workUnits: 12,
    });
  });

  it("reports at most one conflict for each later snippet and prefix", () => {
    const result = indexDuplicatePrefixConflicts([
      { name: "First", prefix_pid: ["same"], scope_lid: ["julia", "markdown"] },
      { name: "Second", prefix_pid: ["same"], scope_lid: ["julia"] },
      { name: "Third", prefix_pid: ["same", "other"], scope_lid: ["julia", "markdown"] },
      { name: "Fourth", prefix_pid: ["other"], scope_lid: ["markdown"] },
    ]);

    assert.deepEqual(result.conflict_cid, [
      { snippetIndex: 1, prefix: "same", conflictingSnippetName: "First" },
      { snippetIndex: 2, prefix: "same", conflictingSnippetName: "First" },
      { snippetIndex: 3, prefix: "other", conflictingSnippetName: "Third" },
    ]);
  });

  it("caps retained conflicts and counts omitted warnings", () => {
    const result = indexDuplicatePrefixConflicts([
      { name: "First", prefix_pid: ["same"], scope_lid: [] },
      { name: "Second", prefix_pid: ["same"], scope_lid: [] },
      { name: "Third", prefix_pid: ["same"], scope_lid: [] },
      { name: "Fourth", prefix_pid: ["same"], scope_lid: [] },
    ], 2);

    assert.equal(result.conflict_cid.length, 2);
    assert.equal(result.omittedCount, 1);
  });

  it("accepts the exact work boundary and exhausts without partial conflicts one over", () => {
    const snippet_sid = [
      { name: "First", prefix_pid: ["same"], scope_lid: ["julia", "markdown"] },
      { name: "Second", prefix_pid: ["same"], scope_lid: ["julia", "markdown"] },
    ];
    const atLimit = indexDuplicatePrefixConflicts(snippet_sid, 100, 8);
    assert.equal(atLimit.status, "ok");
    assert.equal(atLimit.workUnits, 8);
    assert.equal(atLimit.conflict_cid.length, 1);

    const overLimit = indexDuplicatePrefixConflicts([
      ...snippet_sid,
      { name: "Third", prefix_pid: ["same"], scope_lid: [] },
    ], 100, 8);
    assert.deepEqual(overLimit, {
      status: "exhausted",
      reason: "workLimit",
      conflict_cid: [],
      omittedCount: 0,
      workUnits: 9,
    });
  });

  it("fails closed before indexing oversized direct arrays", () => {
    const result = indexDuplicatePrefixConflicts([{
      name: "Oversized",
      prefix_pid: ["x"],
      scope_lid: Array.from({ length: 257 }, () => "julia"),
    }]);
    assert.deepEqual(result, {
      status: "exhausted",
      reason: "invalidInput",
      conflict_cid: [],
      omittedCount: 0,
      workUnits: 0,
    });
  });
});
