import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { CompiledPadMetadata } from "../../src/core/types.js";
import { MAX_OFFSET_TRACKING_WORK } from "../../src/core/offsetTracking.js";
import {
  MAX_AGGREGATE_REPLACEMENT_GAP_CODE_UNITS,
  MAX_INSERTION_INDENT_CODE_UNITS,
  MAX_PLANNED_RENDERED_CODE_UNITS,
  MAX_RETAINED_OBSERVED_CHANGE_TEXT_CODE_UNITS,
  MAX_RENDERING_INDENT_SIZE,
  MAX_TRACKED_PADS_PER_SESSION,
  MAX_TRACKED_SELECTION_RANGES_PER_SESSION,
  MAX_TRACKED_TABSTOPS_PER_SESSION,
  createInsertionCapturePlan,
  finalizeInsertionCapture,
  type InsertionCapturePlan,
  type InsertionCapturePlanRequest,
  type InsertionDocumentEvent,
  type InsertionReplacementRange,
} from "../../src/completion/insertionCapture.js";

function request(
  body: string,
  pad_pid: readonly CompiledPadMetadata[],
  replacement_rid: readonly InsertionReplacementRange[] = [{ rangeOffset: 10, rangeLength: 2 }],
): InsertionCapturePlanRequest {
  return {
    snippetName: "Example",
    sourceUri: "file:///snippets.jsonc",
    targetDocumentUri: "file:///target.txt",
    targetDocumentVersion: 7,
    targetDocumentLength: Number.MAX_SAFE_INTEGER,
    compiled: { body, pad_pid },
    replacement_rid: replacement_rid.map((range) => ({
      ...range,
      targetEolWidth: 1,
      indentSize: 4,
      insertSpaces: true,
      insertionIndent: "",
    })),
  };
}

function getPlan(value: InsertionCapturePlanRequest): InsertionCapturePlan {
  const result = createInsertionCapturePlan(value);
  assert.equal(result.success, true, result.success ? undefined : result.reason);
  return result.value;
}

function observedEvent(
  change_cid: InsertionDocumentEvent["change_cid"],
): InsertionDocumentEvent {
  return { targetDocumentVersion: 8, change_cid };
}

