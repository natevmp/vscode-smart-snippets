import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";

import { prepareContentChanges } from "../../src/core/index.js";

import {
  canRememberTabstopSelections,
  classifyCurrentGroupSelectionAttribution,
  countTrackedSessionRanges,
  enqueueSerialTask,
  enqueueSerialTaskForIdentity,
  finishPendingPad,
  finishSerialTaskIdentity,
  isPadInsertionSnapshot,
  isExpectedCompletedNavigationEvent,
  isValidSelectionCardinality,
  matchingTabstopForSelections,
  pendingPadsForDriver,
  rebaseTerminalEndpoints,
  resolveCompletedNavigationTransition,
  resolveFallbackSelectionTransition,
  resolveForwardSelectionTransition,
  resolveSelectionTransition,
  selectionRangesMatchGroup,
  selectionsMatchPredictedTerminalEndpoints,
  selectionsOwnTabstop,
  type SerialTaskIdentity,
  type CompletedNavigationState,
} from "../../src/session/helpers.js";

function capturedPad(driverTabstop = 1, start = 12): Record<string, unknown> {
  return {
    driverTabstop,
    fill: "-",
    targetWidth: 80,
    generated: { start, end: start },
  };
}

function snapshotWith(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    snippetName: "heading",
    sourceUri: "file:///snippets.jsonc",
    targetDocumentUri: "file:///target.jl",
    targetDocumentVersion: 5,
    instanceCount: 2,
    tabstop_tid: [1, 3],
    pad_pid: [capturedPad(1, 12), { ...capturedPad(3, 42), configurationName: "heading" }],
    terminal_rid: [{ start: 18, end: 18 }, { start: 48, end: 48 }],
    ...overrides,
  };
}

