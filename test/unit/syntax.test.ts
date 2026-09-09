import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  analyzeSnippetSyntax,
  hasLoneCarriageReturn,
  numericTabstopsContainLineBreak,
} from "../../src/core/syntax.js";

describe("snippet syntax analysis", () => {
  it("detects carriage returns that are not followed by LF", () => {
    for (const text of ["\r", "before\rafter", "\r\r\n", "\r\n\r"]) {
      assert.equal(hasLoneCarriageReturn(text), true, JSON.stringify(text));
    }
    for (const text of ["", "\n", "\r\n", "one\r\ntwo\n"]) {
      assert.equal(hasLoneCarriageReturn(text), false, JSON.stringify(text));
    }
  });

  it("reports numeric tab stops in source order with default nesting", () => {
    const syntax = analyzeSnippetSyntax("${1:outer ${2:inner}} $3");

    assert.deepEqual(
      syntax.tabstop_tid.map((tabstop) => ({ number: tabstop.number, depth: tabstop.nestingDepth })),
      [
        { number: 1, depth: 0 },
        { number: 2, depth: 1 },
        { number: 3, depth: 0 },
      ],
    );
  });

  it("does not let literal opening braces extend defaults", () => {
    const syntax = analyzeSnippetSyntax("${1:left {x} ${2:right}}");

    assert.deepEqual(
      syntax.tabstop_tid.map((tabstop) => ({ number: tabstop.number, depth: tabstop.nestingDepth })),
      [{ number: 1, depth: 0 }, { number: 2, depth: 0 }],
    );
  });

  it("honors escaped closing braces in defaults", () => {
    const syntax = analyzeSnippetSyntax("${1:left \\} right} $2");

    assert.equal(syntax.malformed, false);
    assert.deepEqual(syntax.tabstop_tid.map((tabstop) => tabstop.number), [1, 2]);
    assert.equal(syntax.tabstop_tid[0]?.end, 18);
  });

  it("skips transform format references and pad-like text in transforms", () => {
    const syntax = analyzeSnippetSyntax("${TM_FILENAME/(.*)/${1:/upcase}-${pad}/} $2${pad}");

    assert.deepEqual(syntax.tabstop_tid.map((tabstop) => tabstop.number), [2]);
    assert.equal(syntax.pad_tid.length, 1);
    assert.equal(syntax.variable_vid.length, 1);
    assert.equal(syntax.variable_vid[0]?.name, "TM_FILENAME");
  });

  it("keeps default, named, and escaped pad spellings opaque throughout transforms", () => {
    const text = "${1/[${pad:name}]/${pad}-\\${pad}/}";
    const syntax = analyzeSnippetSyntax(text);

    assert.equal(syntax.malformed, false);
    assert.deepEqual(syntax.pad_tid, []);
    assert.deepEqual(syntax.tabstop_tid.map((tabstop) => tabstop.number), [1]);
  });

  it("records complete numeric transforms without recording format captures", () => {
    const text = "${1/[}]/$1-${1:/upcase}-${2:+yes}-${3:?if:else}/gi}";
    const syntax = analyzeSnippetSyntax(text);

    assert.equal(syntax.malformed, false);
    assert.deepEqual(syntax.tabstop_tid, [{
      start: 0,
      end: text.length,
      number: 1,
      nestingDepth: 0,
    }]);
  });

  it("preserves numeric transform nesting depth in defaults", () => {
    const syntax = analyzeSnippetSyntax("${TM_FILENAME:${2/(.*)/$1/}} $3");

    assert.deepEqual(
      syntax.tabstop_tid.map((tabstop) => ({ number: tabstop.number, depth: tabstop.nestingDepth })),
      [{ number: 2, depth: 1 }, { number: 3, depth: 0 }],
    );
  });

  it("validates transform delimiters, regular expressions, and options", () => {
    const validTransform_tid = [
      "${1/(a\\/b)/$1/}",
      "${1/[}]/${1:-fallback}/g}",
      "${1/(.*)/literal \\/ slash/}",
      "${1/(.*)/${1:+line\nbreak}/}",
    ];
    for (const transform of validTransform_tid) {
      const syntax = analyzeSnippetSyntax(transform);
      assert.equal(syntax.malformed, false, transform);
      assert.deepEqual(syntax.tabstop_tid.map((tabstop) => tabstop.number), [1], transform);
      assert.equal(syntax.tabstop_tid[0]?.end, transform.length, transform);
    }

    const malformedTransform_tid = [
      "${1/(.*)/$1}",
      "${1/[/$1/}",
      "${1/(.*)/$1/gg}",
      "${1/[a/b]/$1/}",
    ];
    for (const transform of malformedTransform_tid) {
      const syntax = analyzeSnippetSyntax(transform);
      assert.equal(syntax.malformed, true, transform);
      assert.deepEqual(syntax.tabstop_tid, [], transform);
    }
  });

  it("accepts nonempty VS Code choices and their supported escapes", () => {
    const text = "${1|comma\\,value,pipe\\|value,slash\\\\value,raw},back\\}brace|}";
    const syntax = analyzeSnippetSyntax(text);

    assert.equal(syntax.malformed, false);
    assert.deepEqual(syntax.tabstop_tid, [{
      start: 0,
      end: text.length,
      number: 1,
      nestingDepth: 0,
    }]);
    assert.deepEqual(syntax.choice_tid, syntax.tabstop_tid);
  });

  it("keeps default, named, and escaped pad spellings opaque inside choices", () => {
    const text = "${1|${pad},${pad:name},\\${pad}|}";
    const syntax = analyzeSnippetSyntax(`${text}\${pad:real}`);

    assert.equal(syntax.malformed, false);
    assert.equal(syntax.choice_tid.length, 1);
    assert.deepEqual(syntax.pad_tid, [{
      start: text.length,
      end: text.length + "${pad:real}".length,
      configurationName: "real",
    }]);
  });

  it("keeps malformed choice interiors opaque until a proper terminator", () => {
    for (const choice of [
      "${1|,${pad},${pad:name}|}",
      "${1|,\\${pad},\\${pad:name}|}",
    ]) {
      const syntax = analyzeSnippetSyntax(choice);
      assert.equal(syntax.malformed, true, choice);
      assert.deepEqual(syntax.pad_tid, [], choice);
      assert.deepEqual(syntax.choice_tid, [], choice);

      const withDefault = analyzeSnippetSyntax(`${choice}\${pad}`);
      assert.equal(withDefault.malformed, true, choice);
      assert.deepEqual(withDefault.pad_tid, [{
        start: choice.length,
        end: choice.length + "${pad}".length,
      }], choice);

      const withNamed = analyzeSnippetSyntax(`${choice}\${pad:real}`);
      assert.equal(withNamed.malformed, true, choice);
      assert.deepEqual(withNamed.pad_tid, [{
        start: choice.length,
        end: choice.length + "${pad:real}".length,
        configurationName: "real",
      }], choice);
    }
  });

  it("does not expose pad text after a malformed choice without a proper terminator", () => {
    const ambiguous = "${1|,${pad},${pad:name}}${pad:real}";
    const syntax = analyzeSnippetSyntax(ambiguous);

    assert.equal(syntax.malformed, true);
    assert.deepEqual(syntax.pad_tid, []);
    assert.deepEqual(syntax.choice_tid, []);
  });

  it("records every complete choice occurrence, including repeated IDs and nesting", () => {
    const text = "${1|a,b|} ${1|c,d|} ${2:outer ${3|e,f|}} ${3|g,h|}";
    const syntax = analyzeSnippetSyntax(text);

    assert.equal(syntax.malformed, false);
    assert.deepEqual(
      syntax.choice_tid.map((choice) => ({
        text: text.slice(choice.start, choice.end),
        number: choice.number,
        depth: choice.nestingDepth,
      })),
      [
        { text: "${1|a,b|}", number: 1, depth: 0 },
        { text: "${1|c,d|}", number: 1, depth: 0 },
        { text: "${3|e,f|}", number: 3, depth: 1 },
        { text: "${3|g,h|}", number: 3, depth: 0 },
      ],
    );
  });

  it("fails closed on empty choice elements and malformed terminators", () => {
    for (const choice of [
      "${1||}",
      "${1|one,|}",
      "${1|,one|}",
      "${1|one,,two|}",
      "${1|one|oops}",
      "${1|one,two}",
      "${0|one,two|}",
    ]) {
      const syntax = analyzeSnippetSyntax(choice);
      assert.equal(syntax.malformed, true, choice);
      assert.deepEqual(syntax.tabstop_tid, [], choice);
      assert.deepEqual(syntax.choice_tid, [], choice);
    }
  });

  it("accounts for line breaks consumed by choices and transforms", () => {
    const choice = analyzeSnippetSyntax("${TM_FILENAME:${1|one\nline,two|}}");
    const transform = analyzeSnippetSyntax("${TM_FILENAME:${1/(.*)/line\nbreak/}}");

    assert.equal(choice.variable_vid[0]?.containsLineBreak, true);
    assert.equal(transform.variable_vid[0]?.containsLineBreak, true);
  });

  it("indexes line breaks once for overlapping positive and zero defaults", () => {
    const multilineText = "${1:outer ${0:line\nbreak}}";
    const singleLineText = "${1:outer ${0:single line}}";
    const multiline = analyzeSnippetSyntax(multilineText);
    const singleLine = analyzeSnippetSyntax(singleLineText);

    assert.equal(
      numericTabstopsContainLineBreak(multilineText, multiline.tabstop_tid),
      true,
    );
    assert.equal(
      numericTabstopsContainLineBreak(singleLineText, singleLine.tabstop_tid),
      false,
    );
  });

  it("bounds repeated failed transform-format probes near the body limit", { timeout: 5_000 }, () => {
    const repeatedProbe = "${1:+".repeat(15_000);
    for (const prefix of [
      "${1/[${pad}]/",
      "${1/[${pad:name}]/",
      "${1/a/${pad}-",
      "${1/a/${pad:name}-",
      "${1/a/\\${pad}-",
      "${1/a/\\${pad:name}-",
    ]) {
      const text = `${prefix}${repeatedProbe}\\q/}`;

      assert.ok(text.length < 100_000);
      const opaque = analyzeSnippetSyntax(text);
      assert.equal(opaque.malformed, true, prefix);
      assert.deepEqual(opaque.pad_tid, [], prefix);
      assert.deepEqual(opaque.tabstop_tid, [], prefix);

      const withActivePad = analyzeSnippetSyntax(`${text}\${pad:real}`);
      assert.equal(withActivePad.malformed, true, prefix);
      assert.deepEqual(withActivePad.pad_tid, [{
        start: text.length,
        end: text.length + "${pad:real}".length,
        configurationName: "real",
      }], prefix);
    }
  });
});
