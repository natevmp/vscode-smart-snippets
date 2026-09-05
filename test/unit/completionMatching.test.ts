import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  getPrefixBoundaryStarts,
  matchSnippetPrefixes,
} from "../../src/completion/matching.js";

describe("completion prefix matching", () => {
  it("matches exact and partial punctuation prefixes at line start", () => {
    assert.deepEqual(matchSnippetPrefixes("#h", ["#h1", "#h2"], false), [
      { prefix: "#h1", typed: "#h", startCharacter: 0 },
      { prefix: "#h2", typed: "#h", startCharacter: 0 },
    ]);
    assert.deepEqual(matchSnippetPrefixes("#h1", ["#h1"], false), [
      { prefix: "#h1", typed: "#h1", startCharacter: 0 },
    ]);
  });

  it("uses a same-line replacement start immediately after whitespace", () => {
    assert.deepEqual(matchSnippetPrefixes("const value =  #", ["#h1"], false), [
      { prefix: "#h1", typed: "#", startCharacter: 15 },
    ]);
    assert.deepEqual(matchSnippetPrefixes("say hello w", ["hello world"], false), [
      { prefix: "hello world", typed: "hello w", startCharacter: 4 },
    ]);
  });

  it("does not consume unrelated text and only allows empty explicit matches", () => {
    assert.deepEqual(matchSnippetPrefixes("value#h", ["#h1"], true), []);
    assert.deepEqual(matchSnippetPrefixes("  ", ["one", "two"], false), []);
    assert.deepEqual(matchSnippetPrefixes("  ", ["one", "two"], true), [
      { prefix: "one", typed: "", startCharacter: 2 },
      { prefix: "two", typed: "", startCharacter: 2 },
    ]);
  });

  it("deduplicates equivalent prefix entries", () => {
    assert.deepEqual(matchSnippetPrefixes("a", ["alpha", "alpha"], false), [
      { prefix: "alpha", typed: "a", startCharacter: 0 },
    ]);
  });

  it("bounds boundary scanning by the longest configured prefix", () => {
    const lineBeforeCursor = `${"x".repeat(100_000)} #h`;
    const boundary_bid = getPrefixBoundaryStarts(lineBeforeCursor, 3);
    assert.deepEqual(boundary_bid, [100_001]);
    assert.deepEqual(
      matchSnippetPrefixes(lineBeforeCursor, ["#h1"], false, boundary_bid),
      [{ prefix: "#h1", typed: "#h", startCharacter: 100_001 }],
    );
  });
});
