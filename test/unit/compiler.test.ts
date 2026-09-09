import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  MAX_ISSUE_MESSAGE_LENGTH,
  MAX_ISSUE_PATH_LENGTH,
  MAX_NAMED_PAD_CONFIGURATIONS,
  MAX_PAD_CONFIGURATION_PROPERTIES,
  MAX_PADS_PER_SNIPPET,
  MAX_PAD_TARGET_WIDTH,
  MAX_PREFIXES_PER_SNIPPET,
  MAX_SCOPE_IDS_PER_SNIPPET,
  MAX_SCOPE_TEXT_LENGTH_PER_SNIPPET,
  MAX_SEMANTIC_ISSUES_PER_SOURCE,
  MAX_SEMANTIC_ISSUE_TEXT_LENGTH,
  MAX_SNIPPET_BODY_LENGTH,
  MAX_SNIPPET_BODY_LINES,
  MAX_SNIPPET_DEFINITION_PROPERTIES,
  MAX_SNIPPET_NAME_LENGTH,
  MAX_SNIPPET_PREFIX_LENGTH,
  compileSnippet,
  compileSnippetDefinitions,
  limitSemanticIssues,
  parseSnippetDefinitions,
} from "../../src/core/index.js";

describe("snippet validation and compilation", () => {
  it("preserves default pad compatibility while emitting ordered metadata", () => {
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
      pad_pid: [{ kind: "pad", offset: 5, driverTabstop: 1, fill: "-", targetWidth: 20 }],
    }]);
  });

  it("supports all numeric driver forms", () => {
    for (const driver of ["$1", "${1}", "${1:default}"]) {
      const result = compileSnippetDefinitions({
        Example: { prefix: "x", body: `${driver}\${pad}`, pad: { fill: ".", targetWidth: 8 } },
      });
      assert.equal(result.issue_iid.length, 0, driver);
      assert.equal(result.snippet_sid[0]?.body, driver, driver);
      assert.equal(result.snippet_sid[0]?.pad_pid?.[0]?.driverTabstop, 1, driver);
    }
  });

  it("compiles multiple named pads and adjusts later UTF-16 offsets", () => {
    const result = compileSnippetDefinitions({
      Named: {
        prefix: "named",
        body: "🙂 $1 label${pad:left}\nB ${2:word}${pad:right}\n$0",
        pads: {
          left: { fill: "-", targetWidth: 20 },
          right: { fill: ".", targetWidth: 30 },
        },
      },
    });

    assert.deepEqual(result.issue_iid, []);
    assert.equal(result.snippet_sid[0]?.body, "🙂 $1 label\nB ${2:word}\n$0");
    assert.deepEqual(result.snippet_sid[0]?.pad_pid, [
      {
        kind: "pad",
        offset: 11,
        driverTabstop: 1,
        fill: "-",
        targetWidth: 20,
        configurationName: "left",
      },
      {
        kind: "pad",
        offset: 23,
        driverTabstop: 2,
        fill: ".",
        targetWidth: 30,
        configurationName: "right",
      },
    ]);
  });

  it("mixes default and named pads", () => {
    const result = compileSnippetDefinitions({
      Mixed: {
        prefix: "mixed",
        body: "$1 default${pad}\n$2 named${pad:rule}",
        pad: { fill: " ", targetWidth: 20 },
        pads: { rule: { fill: "-", targetWidth: 30 } },
      },
    });

    assert.deepEqual(result.issue_iid, []);
    assert.equal(result.snippet_sid[0]?.body, "$1 default\n$2 named");
    assert.deepEqual(
      result.snippet_sid[0]?.pad_pid?.map((pad) => pad.configurationName),
      [undefined, "rule"],
    );
  });

  it("preserves multi-character fills in default and named pad metadata", () => {
    const result = compileSnippetDefinitions({
      Patterned: {
        prefix: "patterned",
        body: "$1${pad}\n$2${pad:rule}",
        pad: { fill: "- ", targetWidth: 20 },
        pads: { rule: { fill: "🙂.", targetWidth: 30 } },
      },
    });

    assert.deepEqual(result.issue_iid, []);
    assert.deepEqual(
      result.snippet_sid[0]?.pad_pid?.map((pad) => pad.fill),
      ["- ", "🙂."],
    );
  });

  it("uses literal separation and the nearest preceding tab stop", () => {
    const result = compileSnippetDefinitions({
      Nearest: {
        prefix: "nearest",
        body: "$1 then ${2:near} literal text${pad}",
        pad: { fill: "-", targetWidth: 40 },
      },
    });

    assert.deepEqual(result.issue_iid, []);
    assert.equal(result.snippet_sid[0]?.body, "$1 then ${2:near} literal text");
    assert.equal(result.snippet_sid[0]?.pad_pid?.[0]?.driverTabstop, 2);
  });

  it("allows mirrored driver IDs and pads driven by the same number", () => {
    const result = compileSnippetDefinitions({
      Mirrored: {
        prefix: "mirrored",
        body: "$1 first${pad:a}\nmirror ${1} second${pad:b}",
        pads: {
          a: { fill: "-", targetWidth: 20 },
          b: { fill: ".", targetWidth: 20 },
        },
      },
    });

    assert.deepEqual(result.issue_iid, []);
    assert.deepEqual(
      result.snippet_sid[0]?.pad_pid?.map((pad) => pad.driverTabstop),
      [1, 1],
    );
  });

  it("does not treat transform capture references as editable tab stops", () => {
    for (const transform of [
      "${1/(.*)/$1/}",
      "${1/[}]/$1/}",
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
      assert.equal(result.snippet_sid[0]?.pad_pid?.[0]?.driverTabstop, 2, transform);
    }
  });

  it("uses standalone and mirrored numeric transforms as pad drivers", () => {
    for (const body of [
      "${1/(.*)/$1/}${pad}",
      "${1:source} mirror ${1/(.*)/${1:/upcase}/}${pad}",
    ]) {
      const result = compileSnippetDefinitions({
        Transform: {
          prefix: "transform",
          body,
          pad: { fill: ".", targetWidth: 40 },
        },
      });

      assert.deepEqual(result.issue_iid, [], body);
      assert.equal(result.snippet_sid[0]?.pad_pid?.[0]?.driverTabstop, 1, body);
    }
  });

  it("rejects actual line breaks inside numeric spans while preserving static snippets", () => {
    for (const body of [
      "${1:line\nbreak}${pad}",
      "${1:line\r\nbreak}${pad}",
      "${1/(.*)/$1\n/}\n${1:mirrored\ndefault}${pad}",
    ]) {
      const dynamic = compileSnippetDefinitions({
        Dynamic: { prefix: "dynamic", body, pad: { fill: "-", targetWidth: 20 } },
      });
      const staticResult = compileSnippetDefinitions({
        Static: { prefix: "static", body: body.replace("${pad}", "") },
      });

      assert.equal(dynamic.snippet_sid.length, 0, JSON.stringify(body));
      assert.match(
        dynamic.issue_iid[0]?.message ?? "",
        /CR or LF.*numeric tab stop spans/iu,
        JSON.stringify(body),
      );
      assert.deepEqual(staticResult.issue_iid, [], JSON.stringify(body));
    }
  });

  it("rejects lone CR anywhere in dynamic bodies while preserving static bytes and CRLF", () => {
    const loneCrBody = "$1${pad}\rnext";
    const dynamic = compileSnippetDefinitions({
      Dynamic: {
        prefix: "dynamic",
        body: loneCrBody,
        pad: { fill: "-", targetWidth: 20 },
      },
    });
    const staticBody = "first\rsecond $1";
    const staticResult = compileSnippetDefinitions({
      Static: { prefix: "static", body: staticBody },
    });
    const crlfBody = "$1${pad}\r\n$0";
    const crlf = compileSnippetDefinitions({
      Dynamic: {
        prefix: "dynamic",
        body: crlfBody,
        pad: { fill: "-", targetWidth: 20 },
      },
    });

    assert.equal(dynamic.snippet_sid.length, 0);
    assert.match(dynamic.issue_iid[0]?.message ?? "", /Lone CR.*LF or CRLF/iu);
    assert.deepEqual(staticResult.issue_iid, []);
    assert.equal(staticResult.snippet_sid[0]?.body, staticBody);
    assert.deepEqual(crlf.issue_iid, []);
    assert.equal(crlf.snippet_sid[0]?.body, "$1\r\n$0");
  });

  it("rejects source-adjacent distinct groups and preserves same-ID mirrors", () => {
    for (const body of [
      "$1$2${pad}",
      "${1:first}${2:second}${pad}",
      "${1/(.*)/$1/}${2:value}${pad}",
    ]) {
      const result = compileSnippetDefinitions({
        Dynamic: { prefix: "dynamic", body, pad: { fill: "-", targetWidth: 20 } },
      });

      assert.equal(result.snippet_sid.length, 0, body);
      assert.match(
        result.issue_iid[0]?.message ?? "",
        /source-adjacent.*different identifiers/iu,
        body,
      );
    }

    const mirrored = compileSnippetDefinitions({
      Mirrored: {
        prefix: "mirrored",
        body: "$1${1:value}${pad}",
        pad: { fill: "-", targetWidth: 20 },
      },
    });
    assert.deepEqual(mirrored.issue_iid, []);
    assert.equal(mirrored.snippet_sid[0]?.body, "$1${1:value}");

    const staticResult = compileSnippetDefinitions({
      Static: { prefix: "static", body: "$1$2" },
    });
    assert.deepEqual(staticResult.issue_iid, []);
    assert.equal(staticResult.snippet_sid[0]?.body, "$1$2");
  });

  it("rejects numeric transforms nested in defaults", () => {
    const result = compileSnippetDefinitions({
      NestedTransform: {
        prefix: "nested-transform",
        body: "${1:outer ${2/(.*)/$1/}}${pad}",
        pad: { fill: " ", targetWidth: 60 },
      },
    });

    assert.equal(result.snippet_sid.length, 0);
    assert.match(result.issue_iid[0]?.message ?? "", /nested inside placeholder or variable defaults/u);
  });

  it("rejects malformed choices without using phantom drivers", () => {
    for (const choice of ["${1||}", "${1|one,|}"]) {
      const result = compileSnippetDefinitions({
        Choice: {
          prefix: "choice",
          body: `${choice}\${pad}`,
          pad: { fill: ".", targetWidth: 20 },
        },
      });

      assert.equal(result.snippet_sid.length, 0, choice);
      assert.ok(result.issue_iid.some((entry) => /well-formed/u.test(entry.message)), choice);
    }
  });

  it("rejects every valid choice in a dynamic snippet with a navigation diagnostic", () => {
    for (const body of [
      "${1|comma\\,value,plain|}",
      "${1|pipe\\|value,plain|}",
      "${1|slash\\\\value,plain|}",
      "${1|raw}brace,plain|}",
      "${1|back\\}brace,plain|}",
      "${1|one,two|} mirror ${1}${pad}",
      "${1:outer ${2|one,two|}}${pad}",
    ]) {
      const result = compileSnippetDefinitions({
        Choice: {
          prefix: "choice",
          body: body.includes("${pad}") ? body : `${body}\${pad}`,
          pad: { fill: ".", targetWidth: 40 },
        },
      });

      assert.equal(result.snippet_sid.length, 0, body);
      assert.match(result.issue_iid[0]?.message ?? "", /choice UI navigation cannot be safely observed/u, body);
    }
  });

  it("preserves valid and malformed choice syntax in static snippets", () => {
    for (const body of [
      "${1|one,two|}",
      "${1|${pad},${pad:name},\\${pad}|}",
      "${1||}",
      "${1|one,|}",
      "${1|one|oops}",
    ]) {
      const result = compileSnippetDefinitions({
        StaticChoice: { prefix: "choice", body },
      });

      assert.deepEqual(result.issue_iid, [], body);
      assert.equal(result.snippet_sid[0]?.body, body, body);
      assert.equal(result.snippet_sid[0]?.pad_pid, undefined, body);
    }
  });

  it("finds only a genuine active pad after an opaque choice", () => {
    const choice = "${1|${pad},${pad:name},\\${pad}|}";
    const result = compileSnippetDefinitions({
      DynamicChoice: {
        prefix: "choice",
        body: `${choice}\${pad:real}`,
        pads: { real: { fill: "-", targetWidth: 20 } },
      },
    });

    assert.equal(result.snippet_sid.length, 0);
    assert.equal(result.issue_iid.length, 1);
    assert.match(result.issue_iid[0]?.message ?? "", /choice UI navigation/u);
  });

  it("preserves malformed choice interiors and finds only following active pads", () => {
    for (const choice of [
      "${1|,${pad},${pad:name}|}",
      "${1|,\\${pad},\\${pad:name}|}",
    ]) {
      const staticResult = compileSnippetDefinitions({
        Static: { prefix: "static", body: choice },
      });
      const withDefault = compileSnippetDefinitions({
        Dynamic: {
          prefix: "dynamic",
          body: `${choice}\${pad}`,
          pad: { fill: "-", targetWidth: 20 },
        },
      });
      const withNamed = compileSnippetDefinitions({
        Dynamic: {
          prefix: "dynamic",
          body: `${choice}\${pad:real}`,
          pads: { real: { fill: "-", targetWidth: 20 } },
        },
      });

      assert.deepEqual(staticResult.issue_iid, [], choice);
      assert.equal(staticResult.snippet_sid[0]?.body, choice, choice);
      for (const dynamic of [withDefault, withNamed]) {
        assert.equal(dynamic.snippet_sid.length, 0, choice);
        assert.match(dynamic.issue_iid[0]?.message ?? "", /well-formed/u, choice);
      }
    }
  });

  it("preserves an ambiguous malformed-choice suffix without promoting pads", () => {
    const body = "${1|,${pad},${pad:name}}${pad:real}";
    const result = compileSnippetDefinitions({
      Static: { prefix: "static", body },
    });

    assert.deepEqual(result.issue_iid, []);
    assert.equal(result.snippet_sid[0]?.body, body);
  });

  it("rejects positive tab stops nested in placeholder defaults", () => {
    const result = compileSnippetDefinitions({
      Nested: {
        prefix: "nested",
        body: "${1:before ${2:inside}}${pad}",
        pad: { fill: " ", targetWidth: 60 },
      },
    });

    assert.equal(result.snippet_sid.length, 0);
    assert.match(result.issue_iid[0]?.message ?? "", /nested inside placeholder or variable defaults/u);
  });

  it("bounds line-break validation for deeply overlapping positive and zero spans", { timeout: 5_000 }, () => {
    const nestingCount = 19_998;
    const positiveBody = `${"${1:".repeat(nestingCount)}x${"}".repeat(nestingCount)}\${pad}`;
    const zeroBody = `${"${0:".repeat(nestingCount)}x${"}".repeat(nestingCount)}$1\${pad}`;

    assert.ok(positiveBody.length <= MAX_SNIPPET_BODY_LENGTH);
    assert.ok(zeroBody.length <= MAX_SNIPPET_BODY_LENGTH);

    const positive = compileSnippetDefinitions({
      Positive: {
        prefix: "positive",
        body: positiveBody,
        pad: { fill: "-", targetWidth: 20 },
      },
    });
    const zero = compileSnippetDefinitions({
      Zero: {
        prefix: "zero",
        body: zeroBody,
        pad: { fill: "-", targetWidth: 20 },
      },
    });

    assert.equal(positive.snippet_sid.length, 0);
    assert.match(positive.issue_iid[0]?.message ?? "", /nested inside/u);
    assert.deepEqual(zero.issue_iid, []);
    assert.equal(
      zero.snippet_sid[0]?.body,
      zeroBody.slice(0, zeroBody.length - "${pad}".length),
    );
  });

  it("bounds malformed transform analysis while preserving static bytes and failing dynamic input closed", { timeout: 5_000 }, () => {
    const repeatedProbe = "${1:+".repeat(15_000);
    const prefix_pid = [
      "${1/[${pad}]/",
      "${1/[${pad:name}]/",
      "${1/a/${pad}-",
      "${1/a/${pad:name}-",
      "${1/a/\\${pad}-",
      "${1/a/\\${pad:name}-",
    ];
    for (let index = 0; index < prefix_pid.length; index += 1) {
      const prefix = prefix_pid[index];
      assert.notEqual(prefix, undefined);
      const malformedBody = `${prefix}${repeatedProbe}\\q/}`;
      const staticResult = compileSnippetDefinitions({
        Static: { prefix: "static", body: malformedBody },
      });
      const named = index % 2 === 1;
      const activePad = named ? "${pad:real}" : "${pad}";
      const dynamic = compileSnippetDefinitions({
        Dynamic: {
          prefix: "dynamic",
          body: `${malformedBody}${activePad}`,
          ...(named
            ? { pads: { real: { fill: "-", targetWidth: 20 } } }
            : { pad: { fill: "-", targetWidth: 20 } }),
        },
      });

      assert.ok(malformedBody.length < MAX_SNIPPET_BODY_LENGTH);
      assert.deepEqual(staticResult.issue_iid, [], prefix);
      assert.equal(staticResult.snippet_sid[0]?.body, malformedBody, prefix);
      assert.equal(dynamic.snippet_sid.length, 0, prefix);
      assert.match(dynamic.issue_iid[0]?.message ?? "", /well-formed/u, prefix);
    }
  });

  it("uses VS Code closure semantics for literal braces", () => {
    const result = compileSnippetDefinitions({
      LiteralBrace: {
        prefix: "brace",
        body: "${1:left {x} ${2:right}}${pad}",
        pad: { fill: " ", targetWidth: 60 },
      },
    });

    assert.deepEqual(result.issue_iid, []);
    assert.equal(result.snippet_sid[0]?.body, "${1:left {x} ${2:right}}");
    assert.equal(result.snippet_sid[0]?.pad_pid?.[0]?.driverTabstop, 2);
  });

  it("keeps escaped closing braces inside placeholder defaults", () => {
    const result = compileSnippetDefinitions({
      EscapedBrace: {
        prefix: "escaped-brace",
        body: "${1:left \\} right}${pad}",
        pad: { fill: " ", targetWidth: 60 },
      },
    });

    assert.deepEqual(result.issue_iid, []);
    assert.equal(result.snippet_sid[0]?.body, "${1:left \\} right}");
    assert.equal(result.snippet_sid[0]?.pad_pid?.[0]?.driverTabstop, 1);
  });

  it("rejects native-variable fallbacks before considering their nested tab stops", () => {
    const result = compileSnippetDefinitions({
      VariableFallback: {
        prefix: "fallback",
        body: "${TM_FILENAME:${1:fallback}} $2${pad}",
        pad: { fill: " ", targetWidth: 60 },
      },
    });

    assert.equal(result.snippet_sid.length, 0);
    assert.match(result.issue_iid[0]?.message ?? "", /Native variables are not supported/u);
  });

  it("keeps escaped default and named pad syntax native", () => {
    const result = compileSnippetDefinitions({
      Literal: {
        prefix: "literal",
        body: String.raw`$1\${pad} and \${pad:rule}`,
        pad: { fill: "-", targetWidth: 10 },
        pads: { rule: { fill: ".", targetWidth: 10 } },
      },
    });

    assert.equal(result.snippet_sid[0]?.body, String.raw`$1\${pad} and \${pad:rule}`);
    assert.equal(result.snippet_sid[0]?.pad_pid, undefined);
    assert.deepEqual(result.issue_iid.map((entry) => entry.path), [
      '$["Literal"].pad',
      '$["Literal"].pads.rule',
    ]);
    assert.ok(result.issue_iid.every((entry) => entry.severity === "warning"));
  });

  it("treats an even number of preceding backslashes as an active pad", () => {
    const result = compileSnippetDefinitions({
      Active: {
        prefix: "active",
        body: "$1\\\\${pad}",
        pad: { fill: "-", targetWidth: 10 },
      },
    });

    assert.deepEqual(result.issue_iid, []);
    assert.equal(result.snippet_sid[0]?.body, "$1\\\\");
    assert.equal(result.snippet_sid[0]?.pad_pid?.[0]?.offset, 4);
  });

  it("enforces EOF, LF, or CRLF immediately after each active pad", () => {
    for (const suffix of [" ", " trailing"]) {
      const result = compileSnippetDefinitions({
        Invalid: {
          prefix: "x",
          body: `$1\${pad}${suffix}`,
          pad: { fill: "-", targetWidth: 10 },
        },
      });
      assert.equal(result.snippet_sid.length, 0, JSON.stringify(suffix));
      assert.match(result.issue_iid[0]?.message ?? "", /immediately followed/u);
    }

    const crlf = compileSnippetDefinitions({
      Valid: {
        prefix: "x",
        body: "$1${pad}\r\n$0",
        pad: { fill: "-", targetWidth: 10 },
      },
    });
    assert.deepEqual(crlf.issue_iid, []);
    assert.equal(crlf.snippet_sid[0]?.body, "$1\r\n$0");
  });

  it("requires a positive driver on the same line", () => {
    for (const body of ["$0${pad}", "$1\ntext${pad}"]) {
      const result = compileSnippetDefinitions({
        Invalid: { prefix: "x", body, pad: { fill: "-", targetWidth: 10 } },
      });
      assert.equal(result.snippet_sid.length, 0);
      assert.match(result.issue_iid[0]?.message ?? "", /positive numeric/u);
    }
  });

  it("reports missing and unknown configurations", () => {
    const result = compileSnippetDefinitions({
      MissingDefault: { prefix: "a", body: "$1${pad}" },
      MissingNamed: { prefix: "b", body: "$1${pad:missing}" },
      UnknownNamed: {
        prefix: "c",
        body: "$1${pad:unknown}",
        pads: { known: { fill: "-", targetWidth: 10 } },
      },
    });

    assert.equal(result.snippet_sid.length, 0);
    assert.ok(result.issue_iid.some((entry) => entry.message.includes("${pad} requires")));
    assert.ok(result.issue_iid.some((entry) => entry.message.includes("${pad:missing} requires")));
    assert.ok(result.issue_iid.some((entry) => entry.message.includes("Unknown named pad reference ${pad:unknown}")));
  });

  it("warns for each valid unused default or named configuration", () => {
    const result = compileSnippetDefinitions({
      Native: {
        prefix: "n",
        body: "plain $1",
        pad: { fill: "-", targetWidth: 10 },
        pads: {
          first: { fill: ".", targetWidth: 10 },
          second: { fill: "_", targetWidth: 20 },
        },
      },
    });

    assert.equal(result.snippet_sid.length, 1);
    assert.deepEqual(result.issue_iid.map((entry) => entry.path), [
      '$["Native"].pad',
      '$["Native"].pads.first',
      '$["Native"].pads.second',
    ]);
    assert.ok(result.issue_iid.every((entry) => entry.severity === "warning"));
  });

  it("preserves static numeric variable defaults but reserves configured forms", () => {
    const nativeNumeric = compileSnippetDefinitions({
      Numeric: { prefix: "x", body: "$1${pad:60}" },
    });
    assert.deepEqual(nativeNumeric.issue_iid, []);
    assert.equal(nativeNumeric.snippet_sid[0]?.body, "$1${pad:60}");

    const configuredNumeric = compileSnippetDefinitions({
      Numeric: {
        prefix: "x",
        body: "$1${pad:60}",
        pad: { fill: " ", targetWidth: 60 },
      },
    });
    assert.equal(configuredNumeric.snippet_sid.length, 0);
    assert.ok(configuredNumeric.issue_iid.some((entry) => /Numeric.*reserved/u.test(entry.message)));

    const namedConfiguredNumeric = compileSnippetDefinitions({
      Numeric: {
        prefix: "x",
        body: "$1${pad:60}",
        pads: { named: { fill: " ", targetWidth: 60 } },
      },
    });
    assert.equal(namedConfiguredNumeric.snippet_sid.length, 0);
    assert.ok(namedConfiguredNumeric.issue_iid.some((entry) => /Numeric.*reserved/u.test(entry.message)));

    const native = compileSnippetDefinitions({
      Native: { prefix: "x", body: "$1${pad:not.valid}" },
    });
    assert.deepEqual(native.issue_iid, []);
    assert.equal(native.snippet_sid[0]?.body, "$1${pad:not.valid}");
  });

  it("bounds active tokens and named configurations", () => {
    const tooManyTokens = compileSnippetDefinitions({
      Tokens: {
        prefix: "x",
        body: Array.from({ length: MAX_PADS_PER_SNIPPET + 1 }, () => "$1${pad}"),
        pad: { fill: "-", targetWidth: 10 },
      },
    });
    assert.equal(tooManyTokens.snippet_sid.length, 0);
    assert.match(tooManyTokens.issue_iid[0]?.message ?? "", /at most 128 active/u);

    const pads = Object.fromEntries(Array.from(
      { length: MAX_NAMED_PAD_CONFIGURATIONS + 1 },
      (_, index) => [`p${index}`, { fill: "-", targetWidth: 10 }],
    ));
    const tooManyConfigurations = parseSnippetDefinitions({
      Configurations: { prefix: "x", body: "$1", pads },
    });
    assert.equal(tooManyConfigurations.snippet_sid.length, 0);
    assert.ok(tooManyConfigurations.issue_iid.some((entry) => /at most 128 named/u.test(entry.message)));
  });

  it("rejects unsafe numeric tab stop identifiers in dynamic snippets", () => {
    const result = compileSnippetDefinitions({
      Unsafe: {
        prefix: "unsafe",
        body: "$9007199254740992${pad}",
        pad: { fill: "-", targetWidth: 10 },
      },
    });

    assert.equal(result.snippet_sid.length, 0);
    assert.match(result.issue_iid[0]?.message ?? "", /safe positive integers/u);
  });

  it("rejects every native variable in dynamic snippets and preserves static snippets", () => {
    for (const body of [
      "$TM_FILENAME $1${pad}",
      "${TM_FILENAME} $1${pad}",
      "${TM_FILENAME:fallback} $1${pad}",
      "${TM_FILENAME/(.*)/$1/} $2${pad}",
      "$CLIPBOARD $1${pad}",
      "${TM_SELECTED_TEXT} $1${pad}",
    ]) {
      const dynamic = compileSnippetDefinitions({
        Dynamic: { prefix: "dynamic", body, pad: { fill: "-", targetWidth: 20 } },
      });
      assert.equal(dynamic.snippet_sid.length, 0, body);
      assert.ok(dynamic.issue_iid.some((entry) => /Native variables are not supported/u.test(entry.message)), body);
    }

    const staticSnippet = compileSnippetDefinitions({
      Static: { prefix: "static", body: "${TM_FILENAME/(.*)/$1/} $2" },
    });
    assert.deepEqual(staticSnippet.issue_iid, []);
    assert.equal(staticSnippet.snippet_sid[0]?.body, "${TM_FILENAME/(.*)/$1/} $2");
  });

  it("fails closed when malformed syntax precedes an active pad", () => {
    const result = compileSnippetDefinitions({
      Malformed: {
        prefix: "malformed",
        body: "${TM_FILENAME/(.*)/$1} $2${pad}",
        pad: { fill: "-", targetWidth: 20 },
      },
    });

    assert.equal(result.snippet_sid.length, 0);
    assert.ok(result.issue_iid.some((entry) => /well-formed/u.test(entry.message)));
  });

  it("validates both configuration shapes with precise paths", () => {
    const malformed = parseSnippetDefinitions({
      Broken: {
        prefix: ["ok", ""],
        body: [],
        description: 4,
        scope: ["markdown", 3],
        pad: { fill: "", targetWidth: MAX_PAD_TARGET_WIDTH + 1 },
        pads: {
          named: { fill: "\t", targetWidth: 0 },
          "60": { fill: "-", targetWidth: 10 },
        },
      },
      AlsoBroken: null,
    });
    assert.equal(malformed.snippet_sid.length, 0);
    assert.ok(malformed.issue_iid.every((entry) => entry.severity === "error"));
    assert.ok(malformed.issue_iid.some((entry) => entry.path.endsWith(".pad.fill")));
    assert.ok(malformed.issue_iid.some((entry) => entry.path.endsWith(".pad.targetWidth")));
    assert.ok(malformed.issue_iid.some((entry) => entry.path.endsWith(".pads.named.fill")));
    assert.ok(malformed.issue_iid.some((entry) => entry.path.endsWith(".pads.named.targetWidth")));
    assert.ok(malformed.issue_iid.some((entry) => entry.path.endsWith('.pads["60"]')));
    assert.ok(malformed.issue_iid.some((entry) => entry.snippetName === "AlsoBroken"));
  });

  it("rejects extra default and named pad configuration properties", () => {
    const result = parseSnippetDefinitions({
      Extra: {
        prefix: "extra",
        body: "$1${pad}",
        pad: { fill: "-", targetWidth: 20, color: "red" },
        pads: {
          named: { fill: ".", targetWidth: 30, width: 30 },
        },
      },
    });

    assert.equal(result.snippet_sid.length, 0);
    assert.ok(result.issue_iid.some((entry) => entry.path === '$["Extra"].pad.color'));
    assert.ok(result.issue_iid.some((entry) => entry.path === '$["Extra"].pads.named.width'));
  });

  it("rejects unknown snippet definition properties with precise paths", () => {
    const result = parseSnippetDefinitions({
      ScopeTypo: {
        prefix: "typo",
        body: "$1",
        scpoe: "julia",
      },
      Extra: {
        prefix: "extra",
        body: "$1",
        "display-name": "Extra",
      },
    });

    assert.equal(result.snippet_sid.length, 0);
    assert.deepEqual(result.issue_iid.map((entry) => entry.path), [
      '$["ScopeTypo"].scpoe',
      '$["Extra"]["display-name"]',
    ]);
    assert.ok(result.issue_iid.every((entry) => /not allowed/u.test(entry.message)));
  });

  it("reports malformed top-level input", () => {
    const topLevel = parseSnippetDefinitions([]);
    assert.equal(topLevel.snippet_sid.length, 0);
    assert.equal(topLevel.issue_iid[0]?.path, "$");
    assert.equal(topLevel.issue_iid[0]?.snippetName, undefined);
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

  it("accepts the scope text boundary and rejects one UTF-16 code unit over", () => {
    const atLimit = parseSnippetDefinitions({
      AtLimit: {
        prefix: "x",
        body: "$1",
        scope: [
          "x".repeat(MAX_SCOPE_TEXT_LENGTH_PER_SNIPPET / 2),
          "y".repeat(MAX_SCOPE_TEXT_LENGTH_PER_SNIPPET / 2),
        ],
      },
    });
    assert.equal(atLimit.snippet_sid.length, 1);
    assert.deepEqual(atLimit.issue_iid, []);

    const overLimit = parseSnippetDefinitions({
      OverLimit: {
        prefix: "x",
        body: "$1",
        scope: [
          "x".repeat(MAX_SCOPE_TEXT_LENGTH_PER_SNIPPET / 2),
          "y".repeat(MAX_SCOPE_TEXT_LENGTH_PER_SNIPPET / 2 + 1),
        ],
      },
    });
    assert.equal(overLimit.snippet_sid.length, 0);
    assert.equal(overLimit.issue_iid[0]?.path, '$["OverLimit"].scope');
    assert.match(overLimit.issue_iid[0]?.message ?? "", /aggregate UTF-16/u);
  });

  it("accepts the scope ID boundary and rejects one ID over", () => {
    const scopeAtLimit_sid = Array.from(
      { length: MAX_SCOPE_IDS_PER_SNIPPET },
      (_, index) => `id${index}`,
    );
    const atLimit = parseSnippetDefinitions({
      AtLimit: { prefix: "x", body: "$1", scope: scopeAtLimit_sid },
    });
    assert.equal(atLimit.snippet_sid.length, 1);

    const overLimit = parseSnippetDefinitions({
      OverLimit: { prefix: "x", body: "$1", scope: [...scopeAtLimit_sid, "extra"] },
    });
    assert.equal(overLimit.snippet_sid.length, 0);
    assert.equal(overLimit.issue_iid[0]?.path, '$["OverLimit"].scope');
    assert.match(overLimit.issue_iid[0]?.message ?? "", /counted before deduplication/u);

    const dynamicOverLimit = compileSnippetDefinitions({
      DynamicOverLimit: {
        prefix: "x",
        body: "$1${pad}",
        scope: [...scopeAtLimit_sid, "extra"],
        pad: { fill: "-", targetWidth: 20 },
      },
    });
    assert.equal(dynamicOverLimit.snippet_sid.length, 0);
    assert.ok(dynamicOverLimit.issue_iid.some((entry) => entry.path.endsWith(".scope")));
  });

  it("counts duplicate comma-separated scope IDs before deduplication", () => {
    const duplicateScope = Array.from(
      { length: MAX_SCOPE_IDS_PER_SNIPPET + 1 },
      () => "julia",
    ).join(",");
    const result = parseSnippetDefinitions({
      Duplicates: { prefix: "x", body: "$1", scope: duplicateScope },
    });

    assert.equal(result.snippet_sid.length, 0);
    assert.equal(result.issue_iid[0]?.path, '$["Duplicates"].scope');
    assert.match(result.issue_iid[0]?.message ?? "", /at most 256/u);
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

  it("rejects one overlong snippet name without validating its definition", () => {
    const name = "n".repeat(MAX_SNIPPET_NAME_LENGTH + 1);
    const result = parseSnippetDefinitions({
      [name]: { invalid: true },
    });

    assert.equal(result.snippet_sid.length, 0);
    assert.equal(result.issue_iid.length, 1);
    assert.equal(result.issue_iid[0]?.snippetName, name);
    assert.match(result.issue_iid[0]?.message ?? "", /Snippet names.*256 UTF-16/u);
    assert.ok((result.issue_iid[0]?.path.length ?? Infinity) <= MAX_ISSUE_PATH_LENGTH);
  });

  it("accepts a boundary-length snippet name and preserves ordinary precise paths", () => {
    const name = "n".repeat(MAX_SNIPPET_NAME_LENGTH);
    const valid = compileSnippetDefinitions({
      [name]: { prefix: "boundary", body: "$1" },
    });
    const precise = parseSnippetDefinitions({
      Ordinary: { prefix: "ordinary", body: "$1", typo: true },
    });

    assert.deepEqual(valid.issue_iid, []);
    assert.equal(valid.snippet_sid[0]?.name, name);
    assert.equal(precise.issue_iid[0]?.path, '$["Ordinary"].typo');
  });

  it("uses one structural issue for a definition above its property gate", () => {
    const unknownProperty_pid = Array.from(
      { length: MAX_SNIPPET_DEFINITION_PROPERTIES + 1 },
      (_, index) => [`${"property".repeat(40)}${index}`, true],
    );
    const definition = {
      prefix: "large",
      body: "$1",
      ...Object.fromEntries(unknownProperty_pid),
    };
    const result = parseSnippetDefinitions({ Large: definition });

    assert.equal(result.snippet_sid.length, 0);
    assert.equal(result.issue_iid.length, 1);
    assert.match(result.issue_iid[0]?.message ?? "", /at most 16 own enumerable/u);
  });

  it("uses one structural issue for a pad above its property gate", () => {
    const extraProperty_pid = Array.from(
      { length: MAX_PAD_CONFIGURATION_PROPERTIES - 1 },
      (_, index) => [`extra${index}`, true],
    );
    const result = parseSnippetDefinitions({
      LargePad: {
        prefix: "large-pad",
        body: "$1${pad}",
        pad: { fill: "-", targetWidth: 20, ...Object.fromEntries(extraProperty_pid) },
      },
    });

    assert.equal(result.snippet_sid.length, 0);
    assert.equal(result.issue_iid.length, 1);
    assert.match(result.issue_iid[0]?.message ?? "", /at most 8 own enumerable/u);
  });

  it("returns immediately after the named-pad count gate", () => {
    const pads = Object.fromEntries(Array.from(
      { length: MAX_NAMED_PAD_CONFIGURATIONS + 1 },
      (_, index) => [`invalid name ${index}`, { many: "unknown properties" }],
    ));
    const result = parseSnippetDefinitions({
      TooManyPads: { prefix: "pads", body: "$1", pads },
    });

    assert.equal(result.snippet_sid.length, 0);
    assert.equal(result.issue_iid.length, 1);
    assert.match(result.issue_iid[0]?.message ?? "", /at most 128 named/u);
  });

  it("caps many semantic errors with one final error summary", () => {
    const definitions = Object.fromEntries(Array.from(
      { length: 500 },
      (_, index) => [`Invalid${index}`, null],
    ));
    const result = compileSnippetDefinitions(definitions);
    const summary_iid = result.issue_iid.filter((entry) => /semantic issue\(s\) omitted/u.test(entry.message));

    assert.equal(result.issue_iid.length, MAX_SEMANTIC_ISSUES_PER_SOURCE);
    assert.equal(summary_iid.length, 1);
    assert.equal(result.issue_iid.at(-1), summary_iid[0]);
    assert.equal(summary_iid[0]?.severity, "error");
  });

  it("shares one issue budget across validation and compilation", () => {
    const invalidDefinition_did = Array.from(
      { length: 60 },
      (_, index) => [`Invalid${index}`, null],
    );
    const compilerErrorDefinition_did = Array.from(
      { length: 100 },
      (_, index) => [`Choice${index}`, {
        prefix: `choice${index}`,
        body: "${1|one,two|}${pad}",
        pad: { fill: "-", targetWidth: 20 },
      }],
    );
    const result = compileSnippetDefinitions(Object.fromEntries([
      ...invalidDefinition_did,
      ...compilerErrorDefinition_did,
    ]));

    assert.equal(result.issue_iid.length, MAX_SEMANTIC_ISSUES_PER_SOURCE);
    assert.equal(result.issue_iid.filter((entry) => /omitted/u.test(entry.message)).length, 1);
    assert.ok(result.issue_iid.some((entry) => /choice UI navigation/u.test(entry.message)));
    assert.equal(result.issue_iid.at(-1)?.severity, "error");
  });

  it("bounds aggregate and individual semantic issue text", () => {
    const longProperty = `x${"p".repeat(600)}`;
    const definitions = Object.fromEntries(Array.from({ length: 200 }, (_, index) => {
      const suffix = String(index);
      const name = `${"n".repeat(MAX_SNIPPET_NAME_LENGTH - suffix.length)}${suffix}`;
      return [name, { prefix: `p${index}`, body: "$1", [longProperty]: true }];
    }));
    const result = parseSnippetDefinitions(definitions);
    const aggregateLength = result.issue_iid.reduce(
      (length, entry) => length + entry.path.length + entry.message.length,
      0,
    );

    assert.ok(result.issue_iid.length <= MAX_SEMANTIC_ISSUES_PER_SOURCE);
    assert.ok(aggregateLength <= MAX_SEMANTIC_ISSUE_TEXT_LENGTH);
    assert.ok(result.issue_iid.every((entry) => entry.path.length <= MAX_ISSUE_PATH_LENGTH));
    assert.ok(result.issue_iid.every((entry) => entry.message.length <= MAX_ISSUE_MESSAGE_LENGTH));
    assert.ok(result.issue_iid.some((entry) => entry.path.includes("…")));
    assert.equal(result.issue_iid.filter((entry) => /omitted/u.test(entry.message)).length, 1);
  });

  it("bounds arbitrary limiter input and direct compiler issue paths", () => {
    const limitedIssue_iid = limitSemanticIssues([{
      severity: "error",
      path: "p".repeat(MAX_ISSUE_PATH_LENGTH + 100),
      message: "m".repeat(MAX_ISSUE_MESSAGE_LENGTH + 100),
    }]);
    const direct = compileSnippet({
      name: "\u0000".repeat(1_000),
      definition: {
        prefix: "direct",
        body: "$1${pad}",
      },
    });

    assert.equal(limitedIssue_iid[0]?.path.length, MAX_ISSUE_PATH_LENGTH);
    assert.equal(limitedIssue_iid[0]?.message.length, MAX_ISSUE_MESSAGE_LENGTH);
    assert.ok(limitedIssue_iid[0]?.path.endsWith("…"));
    assert.ok(limitedIssue_iid[0]?.message.endsWith("…"));
    assert.ok((direct.issue_iid[0]?.path.length ?? Infinity) <= MAX_ISSUE_PATH_LENGTH);
    assert.ok((direct.issue_iid[0]?.message.length ?? Infinity) <= MAX_ISSUE_MESSAGE_LENGTH);
  });
});
