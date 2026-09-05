import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  findAgreedExactPrefixMatch,
  findExactPrefixMatch,
  isExactPrefixAtBoundary,
  type ExactPrefixSnippet,
} from "../../src/completion/exactMatching.js";

interface TestSnippet extends ExactPrefixSnippet {
  readonly marker: string;
}

function snippet(
  name: string,
  sourceKind: "user" | "workspace",
  prefix_pid: readonly string[],
  priority = sourceKind === "user" ? 0 : 1,
): TestSnippet {
  return {
    name,
    source: { kind: sourceKind, priority },
    prefix_pid,
    marker: `${sourceKind}:${name}`,
  };
}

describe("exact-prefix expansion matching", () => {
  it("requires a complete prefix at a line start or whitespace boundary", () => {
    assert.equal(isExactPrefixAtBoundary("#h1", "#h1"), true);
    assert.equal(isExactPrefixAtBoundary("const value = #h1", "#h1"), true);
    assert.equal(isExactPrefixAtBoundary("value#h1", "#h1"), false);
    assert.equal(isExactPrefixAtBoundary("#h", "#h1"), false);
    assert.equal(isExactPrefixAtBoundary("anything", ""), false);
  });

  it("uses source priority and then name consistently with completion ordering", () => {
    const snippet_sid = [
      snippet("A user snippet", "user", ["go"]),
      snippet("Zulu workspace snippet", "workspace", ["go"]),
      snippet("Alpha workspace snippet", "workspace", ["go"]),
    ];
    const match = findExactPrefixMatch("  go", snippet_sid);
    assert.equal(match?.snippet.marker, "user:A user snippet");
    assert.equal(match?.prefix, "go");
    assert.equal(match?.startCharacter, 2);
  });

  it("requires every cursor to resolve to the same snippet and prefix", () => {
    const shared = snippet("Shared", "workspace", ["go", "run"]);
    const alternative = snippet("Alternative", "user", ["run"]);
    const snippet_sid = [alternative, shared];

    const agreed = findAgreedExactPrefixMatch(["go", "  go"], snippet_sid);
    assert.equal(agreed?.snippet, shared);
    assert.equal(agreed?.prefix, "go");
    assert.equal(findAgreedExactPrefixMatch(["go", "run"], snippet_sid), undefined);
    assert.equal(findAgreedExactPrefixMatch(["go", "not-go"], snippet_sid), undefined);
    assert.equal(findAgreedExactPrefixMatch([], snippet_sid), undefined);
  });
});
