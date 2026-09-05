import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  MAX_PAD_TARGET_WIDTH,
  MAX_PREFIXES_PER_SNIPPET,
  MAX_SNIPPET_BODY_LENGTH,
  MAX_SNIPPET_BODY_LINES,
  MAX_SNIPPET_PREFIX_LENGTH,
  compileSnippetDefinitions,
  parseSnippetDefinitions,
} from "../../src/core/index.js";

describe("snippet validation and compilation", () => {
  it("compiles native-style arrays and removes one pad token", () => {
    const result = compileSnippetDefinitions({
      Heading: {
        prefix: ["h1", "heading"],
        body: ["## $1${pad}", "$0"],
        description: "Heading",
        scope: ["markdown", "julia"],
        pad: { fill: "-", targetWidth: 20 },
      },
    });

    assert.deepEqual(result.issue_iid, []);
    assert.deepEqual(result.snippet_sid, [{
      name: "Heading",
      prefix: ["h1", "heading"],
      body: "## $1\n$0",
      description: "Heading",
      scope: ["markdown", "julia"],
      pad: { kind: "pad", offset: 5, driverTabstop: 1, fill: "-", targetWidth: 20 },
    }]);
  });

  it("supports all immediate driver forms", () => {
    for (const driver of ["$1", "${1}", "${1:default}", "${1|one,two|}"]) {
      const result = compileSnippetDefinitions({
        Example: { prefix: "x", body: `${driver}\${pad}`, pad: { fill: ".", targetWidth: 8 } },
      });
      assert.equal(result.issue_iid.length, 0, driver);
      assert.equal(result.snippet_sid[0]?.body, driver, driver);
      assert.equal(result.snippet_sid[0]?.pad?.driverTabstop, 1, driver);
    }
  });

  it("does not treat transform capture references as editable tab stops", () => {
    for (const transform of [
      "${TM_FILENAME/(.*)/$1/}",
      "${TM_FILENAME/[}]/$1/}",
      "${1/(.*)/${1:/upcase}/}",
    ]) {
      const result = compileSnippetDefinitions({
        Example: {
          prefix: "x",
          body: `${transform} $2\${pad}`,
          pad: { fill: ".", targetWidth: 20 },
        },
      });
      assert.equal(result.issue_iid.length, 0, transform);
      assert.equal(result.snippet_sid[0]?.pad?.driverTabstop, 2, transform);
    }
  });

  it("supports a balanced nested placeholder default", () => {
    const result = compileSnippetDefinitions({
      Nested: {
        prefix: "nested",
        body: "${1:before ${2:inside {braces}} after}${pad} $0",
        pad: { fill: " ", targetWidth: 60 },
      },
    });

    assert.equal(result.issue_iid.length, 0);
    assert.equal(result.snippet_sid[0]?.body, "${1:before ${2:inside {braces}} after} $0");
    assert.equal(result.snippet_sid[0]?.pad?.offset, 38);
  });

  it("keeps escaped pad syntax native and warns about unused config", () => {
    const result = compileSnippetDefinitions({
      Literal: {
        prefix: "literal",
        body: String.raw`$1\${pad}`,
        pad: { fill: "-", targetWidth: 10 },
      },
    });

    assert.equal(result.snippet_sid[0]?.body, String.raw`$1\${pad}`);
    assert.equal(result.snippet_sid[0]?.pad, undefined);
    assert.equal(result.issue_iid.length, 1);
    assert.equal(result.issue_iid[0]?.severity, "warning");
  });

  it("treats an even number of preceding backslashes as an active pad", () => {
    const result = compileSnippetDefinitions({
      Active: {
        prefix: "active",
        body: "$1\\\\${pad}",
        pad: { fill: "-", targetWidth: 10 },
      },
    });

    assert.equal(result.issue_iid.length, 1);
    assert.match(result.issue_iid[0]?.message ?? "", /immediately follow/u);
  });

  it("rejects missing configuration, multiple pads, and invalid placement", () => {
    const missing = compileSnippetDefinitions({
      Missing: { prefix: "x", body: "$1${pad}" },
    });
    assert.equal(missing.snippet_sid.length, 0);
    assert.match(missing.issue_iid[0]?.message ?? "", /requires/u);

    const multiple = compileSnippetDefinitions({
      Multiple: {
        prefix: "x",
        body: "$1${pad} ${pad}",
        pad: { fill: "-", targetWidth: 10 },
      },
    });
    assert.equal(multiple.snippet_sid.length, 0);
    assert.match(multiple.issue_iid[0]?.message ?? "", /at most one/u);

    const separated = compileSnippetDefinitions({
      Separated: {
        prefix: "x",
        body: "$1 ${pad}",
        pad: { fill: "-", targetWidth: 10 },
      },
    });
    assert.equal(separated.snippet_sid.length, 0);
    assert.match(separated.issue_iid[0]?.message ?? "", /immediately follow/u);
  });

  it("requires the first editable tab stop to occur exactly once", () => {
    const notFirst = compileSnippetDefinitions({
      Example: {
        prefix: "x",
        body: "$1 $2${pad}",
        pad: { fill: "-", targetWidth: 10 },
      },
    });
    assert.match(notFirst.issue_iid[0]?.message ?? "", /first editable/u);

    const mirrored = compileSnippetDefinitions({
      Example: {
        prefix: "x",
        body: "$1${pad} and ${1}",
        pad: { fill: "-", targetWidth: 10 },
      },
    });
    assert.match(mirrored.issue_iid[0]?.message ?? "", /exactly once/u);

    const finalStop = compileSnippetDefinitions({
      Example: {
        prefix: "x",
        body: "$0${pad}",
        pad: { fill: "-", targetWidth: 10 },
      },
    });
    assert.match(finalStop.issue_iid[0]?.message ?? "", /positive numeric/u);
  });

  it("reports malformed top-level and snippet fields with paths", () => {
    const topLevel = parseSnippetDefinitions([]);
    assert.equal(topLevel.snippet_sid.length, 0);
    assert.equal(topLevel.issue_iid[0]?.path, "$");
    assert.equal(topLevel.issue_iid[0]?.snippetName, undefined);

    const malformed = parseSnippetDefinitions({
      Broken: {
        prefix: ["ok", ""],
        body: [],
        description: 4,
        scope: ["markdown", 3],
        pad: { fill: "🙂", targetWidth: MAX_PAD_TARGET_WIDTH + 1 },
      },
      AlsoBroken: null,
    });
    assert.equal(malformed.snippet_sid.length, 0);
    assert.ok(malformed.issue_iid.length >= 6);
    assert.ok(malformed.issue_iid.every((entry) => entry.severity === "error"));
    assert.ok(malformed.issue_iid.some((entry) => entry.path.endsWith(".pad.fill")));
    assert.ok(malformed.issue_iid.some((entry) => entry.path.endsWith(".pad.targetWidth")));
    assert.ok(malformed.issue_iid.some((entry) => entry.snippetName === "AlsoBroken"));
  });

  it("rejects scopes that normalize to no language IDs", () => {
    for (const scope of ["   ", ", ,", ["julia", " , "]]) {
      const result = parseSnippetDefinitions({
        InvalidScope: { prefix: "x", body: "$1", scope },
      });
      assert.equal(result.snippet_sid.length, 0);
      assert.match(result.issue_iid[0]?.message ?? "", /language ID/u);
    }
  });

  it("bounds prefix length for completion matching", () => {
    const result = parseSnippetDefinitions({
      TooLong: {
        prefix: "x".repeat(MAX_SNIPPET_PREFIX_LENGTH + 1),
        body: "$1",
      },
    });
    assert.equal(result.snippet_sid.length, 0);
    assert.match(result.issue_iid[0]?.message ?? "", /no more than/u);
  });

  it("bounds prefix cardinality and body size", () => {
    const tooManyPrefixes = parseSnippetDefinitions({
      TooManyPrefixes: {
        prefix: Array.from({ length: MAX_PREFIXES_PER_SNIPPET + 1 }, (_, index) => `p${index}`),
        body: "$1",
      },
    });
    assert.equal(tooManyPrefixes.snippet_sid.length, 0);
    assert.match(tooManyPrefixes.issue_iid[0]?.message ?? "", /at most/u);

    const tooLongBody = parseSnippetDefinitions({
      TooLongBody: {
        prefix: "x",
        body: "x".repeat(MAX_SNIPPET_BODY_LENGTH + 1),
      },
      TooManyLines: {
        prefix: "y",
        body: Array.from({ length: MAX_SNIPPET_BODY_LINES + 1 }, () => ""),
      },
    });
    assert.equal(tooLongBody.snippet_sid.length, 0);
    assert.equal(tooLongBody.issue_iid.length, 2);
  });

  it("accepts an unused valid pad configuration with a warning", () => {
    const result = compileSnippetDefinitions({
      Native: { prefix: "n", body: "plain $1", pad: { fill: "-", targetWidth: 10 } },
    });
    assert.equal(result.snippet_sid.length, 1);
    assert.equal(result.issue_iid[0]?.severity, "warning");
  });
});
