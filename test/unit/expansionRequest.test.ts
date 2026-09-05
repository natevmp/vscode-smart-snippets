import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseExpandAtPrefixOptions } from "../../src/completion/expansionRequest.js";

const requestedSnippet = {
  snippetName: "Heading",
  sourceUri: "file:///snippets.jsonc",
  prefix: "#h1",
  targetDocumentUri: "file:///target.jl",
};

describe("exact-prefix command options", () => {
  it("copies valid plain command options", () => {
    assert.deepEqual(parseExpandAtPrefixOptions({
      requestedSnippet,
    }), {
      requestValid: true,
      requestedSnippet,
    });
  });

  it("ignores malformed, inherited, and accessor-backed values", () => {
    assert.deepEqual(
      parseExpandAtPrefixOptions({ requestedSnippet: { ...requestedSnippet, prefix: "" } }),
      { requestValid: false },
    );
    assert.deepEqual(
      parseExpandAtPrefixOptions(Object.create({ requestedSnippet })),
      { requestValid: false },
    );
    const hostile = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(hostile, "requestedSnippet", {
      get: () => { throw new Error("nope"); },
    });
    assert.deepEqual(parseExpandAtPrefixOptions(hostile), { requestValid: false });
  });
});
