# Changelog

## 0.3.0

- Require VS Code 1.100 or later so the integration test runner can use patched, supported development dependencies.
- Upgrade the lint, test, build, and packaging toolchain; enforce reviewed npm lifecycle scripts and automated dependency audits.

## 0.2.0

- Allow non-empty multi-character pad fill strings, repeated and truncated to the target UTF-16 width.
- Bound per-snippet and per-source scope count/text amplification before publication, and preflight duplicate-prefix indexing with fail-closed last-known-good behavior.
- Bound semantic diagnostics by per-source count and text budgets, reject oversized snippet names and configuration objects early, and preserve fail-closed last-known-good behavior when errors are omitted.
- Bound dynamic snippets by conservative rendered output, including mirrored defaults and numeric-transform amplification, before native insertion.
- Bound snippet syntax analysis and overlapping span validation for adversarial nested or malformed snippet grammar.
- Reject native variables in dynamic snippets while preserving static snippet compatibility.
- Reject numeric choices in dynamic snippets because choice UI navigation is not safely observable across supported VS Code versions; preserve choice syntax in static snippets.
- Reject driver groups whose generated edits cannot be safely offset-tracked across pads, remembered selections, and cursors.
- Account for resolved editor indent size, insertion mode, and target EOL normalization in pre-insertion rendering limits.
- Bound and validate sparse multicursor replacement ranges against the target document before insertion.
- Reject dynamic numeric spans containing source line breaks and coincident adjacent groups with distinct IDs; static snippets and same-ID mirrors are unchanged.
- Reject lone CR line breaks in dynamic bodies while preserving static bodies and supporting LF/CRLF.
- Discard pending dynamic state before evaluation after partial or unsafe command and best-effort navigation; cardinality-collapsed finals are accepted only at captured rendered insertion endpoints.
- Preserve already-accepted placeholder navigation after normal pad completion while invalidating stale queued generations on replacement or unsafe transitions.
- Measure session document length through UTF-16 offsets without materializing whole-document text.
- Multiple `${pad}` calls in one snippet.
- Named pad configurations through `${pad:name}` and `pads`.
- Pads may follow literal text and use the nearest preceding tab stop on their line.
- Mirrored tab stops can drive multiple pads together.

## 0.1.0

- Initial implementation of native-style snippets and `${pad}`.
- User and workspace JSONC configuration.
- Completion, exact Tab integration, validation, and safe overflow behavior.