describe("session helpers", () => {
  it("deeply validates a complete marker-free multi-pad snapshot", () => {
    assert.equal(isPadInsertionSnapshot(snapshotWith()), true);
    assert.equal(isPadInsertionSnapshot(snapshotWith({ tabstop_tid: [1, 3, 9] })), true);
    assert.equal(isPadInsertionSnapshot(snapshotWith({ targetDocumentVersion: Number.MAX_SAFE_INTEGER })), true);

    assert.equal(isPadInsertionSnapshot(snapshotWith({ targetDocumentVersion: 1.5 })), false);
    assert.equal(isPadInsertionSnapshot(snapshotWith({ instanceCount: 0 })), false);
    assert.equal(isPadInsertionSnapshot(snapshotWith({ instanceCount: 3 })), false);
    assert.equal(isPadInsertionSnapshot(snapshotWith({ tabstop_tid: [] })), false);
    assert.equal(isPadInsertionSnapshot(snapshotWith({ tabstop_tid: [1, 1] })), false);
    assert.equal(isPadInsertionSnapshot(snapshotWith({ tabstop_tid: [3, 1] })), false);
    assert.equal(isPadInsertionSnapshot(snapshotWith({ tabstop_tid: [0, 1] })), false);
    assert.equal(isPadInsertionSnapshot(snapshotWith({ pad_pid: [] })), false);
    assert.equal(isPadInsertionSnapshot(snapshotWith({ pad_pid: [capturedPad(2)] })), false);
    assert.equal(isPadInsertionSnapshot(snapshotWith({ pad_pid: [capturedPad(1), capturedPad(2)] })), false);
    assert.equal(isPadInsertionSnapshot(snapshotWith({
      pad_pid: [{ ...capturedPad(), fill: "🙂" }, { ...capturedPad(3), fill: "ab" }],
    })), true);
    assert.equal(isPadInsertionSnapshot(snapshotWith({
      pad_pid: [{ ...capturedPad(), fill: "" }, capturedPad(3)],
    })), false);
    assert.equal(isPadInsertionSnapshot(snapshotWith({
      pad_pid: [{ ...capturedPad(), fill: "a\nb" }, capturedPad(3)],
    })), false);
    assert.equal(isPadInsertionSnapshot(snapshotWith({
      pad_pid: [{ ...capturedPad(), targetWidth: 10_001 }, capturedPad(3)],
    })), false);
    assert.equal(isPadInsertionSnapshot(snapshotWith({
      pad_pid: [{ ...capturedPad(), configurationName: 4 }, capturedPad(3)],
    })), false);
    assert.equal(isPadInsertionSnapshot(snapshotWith({
      pad_pid: [{ ...capturedPad(), generated: { start: 13, end: 12 } }, capturedPad(3)],
    })), false);
    assert.equal(isPadInsertionSnapshot(snapshotWith({
      pad_pid: [{ ...capturedPad(), generated: { start: 0, end: Number.MAX_SAFE_INTEGER } }, capturedPad(3)],
    })), true);
  });

  it("enforces the per-session tracked-pad bound", () => {
    const maximumPad_pid = Array.from({ length: 4_096 }, (_, index) => capturedPad(1, index));
    assert.equal(isPadInsertionSnapshot(snapshotWith({
      instanceCount: 1,
      tabstop_tid: [1],
      pad_pid: maximumPad_pid,
      terminal_rid: [{ start: 18, end: 18 }],
    })), true);
    assert.equal(isPadInsertionSnapshot(snapshotWith({
      instanceCount: 1,
      tabstop_tid: [1],
      pad_pid: [...maximumPad_pid, capturedPad()],
      terminal_rid: [{ start: 18, end: 18 }],
    })), false);
  });

  it("rejects forged terminal endpoint arrays and ranges", () => {
    assert.equal(isPadInsertionSnapshot(snapshotWith({ terminal_rid: [] })), true);
    const missingTerminal = snapshotWith();
    delete missingTerminal.terminal_rid;
    assert.equal(isPadInsertionSnapshot(missingTerminal), false);
    assert.equal(isPadInsertionSnapshot(snapshotWith({ terminal_rid: [{ start: 18, end: 18 }] })), false);
    assert.equal(isPadInsertionSnapshot(snapshotWith({
      terminal_rid: [{ start: 18, end: 19 }, { start: 48, end: 48 }],
    })), false);
    assert.equal(isPadInsertionSnapshot(snapshotWith({
      terminal_rid: [{ start: -1, end: -1 }, { start: 48, end: 48 }],
    })), false);

    const sparseTerminal_rid = new Array(2);
    sparseTerminal_rid[0] = { start: 18, end: 18 };
    assert.equal(isPadInsertionSnapshot(snapshotWith({ terminal_rid: sparseTerminal_rid })), false);
    assert.equal(isPadInsertionSnapshot(snapshotWith({
      terminal_rid: Array.from({ length: 4_097 }, (_, index) => ({ start: index, end: index })),
    })), false);

    const accessorTerminal = { start: 18 };
    Object.defineProperty(accessorTerminal, "end", { get: () => 18, enumerable: true });
    assert.equal(isPadInsertionSnapshot(snapshotWith({
      terminal_rid: [accessorTerminal, { start: 48, end: 48 }],
    })), false);
  });

  it("enforces snapshot and observed-selection cardinality limits", () => {
    const excessiveTabstop_tid = Array.from({ length: 2_049 }, (_, index) => index + 1);
    assert.equal(isPadInsertionSnapshot(snapshotWith({ tabstop_tid: excessiveTabstop_tid })), false);

    assert.equal(isValidSelectionCardinality(2, 2), true);
    assert.equal(isValidSelectionCardinality(6, 2), true);
    assert.equal(isValidSelectionCardinality(1, 2), false);
    assert.equal(isValidSelectionCardinality(3, 2), false);
    assert.equal(isValidSelectionCardinality(4_097, 1), false);
  });

  it("bounds retained selection groups while permitting replacement", () => {
    const maximumSelection_sid = Array.from({ length: 4_096 }, (_, index) => ({
      start: index,
      end: index,
    }));
    const group_gid = [{ tabstop: 1, selection_sid: maximumSelection_sid }];

    assert.equal(canRememberTabstopSelections(1, [], 1, maximumSelection_sid), true);
    assert.equal(canRememberTabstopSelections(1, group_gid, 1, [{ start: 0, end: 0 }]), true);
    assert.equal(canRememberTabstopSelections(1, group_gid, 2, [{ start: 5_000, end: 5_000 }]), false);
  });

  it("rejects class, prototype, sparse-array, and hostile nested accessor tricks", () => {
    assert.equal(isPadInsertionSnapshot([snapshotWith()]), false);
    assert.equal(isPadInsertionSnapshot(new (class Snapshot {
      public readonly snippetName = "heading";
    })()), false);

    const accessorSnapshot = snapshotWith();
    Object.defineProperty(accessorSnapshot, "pad_pid", { get: () => [], enumerable: true });
    assert.equal(isPadInsertionSnapshot(accessorSnapshot), false);

    const accessorPad = capturedPad();
    Object.defineProperty(accessorPad, "fill", { get: () => "-", enumerable: true });
    assert.equal(isPadInsertionSnapshot(snapshotWith({ pad_pid: [accessorPad, capturedPad(3)] })), false);

    const accessorGenerated = { start: 12 };
    Object.defineProperty(accessorGenerated, "end", { get: () => 12, enumerable: true });
    assert.equal(isPadInsertionSnapshot(snapshotWith({
      pad_pid: [{ ...capturedPad(), generated: accessorGenerated }, capturedPad(3)],
    })), false);

    const sparsePad_pid = new Array(2);
    sparsePad_pid[0] = capturedPad();
    assert.equal(isPadInsertionSnapshot(snapshotWith({ pad_pid: sparsePad_pid })), false);

    const prototypePad = capturedPad();
    Object.setPrototypeOf(prototypePad, { driverTabstop: 1 });
    assert.equal(isPadInsertionSnapshot(snapshotWith({ pad_pid: [prototypePad, capturedPad(3)] })), false);
  });

  it("groups every pending pad by numeric driver without rearming terminal pads", () => {
    const pad_pid = [
      { id: "first", driverTabstop: 1, state: "pending" as const },
      { id: "named", driverTabstop: 1, state: "pending" as const },
      { id: "settled", driverTabstop: 1, state: "settled" as const },
      { id: "later", driverTabstop: 3, state: "pending" as const },
    ];
    assert.deepEqual(pendingPadsForDriver(pad_pid, 1).map((pad) => pad.id), ["first", "named"]);
    assert.equal(finishPendingPad("pending", "settled"), "settled");
    assert.equal(finishPendingPad("settled", "invalid"), "settled");
    assert.equal(finishPendingPad("invalid", "settled"), "invalid");
  });

  it("matches mirrored selection groups independent of primary-selection order", () => {
    const mirroredSelection_sid = [
      { start: 41, end: 41 },
      { start: 2, end: 4 },
      { start: 20, end: 20 },
    ];
    const observedSelection_sid = [
      { start: 19, end: 23 },
      { start: 1, end: 8 },
      { start: 40, end: 45 },
    ];
    assert.equal(selectionRangesMatchGroup(mirroredSelection_sid, observedSelection_sid), true);
    assert.equal(selectionRangesMatchGroup(mirroredSelection_sid.slice(1), observedSelection_sid), false);
    assert.equal(matchingTabstopForSelections(mirroredSelection_sid, [
      { tabstop: 1, selection_sid: [{ start: 60, end: 60 }] },
      { tabstop: 3, selection_sid: observedSelection_sid },
    ]), 3);
    assert.equal(matchingTabstopForSelections([{ start: 5, end: 5 }], [
      { tabstop: 1, selection_sid: [{ start: 0, end: 10 }] },
      { tabstop: 3, selection_sid: [{ start: 3, end: 8 }] },
    ]), undefined);
  });

  it("uses current-group provenance while keeping unmanaged transitions unambiguous", () => {
    const group_gid = [
      { tabstop: 1, selection_sid: [{ start: 0, end: 10 }] },
      { tabstop: 3, selection_sid: [{ start: 20, end: 30 }] },
    ];
    assert.equal(selectionsOwnTabstop([{ start: 4, end: 4 }], 1, group_gid), true);
    assert.equal(selectionsOwnTabstop([{ start: 24, end: 24 }], 1, group_gid), false);
    assert.deepEqual(resolveSelectionTransition([{ start: 24, end: 24 }], group_gid), {
      kind: "observed",
      tabstop: 3,
    });
    assert.deepEqual(resolveSelectionTransition([{ start: 15, end: 15 }], group_gid), {
      kind: "terminal",
    });

    const ambiguous_gid = [
      { tabstop: 1, selection_sid: [{ start: 0, end: 10 }] },
      { tabstop: 3, selection_sid: [{ start: 2, end: 8 }] },
    ];
    assert.equal(selectionsOwnTabstop([{ start: 5, end: 5 }], 1, ambiguous_gid), true);
    assert.deepEqual(resolveSelectionTransition([{ start: 5, end: 5 }], ambiguous_gid), {
      kind: "terminal",
    });

    const coincident_gid = [
      { tabstop: 1, selection_sid: [{ start: 40, end: 40 }] },
      { tabstop: 2, selection_sid: [{ start: 40, end: 40 }] },
    ];
    assert.equal(selectionsOwnTabstop([{ start: 40, end: 40 }], 2, coincident_gid), true);
    assert.deepEqual(resolveSelectionTransition([{ start: 40, end: 40 }], coincident_gid), {
      kind: "terminal",
    });
  });

  it("classifies current-group attribution without consuming duplicates or depending on order", () => {
    const currentGroup_sid = [
      { start: 20, end: 25 },
      { start: 2, end: 8 },
    ];
    assert.equal(classifyCurrentGroupSelectionAttribution(
      [{ start: 40, end: 40 }, { start: 30, end: 32 }],
      currentGroup_sid,
    ), "none");
    assert.equal(classifyCurrentGroupSelectionAttribution(
      [{ start: 21, end: 21 }, { start: 4, end: 4 }, { start: 21, end: 21 }],
      currentGroup_sid,
    ), "all");
    assert.equal(classifyCurrentGroupSelectionAttribution(
      [{ start: 30, end: 30 }, { start: 4, end: 4 }],
      currentGroup_sid,
    ), "mixed");
  });

  it("rejects empty, malformed, and over-limit attribution inputs", () => {
    const validRange_sid = [{ start: 2, end: 8 }];
    assert.equal(classifyCurrentGroupSelectionAttribution([], validRange_sid), "unsafe");
    assert.equal(classifyCurrentGroupSelectionAttribution(
      [{ start: 8, end: 2 }],
      validRange_sid,
    ), "unsafe");
    assert.equal(classifyCurrentGroupSelectionAttribution(
      validRange_sid,
      Array.from({ length: 4_097 }, (_, index) => ({ start: index, end: index })),
    ), "unsafe");
  });

  it("matches only valid surviving selections at predicted terminal endpoints", () => {
    assert.equal(selectionsMatchPredictedTerminalEndpoints(
      [{ start: 20, end: 20 }, { start: 4, end: 4 }, { start: 20, end: 20 }],
      [{ start: 4, end: 4 }, { start: 20, end: 20 }],
    ), true);
    assert.equal(selectionsMatchPredictedTerminalEndpoints(
      [{ start: 4, end: 5 }],
      [{ start: 4, end: 4 }],
    ), false);
    assert.equal(selectionsMatchPredictedTerminalEndpoints(
      [{ start: 4, end: 4 }],
      [],
    ), false);
  });

  it("fails fallback selection transitions closed before exited-pad evaluation", () => {
    const currentGroup_sid = [{ start: 0, end: 10 }, { start: 20, end: 30 }];
    const nextGroup_sid = [{ start: 40, end: 50 }, { start: 60, end: 70 }];
    const group_gid = [
      { tabstop: 1, selection_sid: currentGroup_sid },
      { tabstop: 2, selection_sid: nextGroup_sid },
    ];
    const lastGroup_gid = [{ tabstop: 1, selection_sid: currentGroup_sid }];

    assert.deepEqual(resolveFallbackSelectionTransition(
      [{ start: 25, end: 25 }, { start: 5, end: 5 }],
      1,
      currentGroup_sid,
      group_gid,
      2,
      false,
      [],
    ), { kind: "stay" });
    assert.deepEqual(resolveFallbackSelectionTransition(
      [{ start: 5, end: 5 }, { start: 45, end: 45 }],
      1,
      currentGroup_sid,
      group_gid,
      2,
      false,
      [],
    ), { kind: "discard" }, "partial multicursor movement must not evaluate");
    assert.deepEqual(resolveFallbackSelectionTransition(
      [{ start: 5, end: 5 }],
      1,
      currentGroup_sid,
      lastGroup_gid,
      2,
      false,
      [{ start: 5, end: 5 }],
    ), { kind: "discard" }, "all-current movement is not terminal before the last group");
    assert.deepEqual(resolveFallbackSelectionTransition(
      [{ start: 5, end: 5 }],
      1,
      currentGroup_sid,
      lastGroup_gid,
      2,
      true,
      [{ start: 5, end: 5 }, { start: 25, end: 25 }],
    ), { kind: "terminal" }, "a predicted all-current collapsed final may evaluate");
    assert.deepEqual(resolveFallbackSelectionTransition(
      [{ start: 80, end: 80 }],
      1,
      currentGroup_sid,
      lastGroup_gid,
      2,
      true,
      [{ start: 80, end: 80 }, { start: 90, end: 90 }],
    ), { kind: "terminal" }, "a collapsed moved final must match a predicted endpoint");
    assert.deepEqual(resolveFallbackSelectionTransition(
      [{ start: 81, end: 81 }],
      1,
      currentGroup_sid,
      lastGroup_gid,
      2,
      true,
      [{ start: 80, end: 80 }, { start: 90, end: 90 }],
    ), { kind: "discard" }, "an arbitrary collapsed moved point must not evaluate");
    assert.deepEqual(resolveFallbackSelectionTransition(
      [{ start: 80, end: 80 }, { start: 90, end: 90 }],
      1,
      currentGroup_sid,
      group_gid,
      2,
      false,
      [],
    ), { kind: "terminal" }, "a valid-cardinality fully-left transition remains best effort");
    assert.deepEqual(resolveFallbackSelectionTransition(
      [{ start: 65, end: 65 }, { start: 45, end: 45 }],
      1,
      currentGroup_sid,
      group_gid,
      2,
      false,
      [],
    ), { kind: "observed", tabstop: 2 });
  });

  it("rejects unchanged nonterminal forward selections", () => {
    assert.deepEqual(resolveForwardSelectionTransition(
      [{ start: 4, end: 4 }],
      [{ start: 2, end: 8 }],
      undefined,
      false,
      [],
    ), { kind: "unsafe" });
  });

  it("rejects reordered unchanged mirrored and duplicate selections", () => {
    const currentGroup_sid = [
      { start: 2, end: 8 },
      { start: 20, end: 25 },
      { start: 20, end: 25 },
    ];
    assert.deepEqual(resolveForwardSelectionTransition(
      [{ start: 21, end: 21 }, { start: 4, end: 4 }, { start: 21, end: 21 }],
      currentGroup_sid,
      undefined,
      false,
      [],
    ), { kind: "unsafe" });
  });

  it("rejects partial multicursor movement", () => {
    assert.deepEqual(resolveForwardSelectionTransition(
      [{ start: 3, end: 3 }, { start: 30, end: 30 }],
      [{ start: 2, end: 8 }, { start: 20, end: 25 }],
      undefined,
      false,
      [],
    ), { kind: "unsafe" });
  });

  it("accepts a complete move to an unobserved next group", () => {
    assert.deepEqual(resolveForwardSelectionTransition(
      [{ start: 30, end: 30 }, { start: 40, end: 42 }],
      [{ start: 2, end: 8 }, { start: 20, end: 25 }],
      undefined,
      false,
      [],
    ), { kind: "next" });
  });

  it("learns complete unvisited groups before requiring a proven terminal endpoint", () => {
    const initialState: CompletedNavigationState = {
      instanceCount: 2,
      currentGroup_sid: [{ start: 2, end: 5 }, { start: 20, end: 23 }],
      remainingGroup_gid: [
        { tabstop: 3, selection_sid: undefined },
        { tabstop: 4, selection_sid: [{ start: 50, end: 54 }, { start: 70, end: 74 }] },
      ],
      nextGroupIndex: 0,
      terminal_rid: [{ start: 90, end: 90 }, { start: 100, end: 100 }],
    };

    const learned = resolveCompletedNavigationTransition(initialState, [
      { start: 30, end: 33 },
      { start: 40, end: 43 },
    ]);
    assert.equal(learned.kind, "next");
    assert.deepEqual(learned.kind === "next" ? learned.state.currentGroup_sid : [], [
      { start: 30, end: 33 },
      { start: 40, end: 43 },
    ]);

    assert.deepEqual(resolveCompletedNavigationTransition(initialState, [
      { start: 3, end: 3 },
      { start: 30, end: 30 },
    ]), { kind: "unsafe" }, "partial movement from the current group must fail closed");
    assert.deepEqual(resolveCompletedNavigationTransition(initialState, [
      { start: 30, end: 30 },
    ]), { kind: "unsafe" }, "unsafe instance cardinality must fail closed");

    assert.equal(learned.kind, "next");
    if (learned.kind !== "next") {
      return;
    }
    const known = resolveCompletedNavigationTransition(learned.state, [
      { start: 51, end: 53 },
      { start: 71, end: 73 },
    ]);
    assert.equal(known.kind, "next");
    if (known.kind !== "next") {
      return;
    }
    assert.deepEqual(resolveCompletedNavigationTransition(known.state, [
      { start: 91, end: 91 },
      { start: 100, end: 100 },
    ]), { kind: "unsafe" }, "an arbitrary final movement must not be accepted");
    assert.deepEqual(resolveCompletedNavigationTransition(known.state, [
      { start: 90, end: 90 },
      { start: 100, end: 100 },
    ]), { kind: "terminal" });
  });

  it("requires an exact remembered next group after backward navigation", () => {
    const currentGroup_sid = [{ start: 2, end: 8 }];
    const expectedNextGroup_sid = [{ start: 20, end: 25 }];
    assert.deepEqual(resolveForwardSelectionTransition(
      [{ start: 21, end: 23 }],
      currentGroup_sid,
      expectedNextGroup_sid,
      false,
      [],
    ), { kind: "next" });
    assert.deepEqual(resolveForwardSelectionTransition(
      [{ start: 30, end: 30 }],
      currentGroup_sid,
      expectedNextGroup_sid,
      false,
      [],
    ), { kind: "unsafe" });
  });

  it("accepts only proven endpoint no-ops while preserving observable terminal movement", () => {
    const currentGroup_sid = [{ start: 2, end: 8 }, { start: 20, end: 25 }];
    assert.deepEqual(resolveForwardSelectionTransition(
      [{ start: 21, end: 21 }, { start: 4, end: 4 }],
      currentGroup_sid,
      undefined,
      true,
      [{ start: 4, end: 4 }, { start: 21, end: 21 }],
    ), { kind: "terminal" });
    assert.deepEqual(resolveForwardSelectionTransition(
      [{ start: 21, end: 21 }, { start: 4, end: 4 }],
      currentGroup_sid,
      undefined,
      true,
      [{ start: 30, end: 30 }, { start: 40, end: 40 }],
    ), { kind: "unsafe" });
    assert.deepEqual(resolveForwardSelectionTransition(
      [{ start: 30, end: 30 }, { start: 40, end: 40 }],
      currentGroup_sid,
      undefined,
      true,
      [],
    ), { kind: "terminal" });
    assert.deepEqual(resolveForwardSelectionTransition(
      [{ start: 4, end: 4 }, { start: 40, end: 40 }],
      currentGroup_sid,
      undefined,
      true,
      [{ start: 4, end: 4 }, { start: 40, end: 40 }],
    ), { kind: "unsafe" });
    assert.deepEqual(resolveForwardSelectionTransition(
      [{ start: 2, end: 8 }],
      currentGroup_sid,
      undefined,
      true,
      [{ start: 2, end: 2 }],
    ), { kind: "unsafe" });
  });

  it("accepts collapsed multicursor finals only when the survivor matches an endpoint", () => {
    const currentGroup_sid = [{ start: 2, end: 8 }, { start: 20, end: 25 }];
    assert.deepEqual(resolveForwardSelectionTransition(
      [{ start: 4, end: 4 }],
      currentGroup_sid,
      undefined,
      true,
      [{ start: 4, end: 4 }, { start: 21, end: 21 }],
      false,
    ), { kind: "terminal" });
    assert.deepEqual(resolveForwardSelectionTransition(
      [{ start: 40, end: 40 }],
      currentGroup_sid,
      undefined,
      true,
      [{ start: 40, end: 40 }, { start: 50, end: 50 }],
      false,
    ), { kind: "terminal" });
    assert.deepEqual(resolveForwardSelectionTransition(
      [{ start: 41, end: 41 }],
      currentGroup_sid,
      undefined,
      true,
      [{ start: 40, end: 40 }, { start: 50, end: 50 }],
      false,
    ), { kind: "unsafe" });
  });

  it("rejects all-current terminal transitions without valid predicted endpoints", () => {
    const currentGroup_sid = [{ start: 2, end: 8 }];
    for (const terminal_rid of [
      [],
      [{ start: 4, end: 5 }],
      [{ start: Number.MAX_SAFE_INTEGER + 1, end: Number.MAX_SAFE_INTEGER + 1 }],
    ]) {
      assert.deepEqual(resolveForwardSelectionTransition(
        [{ start: 4, end: 4 }],
        currentGroup_sid,
        undefined,
        true,
        terminal_rid,
      ), { kind: "unsafe" });
    }
  });

  it("rejects empty and malformed forward-transition ranges", () => {
    const validRange_sid = [{ start: 2, end: 8 }];
    assert.deepEqual(resolveForwardSelectionTransition([], validRange_sid, undefined, false, []), {
      kind: "unsafe",
    });
    assert.deepEqual(resolveForwardSelectionTransition(
      [{ start: 8, end: 2 }],
      validRange_sid,
      undefined,
      false,
      [],
    ), { kind: "unsafe" });
    assert.deepEqual(resolveForwardSelectionTransition(
      [{ start: 20, end: 20 }],
      [{ start: -1, end: 8 }],
      undefined,
      false,
      [],
    ), { kind: "unsafe" });
    assert.deepEqual(resolveForwardSelectionTransition(
      [{ start: 20, end: 20 }],
      validRange_sid,
      [{ start: Number.NaN, end: 25 }],
      false,
      [],
    ), { kind: "unsafe" });
  });

  it("rebases terminal points with right affinity and counts them as tracked ranges", () => {
    const prepared = prepareContentChanges([{ rangeOffset: 10, rangeLength: 0, text: "abc" }]);
    const terminal_rid = [{ start: 10, end: 10 }, { start: 20, end: 20 }];
    assert.deepEqual(rebaseTerminalEndpoints(terminal_rid, prepared, 23), [
      { start: 13, end: 13 },
      { start: 23, end: 23 },
    ]);
    assert.equal(rebaseTerminalEndpoints(terminal_rid, prepared, 22), undefined);
    assert.equal(countTrackedSessionRanges(2, [{
      tabstop: 1,
      selection_sid: [{ start: 1, end: 1 }, { start: 2, end: 2 }, { start: 3, end: 3 }],
    }], terminal_rid), 7);
  });

  it("does not materialize whole-document text to measure session document length", async () => {
    const sourceText = await readFile(
      path.resolve(process.cwd(), "src/session/sessionManager.ts"),
      "utf8",
    );
    assert.doesNotMatch(sourceText, /getText\s*\(\s*\)\s*\.length/u);
  });

  it("serializes keyed tasks, recovers from errors, and removes idle queue entries", async () => {
    const taskByKey = new Map<string, Promise<void>>();
    const event_eid: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const firstTask = enqueueSerialTask(taskByKey, "editor", async () => {
      event_eid.push("first-start");
      await firstGate;
      event_eid.push("first-error");
      throw new Error("expected failure");
    });
    const secondTask = enqueueSerialTask(taskByKey, "editor", async () => {
      event_eid.push("second");
    });
    const otherTask = enqueueSerialTask(taskByKey, "other", async () => {
      event_eid.push("other");
    });

    await otherTask;
    assert.deepEqual(event_eid, ["first-start", "other"]);
    assert.equal(taskByKey.has("editor"), true);
    assert.equal(taskByKey.has("other"), false);

    assert.ok(releaseFirst);
    releaseFirst();
    await assert.rejects(firstTask, /expected failure/u);
    await secondTask;
    assert.deepEqual(event_eid, ["first-start", "other", "first-error", "second"]);
    assert.equal(taskByKey.size, 0);
  });

  it("drops queued tasks after queue-identity replacement", async () => {
    const taskByKey = new Map<string, Promise<void>>();
    const event_eid: string[] = [];
    const staleIdentity: SerialTaskIdentity = { lifecycle: "active", acceptedTaskCount: 0 };
    let releaseBlocker: (() => void) | undefined;
    const blockerGate = new Promise<void>((resolve) => {
      releaseBlocker = resolve;
    });
    const blocker = enqueueSerialTask(taskByKey, "editor", async () => {
      await blockerGate;
    });
    const staleTask = enqueueSerialTaskForIdentity(
      taskByKey,
      "editor",
      staleIdentity,
      async () => { event_eid.push("stale"); },
    );
    finishSerialTaskIdentity(staleIdentity, "completed");
    finishSerialTaskIdentity(staleIdentity, "invalidated");

    assert.ok(releaseBlocker);
    releaseBlocker();
    await Promise.all([blocker, staleTask]);
    assert.equal(event_eid.length, 0);
    assert.equal(staleIdentity.lifecycle, "retired");
    assert.equal(staleIdentity.acceptedTaskCount, 0);
    assert.equal(taskByKey.size, 0);
  });

  it("runs every accepted task after normal completion but drops unsafe queued work", async () => {
    const taskByKey = new Map<string, Promise<void>>();
    const event_eid: string[] = [];
    const activeIdentity: SerialTaskIdentity = { lifecycle: "active", acceptedTaskCount: 0 };
    let retiredCount = 0;
    const onRetired = (): void => { retiredCount += 1; };

    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstTask = enqueueSerialTaskForIdentity(
      taskByKey,
      "editor",
      activeIdentity,
      async () => {
        event_eid.push("first");
        await firstGate;
      },
      onRetired,
    );
    const secondTask = enqueueSerialTaskForIdentity(
      taskByKey,
      "editor",
      activeIdentity,
      async () => { event_eid.push("second"); },
      onRetired,
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(event_eid, ["first"]);
    assert.equal(activeIdentity.acceptedTaskCount, 2, "tickets must be reserved at enqueue time");
    finishSerialTaskIdentity(activeIdentity, "completed");
    const lateTask = enqueueSerialTaskForIdentity(
      taskByKey,
      "editor",
      activeIdentity,
      async () => { event_eid.push("late"); },
      onRetired,
    );
    await lateTask;
    assert.equal(activeIdentity.acceptedTaskCount, 2, "completed identities must reject new tickets");
    assert.ok(releaseFirst);
    releaseFirst();
    await Promise.all([firstTask, secondTask]);
    assert.deepEqual(event_eid, ["first", "second"]);
    assert.equal(taskByKey.size, 0);
    assert.equal(activeIdentity.lifecycle, "retired");
    assert.equal(activeIdentity.acceptedTaskCount, 0);
    assert.equal(retiredCount, 1);

    const unsafeIdentity: SerialTaskIdentity = { lifecycle: "active", acceptedTaskCount: 0 };
    let releaseUnsafe: (() => void) | undefined;
    const unsafeGate = new Promise<void>((resolve) => {
      releaseUnsafe = resolve;
    });
    const unsafeFirst = enqueueSerialTaskForIdentity(
      taskByKey,
      "editor",
      unsafeIdentity,
      async () => {
        event_eid.push("unsafe-first");
        await unsafeGate;
        finishSerialTaskIdentity(unsafeIdentity, "invalidated");
      },
    );
    const unsafeQueued = enqueueSerialTaskForIdentity(
      taskByKey,
      "editor",
      unsafeIdentity,
      async () => { event_eid.push("unsafe-queued"); },
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(releaseUnsafe);
    releaseUnsafe();
    await Promise.all([unsafeFirst, unsafeQueued]);
    assert.deepEqual(event_eid, ["first", "second", "unsafe-first"]);

    finishSerialTaskIdentity(unsafeIdentity, "completed");
    assert.equal(unsafeIdentity.lifecycle, "retired", "drained invalid identities must stay retired");
    assert.equal(taskByKey.size, 0);
  });

  it("invalidates remaining completed tickets when replacement occurs during forwarding", async () => {
    const taskByKey = new Map<string, Promise<void>>();
    const event_eid: string[] = [];
    const identity: SerialTaskIdentity = { lifecycle: "active", acceptedTaskCount: 0 };
    let releaseForwarding: (() => void) | undefined;
    const forwardingGate = new Promise<void>((resolve) => {
      releaseForwarding = resolve;
    });

    const firstTask = enqueueSerialTaskForIdentity(
      taskByKey,
      "editor",
      identity,
      async () => {
        event_eid.push("first");
        finishSerialTaskIdentity(identity, "completed");
      },
    );
    const deferredSecondTask = enqueueSerialTaskForIdentity(
      taskByKey,
      "editor",
      identity,
      async () => {
        event_eid.push("second-forwarding");
        await forwardingGate;
      },
    );
    const thirdTask = enqueueSerialTaskForIdentity(
      taskByKey,
      "editor",
      identity,
      async () => { event_eid.push("third"); },
    );

    await firstTask;
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(event_eid, ["first", "second-forwarding"]);
    const contentEventExpected = isExpectedCompletedNavigationEvent(
      { kind: "document" },
      [{ start: 10, end: 10 }],
    );
    assert.equal(contentEventExpected, false, "content changes during forwarding are unverified");
    assert.equal(isExpectedCompletedNavigationEvent(
      { kind: "selection", selection_sid: [{ start: 20, end: 20 }] },
      [{ start: 10, end: 10 }],
    ), false, "replacement selections must match the predicted native target");
    assert.equal(isExpectedCompletedNavigationEvent(
      { kind: "selection", selection_sid: [{ start: 10, end: 10 }] },
      [{ start: 10, end: 10 }],
    ), true);
    if (!contentEventExpected) {
      finishSerialTaskIdentity(identity, "invalidated");
    }

    assert.ok(releaseForwarding);
    releaseForwarding();
    await Promise.all([deferredSecondTask, thirdTask]);
    assert.deepEqual(event_eid, ["first", "second-forwarding"]);
    assert.equal(identity.lifecycle, "retired");
    assert.equal(identity.acceptedTaskCount, 0);
  });
});