describe("marker-free insertion capture", () => {
  it("plans multiple configured pads by source line and copies mutable inputs", () => {
    const pad_pid: CompiledPadMetadata[] = [
      { kind: "pad", offset: 8, driverTabstop: 2, fill: "-", targetWidth: 20 },
      {
        kind: "pad",
        offset: 15,
        driverTabstop: 1,
        fill: ".",
        targetWidth: 30,
        configurationName: "right",
      },
    ];
    const replacement_rid = [{ rangeOffset: 20, rangeLength: 3 }];
    const plan = getPlan(request("$2 first\n${1:x}\n$2 $0", pad_pid, replacement_rid));

    pad_pid[0] = { ...pad_pid[0]!, fill: "!" };
    replacement_rid[0]!.rangeOffset = 99;

    assert.deepEqual(plan.tabstop_tid, [1, 2]);
    assert.equal(plan.nativeFinalAtRenderedInsertionEnd, true);
    assert.deepEqual(plan.pad_pid, [
      { sourceLineIndex: 0, driverTabstop: 2, fill: "-", targetWidth: 20 },
      {
        sourceLineIndex: 1,
        driverTabstop: 1,
        fill: ".",
        targetWidth: 30,
        configurationName: "right",
      },
    ]);
    assert.deepEqual(plan.replacement_rid, [{
      rangeOffset: 20,
      rangeLength: 3,
      targetEolWidth: 1,
      indentSize: 4,
      insertSpaces: true,
      insertionIndent: "",
    }]);
  });

  it("accepts multi-character compiled fill strings", () => {
    const plan = getPlan(request("$1", [{
      kind: "pad",
      offset: 2,
      driverTabstop: 1,
      fill: "- ",
      targetWidth: 20,
    }]));

    assert.equal(plan.pad_pid[0]?.fill, "- ");
  });

  it("sorts and defensively copies replacement rendering contexts", () => {
    const later = {
      rangeOffset: 20,
      rangeLength: 1,
      targetEolWidth: 2,
      indentSize: 8,
      insertSpaces: false,
      insertionIndent: "\t",
    };
    const earlier = {
      rangeOffset: 2,
      rangeLength: 0,
      targetEolWidth: 1,
      indentSize: 4,
      insertSpaces: true,
      insertionIndent: "  ",
    };
    const value = request("$1", [
      { kind: "pad", offset: 2, driverTabstop: 1, fill: "-", targetWidth: 10 },
    ]);
    const plan = getPlan({
      ...value,
      targetDocumentLength: 21,
      replacement_rid: [later, earlier],
    });

    later.insertionIndent = "changed";
    earlier.indentSize = 2;
    earlier.insertSpaces = false;

    assert.deepEqual(plan.replacement_rid, [
      {
        rangeOffset: 2,
        rangeLength: 0,
        targetEolWidth: 1,
        indentSize: 4,
        insertSpaces: true,
        insertionIndent: "  ",
      },
      {
        rangeOffset: 20,
        rangeLength: 1,
        targetEolWidth: 2,
        indentSize: 8,
        insertSpaces: false,
        insertionIndent: "\t",
      },
    ]);
  });

  it("anchors each configured pad at its rendered CRLF line end", () => {
    const plan = getPlan(request("$2 first\n${1:x}\n$0", [
      { kind: "pad", offset: 8, driverTabstop: 2, fill: "-", targetWidth: 20 },
      {
        kind: "pad",
        offset: 15,
        driverTabstop: 1,
        fill: ".",
        targetWidth: 30,
        configurationName: "right",
      },
    ], [{ rangeOffset: 20, rangeLength: 3 }]));
    const result = finalizeInsertionCapture(plan, {
      insertionSucceeded: true,
      targetDocumentUri: "file:///target.txt",
      targetDocumentVersion: 8,
      event: observedEvent([{
        rangeOffset: 20,
        rangeLength: 3,
        text: "alpha\r\nbeta\r\n",
      }]),
      eventAmbiguousOrOverflow: false,
    });

    assert.equal(result.success, true, result.success ? undefined : result.reason);
    assert.deepEqual(result.value, {
      snippetName: "Example",
      sourceUri: "file:///snippets.jsonc",
      targetDocumentUri: "file:///target.txt",
      targetDocumentVersion: 8,
      instanceCount: 1,
      tabstop_tid: [1, 2],
      pad_pid: [
        { driverTabstop: 2, fill: "-", targetWidth: 20, generated: { start: 25, end: 25 } },
        {
          driverTabstop: 1,
          fill: ".",
          targetWidth: 30,
          configurationName: "right",
          generated: { start: 31, end: 31 },
        },
      ],
      terminal_rid: [{ start: 33, end: 33 }],
    });
    assert.doesNotThrow(() => JSON.stringify(result.value));
  });

  it("maps LF line ends and the final empty line for all pads in one rendered instance", () => {
    const plan = getPlan(request("$1\n$1\n$1", [
      { kind: "pad", offset: 2, driverTabstop: 1, fill: "-", targetWidth: 10 },
      { kind: "pad", offset: 5, driverTabstop: 1, fill: ".", targetWidth: 11 },
      { kind: "pad", offset: 8, driverTabstop: 1, fill: " ", targetWidth: 12 },
    ]));
    const result = finalizeInsertionCapture(plan, {
      insertionSucceeded: true,
      targetDocumentUri: "file:///target.txt",
      targetDocumentVersion: 8,
      event: observedEvent([{ rangeOffset: 10, rangeLength: 2, text: "a\nbc\n" }]),
      eventAmbiguousOrOverflow: false,
    });

    assert.equal(result.success, true, result.success ? undefined : result.reason);
    assert.deepEqual(result.value.pad_pid.map((pad) => pad.generated), [
      { start: 11, end: 11 },
      { start: 14, end: 14 },
      { start: 15, end: 15 },
    ]);
    assert.deepEqual(result.value.terminal_rid, [{ start: 15, end: 15 }]);
  });

  it("sorts unordered multicursor changes and adjusts later starts by replacement deltas", () => {
    const plan = getPlan(request("$1", [
      { kind: "pad", offset: 2, driverTabstop: 1, fill: " ", targetWidth: 12 },
    ], [
      { rangeOffset: 10, rangeLength: 2 },
      { rangeOffset: 2, rangeLength: 1 },
    ]));
    const result = finalizeInsertionCapture(plan, {
      insertionSucceeded: true,
      targetDocumentUri: "file:///target.txt",
      targetDocumentVersion: 8,
      event: observedEvent([
        { rangeOffset: 10, rangeLength: 2, text: "long" },
        { rangeOffset: 2, rangeLength: 1, text: "abc" },
      ]),
      eventAmbiguousOrOverflow: false,
    });

    assert.equal(result.success, true, result.success ? undefined : result.reason);
    assert.equal(result.value.instanceCount, 2);
    assert.deepEqual(result.value.pad_pid.map((pad) => pad.generated), [
      { start: 5, end: 5 },
      { start: 16, end: 16 },
    ]);
    assert.deepEqual(result.value.terminal_rid, [
      { start: 5, end: 5 },
      { start: 16, end: 16 },
    ]);
  });

  it("proves only implicit or unique simple top-level final stops at the source end", () => {
    const planForBody = (body: string): InsertionCapturePlan => getPlan(request(body, [{
      kind: "pad",
      offset: body.length,
      driverTabstop: 1,
      fill: "-",
      targetWidth: 10,
    }]));

    for (const body of ["$1", "$1$0", "$1\n${0}"]) {
      assert.equal(planForBody(body).nativeFinalAtRenderedInsertionEnd, true, body);
    }
    for (const body of [
      "$1$0 trailing",
      "$1$0${0}",
      "${1:nested $0}",
      "$1${0:default}",
      "$1${0/(.*)/replacement/}",
    ]) {
      assert.equal(planForBody(body).nativeFinalAtRenderedInsertionEnd, false, body);
    }

    const zeroChoice = createInsertionCapturePlan(request("$1${0|a,b|}", [{
      kind: "pad",
      offset: 12,
      driverTabstop: 1,
      fill: "-",
      targetWidth: 10,
    }]));
    assert.equal(zeroChoice.success, false);
  });

  it("captures explicit final endpoints on a later final line", () => {
    const plan = getPlan(request("$1\n$0", [{
      kind: "pad",
      offset: 2,
      driverTabstop: 1,
      fill: "-",
      targetWidth: 10,
    }]));
    const result = finalizeInsertionCapture(plan, {
      insertionSucceeded: true,
      targetDocumentUri: "file:///target.txt",
      targetDocumentVersion: 8,
      event: observedEvent([{ rangeOffset: 10, rangeLength: 2, text: "value\n" }]),
      eventAmbiguousOrOverflow: false,
    });

    assert.equal(result.success, true, result.success ? undefined : result.reason);
    assert.deepEqual(result.value.terminal_rid, [{ start: 16, end: 16 }]);
  });

  it("omits endpoints when an explicit final stop is not provably the rendered end", () => {
    const plan = getPlan(request("$1$0 trailing", [{
      kind: "pad",
      offset: 2,
      driverTabstop: 1,
      fill: "-",
      targetWidth: 10,
    }]));
    const result = finalizeInsertionCapture(plan, {
      insertionSucceeded: true,
      targetDocumentUri: "file:///target.txt",
      targetDocumentVersion: 8,
      event: observedEvent([{ rangeOffset: 10, rangeLength: 2, text: "value trailing" }]),
      eventAmbiguousOrOverflow: false,
    });

    assert.equal(result.success, true, result.success ? undefined : result.reason);
    assert.deepEqual(result.value.terminal_rid, []);
  });

  it("matches replacement ranges exactly by offset and length", () => {
    const plan = getPlan(request("$1", [
      { kind: "pad", offset: 2, driverTabstop: 1, fill: "-", targetWidth: 10 },
    ]));
    const result = finalizeInsertionCapture(plan, {
      insertionSucceeded: true,
      targetDocumentUri: "file:///target.txt",
      targetDocumentVersion: 8,
      event: observedEvent([{ rangeOffset: 10, rangeLength: 1, text: "x" }]),
      eventAmbiguousOrOverflow: false,
    });

    assert.equal(result.success, false);
    assert.match(result.reason, /replacement ranges/u);
  });

  it("rejects rendered expansions that change the source line count", () => {
    const plan = getPlan(request("$1\n$0", [
      { kind: "pad", offset: 2, driverTabstop: 1, fill: "-", targetWidth: 10 },
    ]));
    const result = finalizeInsertionCapture(plan, {
      insertionSucceeded: true,
      targetDocumentUri: "file:///target.txt",
      targetDocumentVersion: 8,
      event: observedEvent([{ rangeOffset: 10, rangeLength: 2, text: "one line" }]),
      eventAmbiguousOrOverflow: false,
    });

    assert.equal(result.success, false);
    assert.match(result.reason, /line count/u);
  });

  it("rejects missing and ambiguous target-document events without retaining an event array", () => {
    const plan = getPlan(request("$1", [
      { kind: "pad", offset: 2, driverTabstop: 1, fill: "-", targetWidth: 10 },
    ]));
    const event = observedEvent([{ rangeOffset: 10, rangeLength: 2, text: "x" }]);

    for (const [retainedEvent, eventAmbiguousOrOverflow] of [
      [undefined, false],
      [event, true],
    ] as const) {
      const result = finalizeInsertionCapture(plan, {
        insertionSucceeded: true,
        targetDocumentUri: "file:///target.txt",
        targetDocumentVersion: 8,
        event: retainedEvent,
        eventAmbiguousOrOverflow,
      });
      assert.equal(result.success, false);
      assert.match(result.reason, /exactly one|ambiguous/u);
    }
  });

  it("rejects stale versions, changed targets, and unsuccessful insertion", () => {
    const plan = getPlan(request("$1", [
      { kind: "pad", offset: 2, driverTabstop: 1, fill: "-", targetWidth: 10 },
    ]));
    const event = observedEvent([{ rangeOffset: 10, rangeLength: 2, text: "x" }]);
    const observation_oid = [
      {
        insertionSucceeded: false,
        targetDocumentUri: "file:///target.txt",
        targetDocumentVersion: 8,
        event,
        eventAmbiguousOrOverflow: false,
      },
      {
        insertionSucceeded: true,
        targetDocumentUri: "file:///other.txt",
        targetDocumentVersion: 8,
        event,
        eventAmbiguousOrOverflow: false,
      },
      {
        insertionSucceeded: true,
        targetDocumentUri: "file:///target.txt",
        targetDocumentVersion: 9,
        event,
        eventAmbiguousOrOverflow: false,
      },
    ];

    for (const observation of observation_oid) {
      assert.equal(finalizeInsertionCapture(plan, observation).success, false);
    }
  });

  it("bounds the pad and snippet-instance product", () => {
    const pad_pid: CompiledPadMetadata[] = [
      { kind: "pad", offset: 2, driverTabstop: 1, fill: "-", targetWidth: 10 },
      { kind: "pad", offset: 2, driverTabstop: 1, fill: ".", targetWidth: 20 },
    ];
    const replacement_rid = Array.from(
      { length: Math.floor(MAX_TRACKED_PADS_PER_SESSION / 2) + 1 },
      (_, index) => ({ rangeOffset: index * 2, rangeLength: 1 }),
    );
    const result = createInsertionCapturePlan(request("$1", pad_pid, replacement_rid));

    assert.equal(result.success, false);
    assert.match(result.reason, /tracked-pad limit/u);
  });

  it("accepts the conservative rendered-code-unit boundary and rejects one code unit over", () => {
    const instanceCount = 8;
    const bodyLength = MAX_PLANNED_RENDERED_CODE_UNITS / (instanceCount * 2);
    assert.equal(Number.isInteger(bodyLength), true);
    const bodyAtLimit = `$1${"x".repeat(bodyLength - 2)}`;
    const replacement_rid = Array.from(
      { length: instanceCount },
      (_, index) => ({ rangeOffset: index, rangeLength: 0 }),
    );

    const atLimit = createInsertionCapturePlan(request(bodyAtLimit, [
      { kind: "pad", offset: bodyAtLimit.length, driverTabstop: 1, fill: "-", targetWidth: 10 },
    ], replacement_rid));
    const overLimitBody = `${bodyAtLimit}x`;
    const overLimit = createInsertionCapturePlan(request(overLimitBody, [
      { kind: "pad", offset: overLimitBody.length, driverTabstop: 1, fill: "-", targetWidth: 10 },
    ], replacement_rid));

    assert.equal(atLimit.success, true, atLimit.success ? undefined : atLimit.reason);
    assert.equal(overLimit.success, false);
    assert.match(overLimit.reason, /planned-rendering limit/u);
  });

  it("includes target EOL, indent-size tab, and insertion-indent amplification in the render bound", () => {
    const normalizedBody = `$1${"\n\t".repeat(55_000)}`;
    const normalizedRequest = request(normalizedBody, [
      {
        kind: "pad",
        offset: normalizedBody.length,
        driverTabstop: 1,
        fill: "-",
        targetWidth: 10,
      },
    ]);
    const normalizedResult = createInsertionCapturePlan({
      ...normalizedRequest,
      replacement_rid: normalizedRequest.replacement_rid.map((replacement) => ({
        ...replacement,
        targetEolWidth: 2,
        indentSize: 8,
      })),
    });

    const indentRequest = request("$1", [
      { kind: "pad", offset: 2, driverTabstop: 1, fill: "-", targetWidth: 10 },
    ]);
    const indentResult = createInsertionCapturePlan({
      ...indentRequest,
      replacement_rid: indentRequest.replacement_rid.map((replacement) => ({
        ...replacement,
        insertionIndent: " ".repeat(MAX_INSERTION_INDENT_CODE_UNITS),
      })),
    });

    for (const result of [normalizedResult, indentResult]) {
      assert.equal(result.success, false);
      assert.match(result.reason, /planned-rendering limit/u);
    }
  });

  it("uses indentSize for the conservative tab-expansion boundary regardless of insertSpaces", () => {
    const body = "$1\t";
    const base = request(body, [
      { kind: "pad", offset: body.length, driverTabstop: 1, fill: "-", targetWidth: 10 },
    ]);

    for (const insertSpaces of [true, false]) {
      const atLimit = createInsertionCapturePlan({
        ...base,
        replacement_rid: [{
          ...base.replacement_rid[0]!,
          indentSize: MAX_PLANNED_RENDERED_CODE_UNITS / 2 - 2,
          insertSpaces,
        }],
      });
      const overLimit = createInsertionCapturePlan({
        ...base,
        replacement_rid: [{
          ...base.replacement_rid[0]!,
          indentSize: MAX_PLANNED_RENDERED_CODE_UNITS / 2 - 1,
          insertSpaces,
        }],
      });

      assert.equal(atLimit.success, true, atLimit.success ? undefined : atLimit.reason);
      assert.equal(overLimit.success, false);
      assert.match(overLimit.reason, /planned-rendering limit/u);
    }
  });

  it("rejects malformed or unbounded replacement rendering contexts", () => {
    const base = request("$1", [
      { kind: "pad", offset: 2, driverTabstop: 1, fill: "-", targetWidth: 10 },
    ]);
    const invalidContext_cid = [
      { targetEolWidth: 3 },
      { indentSize: 0 },
      { indentSize: 1.5 },
      { indentSize: MAX_RENDERING_INDENT_SIZE + 1 },
      { indentSize: Number.MAX_SAFE_INTEGER },
      { indentSize: "tabSize" },
      { indentSize: undefined },
      { insertSpaces: "auto" },
      { insertSpaces: undefined },
      { insertionIndent: " x" },
      { insertionIndent: " ".repeat(MAX_INSERTION_INDENT_CODE_UNITS + 1) },
    ];

    for (const invalidContext of invalidContext_cid) {
      const result = createInsertionCapturePlan({
        ...base,
        replacement_rid: [{ ...base.replacement_rid[0]!, ...invalidContext }],
      } as InsertionCapturePlanRequest);
      assert.equal(result.success, false);
      assert.match(result.reason, /rendering context/u);
    }
  });

  it("rejects placeholder-default and mirrored-output amplification", () => {
    const body = `\${1:${"x".repeat(90_000)}}${"$1".repeat(4_095)}`;
    assert.ok(body.length < 100_000);
    assert.ok(body.length < MAX_PLANNED_RENDERED_CODE_UNITS);

    const result = createInsertionCapturePlan(request(body, [
      { kind: "pad", offset: body.length, driverTabstop: 1, fill: "-", targetWidth: 10 },
    ]));

    assert.equal(result.success, false);
    assert.match(result.reason, /planned-rendering limit/u);
  });

  it("rejects global zero-width transform and repeated-capture amplification", () => {
    const repeatedCaptures = "$1".repeat(100);
    const body = `\${1:${"x".repeat(1_000)}}\${1/(?=)/${repeatedCaptures}/g}`;
    assert.ok(body.length < MAX_PLANNED_RENDERED_CODE_UNITS);

    const result = createInsertionCapturePlan(request(body, [
      { kind: "pad", offset: body.length, driverTabstop: 1, fill: "-", targetWidth: 10 },
    ]));

    assert.equal(result.success, false);
    assert.match(result.reason, /planned-rendering limit/u);
  });

  it("keeps the transformed-mirror fixture within the conservative rendering bound", () => {
    const body = "Transform: ${1:value} -> ${1/(.*)/${1:/upcase}/}\nNext: ${2:next}\n$0";
    const result = createInsertionCapturePlan(request(body, [
      { kind: "pad", offset: 51, driverTabstop: 1, fill: "~", targetWidth: 32 },
    ]));

    assert.equal(result.success, true, result.success ? undefined : result.reason);
  });

  it("keeps pad spellings in transform regex and replacement contexts opaque", () => {
    const body = "${1/[${pad:name}]/${pad}-\\${pad}/}";
    const result = createInsertionCapturePlan(request(body, [{
      kind: "pad",
      offset: body.length,
      driverTabstop: 1,
      fill: "-",
      targetWidth: 20,
    }]));

    assert.equal(result.success, true, result.success ? undefined : result.reason);
  });

  it("rejects forged numeric tabstop spans containing actual line breaks", () => {
    for (const body of [
      "${1:line\nbreak}",
      "${1:line\r\nbreak}",
      "${1/(.*)/$1\n/}\n${1:mirrored\ndefault}",
    ]) {
      const result = createInsertionCapturePlan(request(body, [
        { kind: "pad", offset: body.length, driverTabstop: 1, fill: "-", targetWidth: 10 },
      ]));

      assert.equal(result.success, false, JSON.stringify(body));
      assert.match(result.reason, /CR or LF.*numeric tab stop spans/iu, JSON.stringify(body));
    }
  });

  it("bounds forged overlapping positive and zero span validation near the body limit", { timeout: 5_000 }, () => {
    const nestingCount = 19_998;
    for (const [number, expectedReason] of [
      [1, /tracked-selection limit/u],
      [0, /planned-rendering limit/u],
    ] as const) {
      const finalDriver = number === 0 ? "$1" : "";
      const body = `${`\${${number}:`.repeat(nestingCount)}x${"}".repeat(nestingCount)}${finalDriver}`;
      const result = createInsertionCapturePlan(request(body, [{
        kind: "pad",
        offset: body.length,
        driverTabstop: 1,
        fill: "-",
        targetWidth: 20,
      }]));

      assert.ok(body.length < 100_000);
      assert.equal(result.success, false);
      assert.match(result.reason, expectedReason);
    }
  });

  it("fails closed within the syntax budget for repeated malformed format probes", { timeout: 5_000 }, () => {
    const repeatedProbe = "${1:+".repeat(15_000);
    for (const prefix of [
      "${1/[${pad}]/",
      "${1/a/${pad:name}-",
      "${1/a/\\${pad}-",
    ]) {
      const body = `${prefix}${repeatedProbe}\\q/}`;
      const result = createInsertionCapturePlan(request(body, [{
        kind: "pad",
        offset: body.length,
        driverTabstop: 1,
        fill: "-",
        targetWidth: 20,
      }]));

      assert.ok(body.length < 100_000);
      assert.equal(result.success, false, prefix);
      assert.match(result.reason, /syntax is malformed/u, prefix);
    }
  });

  it("rejects forged lone-CR bodies while accepting CRLF bodies", () => {
    const loneCrBody = "$1\rnext";
    const loneCr = createInsertionCapturePlan(request(loneCrBody, [
      { kind: "pad", offset: 2, driverTabstop: 1, fill: "-", targetWidth: 10 },
    ]));
    const crlfBody = "$1\r\n$0";
    const crlf = createInsertionCapturePlan(request(crlfBody, [
      { kind: "pad", offset: 2, driverTabstop: 1, fill: "-", targetWidth: 10 },
    ]));

    assert.equal(loneCr.success, false);
    assert.match(loneCr.reason, /Lone CR.*LF or CRLF/iu);
    assert.equal(crlf.success, true, crlf.success ? undefined : crlf.reason);
  });

  it("rejects forged adjacent distinct groups while preserving same-ID mirrors", () => {
    for (const body of [
      "$1$2",
      "${1:first}${2:second}",
      "${1/(.*)/$1/}${2:value}",
    ]) {
      const result = createInsertionCapturePlan(request(body, [
        { kind: "pad", offset: body.length, driverTabstop: 2, fill: "-", targetWidth: 10 },
      ]));
      assert.equal(result.success, false, body);
      assert.match(result.reason, /source-adjacent.*different identifiers/iu, body);
    }

    const mirroredBody = "$1${1:value}";
    const mirrored = createInsertionCapturePlan(request(mirroredBody, [
      {
        kind: "pad",
        offset: mirroredBody.length,
        driverTabstop: 1,
        fill: "-",
        targetWidth: 10,
      },
    ]));
    assert.equal(mirrored.success, true, mirrored.success ? undefined : mirrored.reason);
  });

  it("bounds aggregate gaps and verifies ranges against the target document", () => {
    const pad: CompiledPadMetadata = {
      kind: "pad",
      offset: 2,
      driverTabstop: 1,
      fill: "-",
      targetWidth: 10,
    };
    const atBoundaryRequest = request("$1", [pad], [
      { rangeOffset: 0, rangeLength: 0 },
      { rangeOffset: MAX_AGGREGATE_REPLACEMENT_GAP_CODE_UNITS, rangeLength: 0 },
    ]);
    const atBoundary = createInsertionCapturePlan({
      ...atBoundaryRequest,
      targetDocumentLength: MAX_AGGREGATE_REPLACEMENT_GAP_CODE_UNITS,
    });
    const overBoundaryRequest = request("$1", [pad], [
      { rangeOffset: 0, rangeLength: 0 },
      { rangeOffset: MAX_AGGREGATE_REPLACEMENT_GAP_CODE_UNITS + 1, rangeLength: 0 },
    ]);
    const overBoundary = createInsertionCapturePlan({
      ...overBoundaryRequest,
      targetDocumentLength: MAX_AGGREGATE_REPLACEMENT_GAP_CODE_UNITS + 1,
    });
    const outsideRequest = request("$1", [pad], [{ rangeOffset: 8, rangeLength: 2 }]);
    const outside = createInsertionCapturePlan({ ...outsideRequest, targetDocumentLength: 9 });
    const exactEnd = createInsertionCapturePlan({ ...outsideRequest, targetDocumentLength: 10 });

    assert.equal(atBoundary.success, true, atBoundary.success ? undefined : atBoundary.reason);
    assert.equal(overBoundary.success, false);
    assert.match(overBoundary.reason, /document-gap limit/u);
    assert.equal(outside.success, false);
    assert.match(outside.reason, /outside the target document/u);
    assert.equal(exactEnd.success, true, exactEnd.success ? undefined : exactEnd.reason);
  });

  it("rejects shared starts, overlaps, and unsafe document lengths", () => {
    const pad: CompiledPadMetadata = {
      kind: "pad",
      offset: 2,
      driverTabstop: 1,
      fill: "-",
      targetWidth: 10,
    };
    for (const replacement_rid of [
      [{ rangeOffset: 2, rangeLength: 0 }, { rangeOffset: 2, rangeLength: 1 }],
      [{ rangeOffset: 2, rangeLength: 3 }, { rangeOffset: 4, rangeLength: 0 }],
    ]) {
      const result = createInsertionCapturePlan(request("$1", [pad], replacement_rid));
      assert.equal(result.success, false);
      assert.match(result.reason, /overlap or share a start/u);
    }

    const valid = request("$1", [pad]);
    const unsafeLength = createInsertionCapturePlan({
      ...valid,
      targetDocumentLength: Number.MAX_SAFE_INTEGER + 1,
    });
    assert.equal(unsafeLength.success, false);
    assert.match(unsafeLength.reason, /document length is invalid/u);
  });

  it("rejects forged dynamic capture plans containing complete choices", () => {
    for (const body of [
      "${7|${pad},${pad:name},\\${pad}|}\n${2:z}\n${3|p,q|}$7$0",
      "${1:outer ${2|x,y|}}",
    ]) {
      const result = createInsertionCapturePlan(request(body, [
        { kind: "pad", offset: body.length, driverTabstop: body.startsWith("${7") ? 7 : 1, fill: "-", targetWidth: 10 },
      ]));

      assert.equal(result.success, false, body);
      assert.match(result.reason, /choice UI navigation cannot be safely observed/u, body);
    }
  });

  it("keeps malformed choice pad text opaque at insertion validation", () => {
    for (const body of [
      "${1|,${pad},${pad:name}|}$1",
      "${1|,\\${pad},\\${pad:name}|}$1",
      "${1|,${pad},${pad:name}}${pad:real}$1",
    ]) {
      const result = createInsertionCapturePlan(request(body, [{
        kind: "pad",
        offset: body.length,
        driverTabstop: 1,
        fill: "-",
        targetWidth: 20,
      }]));

      assert.equal(result.success, false, body);
      assert.match(result.reason, /syntax is malformed/u, body);
    }
  });

  it("rejects native variables defensively in dynamic capture plans", () => {
    for (const body of [
      "$TM_FILENAME $1",
      "${TM_FILENAME} $1",
      "${TM_FILENAME:fallback} $1",
      "${TM_FILENAME/(.*)/$1/} $2",
    ]) {
      const driverTabstop = body.endsWith("$2") ? 2 : 1;
      const result = createInsertionCapturePlan(request(body, [
        {
          kind: "pad",
          offset: body.length,
          driverTabstop,
          fill: "-",
          targetWidth: 10,
        },
      ]));
      assert.equal(result.success, false, body);
      assert.match(result.reason, /native variables/iu, body);
    }
  });

  it("bounds aggregate observed change text at the code-unit boundary", () => {
    const plan = getPlan(request("$1", [
      { kind: "pad", offset: 2, driverTabstop: 1, fill: "-", targetWidth: 10 },
    ], [
      { rangeOffset: 10, rangeLength: 2 },
      { rangeOffset: 20, rangeLength: 2 },
    ]));
    const firstText = "x".repeat(Math.floor(MAX_RETAINED_OBSERVED_CHANGE_TEXT_CODE_UNITS / 2));
    const secondText = "y".repeat(
      MAX_RETAINED_OBSERVED_CHANGE_TEXT_CODE_UNITS - firstText.length,
    );
    const baseChange_cid = [
      { rangeOffset: 10, rangeLength: 2, text: firstText },
      { rangeOffset: 20, rangeLength: 2, text: secondText },
    ] as const;
    const atLimit = finalizeInsertionCapture(plan, {
      insertionSucceeded: true,
      targetDocumentUri: "file:///target.txt",
      targetDocumentVersion: 8,
      event: observedEvent(baseChange_cid),
      eventAmbiguousOrOverflow: false,
    });
    const overLimit = finalizeInsertionCapture(plan, {
      insertionSucceeded: true,
      targetDocumentUri: "file:///target.txt",
      targetDocumentVersion: 8,
      event: observedEvent([
        baseChange_cid[0],
        { ...baseChange_cid[1], text: `${baseChange_cid[1].text}z` },
      ]),
      eventAmbiguousOrOverflow: false,
    });

    assert.equal(atLimit.success, true, atLimit.success ? undefined : atLimit.reason);
    assert.equal(overLimit.success, false);
    assert.match(overLimit.reason, /capture limit/u);
  });

  it("rejects replacement-end and generated-anchor integer overflow", () => {
    const pad: CompiledPadMetadata = {
      kind: "pad",
      offset: 2,
      driverTabstop: 1,
      fill: "-",
      targetWidth: 10,
    };
    const unsafeRange = createInsertionCapturePlan(request("$1", [pad], [{
      rangeOffset: Number.MAX_SAFE_INTEGER,
      rangeLength: 1,
    }]));
    assert.equal(unsafeRange.success, false);
    assert.match(unsafeRange.reason, /replacement range is invalid/u);

    const plan = getPlan(request("$1", [pad], [{
      rangeOffset: Number.MAX_SAFE_INTEGER,
      rangeLength: 0,
    }]));
    const unsafeAnchor = finalizeInsertionCapture(plan, {
      insertionSucceeded: true,
      targetDocumentUri: "file:///target.txt",
      targetDocumentVersion: 8,
      event: observedEvent([{
        rangeOffset: Number.MAX_SAFE_INTEGER,
        rangeLength: 0,
        text: "x",
      }]),
      eventAmbiguousOrOverflow: false,
    });
    assert.equal(unsafeAnchor.success, false);
    assert.match(unsafeAnchor.reason, /pad line could not be located/u);

    const terminalPlan = getPlan(request("$1\n", [pad], [{
      rangeOffset: Number.MAX_SAFE_INTEGER,
      rangeLength: 0,
    }]));
    const unsafeTerminal = finalizeInsertionCapture(terminalPlan, {
      insertionSucceeded: true,
      targetDocumentUri: "file:///target.txt",
      targetDocumentVersion: 8,
      event: observedEvent([{
        rangeOffset: Number.MAX_SAFE_INTEGER,
        rangeLength: 0,
        text: "\nx",
      }]),
      eventAmbiguousOrOverflow: false,
    });
    assert.equal(unsafeTerminal.success, false);
    assert.match(unsafeTerminal.reason, /terminal endpoint.*safe offset/iu);
  });

  it("rejects unsafe numeric tabstops instead of retaining rounded IDs", () => {
    const result = createInsertionCapturePlan(request("$9007199254740992", [
      { kind: "pad", offset: 17, driverTabstop: 1, fill: "-", targetWidth: 10 },
    ]));

    assert.equal(result.success, false);
    assert.match(result.reason, /unsafe numeric tabstop/u);
  });

  it("bounds the number of tracked tabstop identifiers", () => {
    const body = Array.from(
      { length: MAX_TRACKED_TABSTOPS_PER_SESSION + 1 },
      (_, index) => `$${index + 1}`,
    ).join(" ");
    const result = createInsertionCapturePlan(request(body, [
      { kind: "pad", offset: body.length, driverTabstop: 1, fill: "-", targetWidth: 10 },
    ]));

    assert.equal(result.success, false);
    assert.match(result.reason, /tracked-tabstop limit/u);
  });

  it("bounds unique and mirrored tabstop selections across snippet instances", () => {
    const replacement_rid = [
      { rangeOffset: 2, rangeLength: 0 },
      { rangeOffset: 4, rangeLength: 0 },
    ];
    const perInstanceLimit = MAX_TRACKED_SELECTION_RANGES_PER_SESSION / 2;
    const uniqueBody = Array.from(
      { length: perInstanceLimit + 1 },
      (_, index) => `$${index + 1}`,
    ).join(" ");
    const mirroredBody = Array.from({ length: perInstanceLimit + 1 }, () => "$1").join(" ");

    for (const body of [uniqueBody, mirroredBody]) {
      const result = createInsertionCapturePlan(request(body, [
        { kind: "pad", offset: body.length, driverTabstop: 1, fill: "-", targetWidth: 10 },
      ], replacement_rid));
      assert.equal(result.success, false);
      assert.match(result.reason, /tracked-selection limit/u);
    }
  });

  it("bounds generated edits against pads and remembered mirrored selections", () => {
    const replacement_rid = Array.from(
      { length: 8 },
      (_, index) => ({ rangeOffset: index, rangeLength: 0 }),
    );
    const createDriverRequest = (
      padCount: number,
      nextTabstopOccurrenceCount = 0,
      terminalAtEnd = false,
    ): InsertionCapturePlanRequest => {
      const driverBody = Array.from({ length: padCount }, () => "$1").join("\n");
      const positiveBody = nextTabstopOccurrenceCount === 0
        ? driverBody
        : `${driverBody}\n${"$2".repeat(nextTabstopOccurrenceCount)}`;
      const body = terminalAtEnd ? positiveBody : `${positiveBody}\n$0 trailing`;
      const pad_pid = Array.from({ length: padCount }, (_, index): CompiledPadMetadata => ({
        kind: "pad",
        offset: index * 3 + 2,
        driverTabstop: 1,
        fill: "-",
        targetWidth: 10,
      }));
      return request(body, pad_pid, replacement_rid);
    };

    const atBoundary = createInsertionCapturePlan(createDriverRequest(64, 128));
    const overBoundary = createInsertionCapturePlan(createDriverRequest(64, 129));
    const documentedMaximum = createInsertionCapturePlan(createDriverRequest(128));
    const withTerminalEndpoints = createInsertionCapturePlan(createDriverRequest(64, 128, true));

    assert.equal(64 * 8 * (64 * 8 + (64 + 128) * 8), MAX_OFFSET_TRACKING_WORK);
    assert.equal(64 * 8 * (64 * 8 + (64 + 129) * 8) > MAX_OFFSET_TRACKING_WORK, true);
    assert.equal(atBoundary.success, true, atBoundary.success ? undefined : atBoundary.reason);
    assert.equal(64 * 8 * (64 * 8 + (64 + 128) * 8 + 8) > MAX_OFFSET_TRACKING_WORK, true);
    for (const result of [overBoundary, documentedMaximum, withTerminalEndpoints]) {
      assert.equal(result.success, false);
      assert.match(result.reason, /offset-tracking workload limit/u);
    }
  });

  it("rejects malformed compiled pad configuration metadata", () => {
    for (const pad of [
      { kind: "pad", offset: 2, driverTabstop: 1, fill: "", targetWidth: 10 },
      { kind: "pad", offset: 2, driverTabstop: 1, fill: "\t", targetWidth: 10 },
      { kind: "pad", offset: 2, driverTabstop: 1, fill: "a\nb", targetWidth: 10 },
      { kind: "pad", offset: 2, driverTabstop: 1, fill: "-", targetWidth: 10_001 },
      {
        kind: "pad",
        offset: 2,
        driverTabstop: 1,
        fill: "-",
        targetWidth: 10,
        configurationName: "not.valid",
      },
    ] as const) {
      const result = createInsertionCapturePlan(request("$1", [pad]));
      assert.equal(result.success, false);
      assert.match(result.reason, /invalid configuration/u);
    }
  });
});
