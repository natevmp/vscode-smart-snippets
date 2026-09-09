# Smart Snippets

Smart Snippets adds computed placeholders to native-feeling Visual Studio Code snippets. `${pad}` and `${pad:name}` fill the rest of their lines to configured widths when you leave their driving tab stops.

## Configure snippets

Run either command from the Command Palette:

- **Smart Snippets: Open User Snippets**
- **Smart Snippets: Open Workspace Snippets**

Workspace snippets are stored in `.vscode/smart-snippets.jsonc`. The user file is stored in the extension's global storage unless the user-level `smartSnippets.userSnippetFile` setting points to an absolute path.

```jsonc
{
  "Heading Level 1": {
    "scope": ["julia"],
    "prefix": "#h1",
    "body": [
      "## @h1 $1${pad}",
      "$0"
    ],
    "pad": {
      "fill": "-",
      "targetWidth": 80
    },
    "description": "Create a level 1 heading"
  }
}
```

Use named configurations when one snippet needs several independently configured pads:

```jsonc
{
  "Section Rules": {
    "prefix": "#rules",
    "body": [
      "Primary: ${1:title} ${pad:primary}",
      "Mirror: ${1} ${pad:mirror}",
      "Details: ${2:text} ${pad:details}",
      "$0"
    ],
    "pads": {
      "primary": { "fill": "-", "targetWidth": 80 },
      "mirror": { "fill": ".", "targetWidth": 72 },
      "details": { "fill": "=", "targetWidth": 64 }
    }
  }
}
```

`${pad}` uses `pad`; `${pad:name}` uses the matching entry in `pads`. Names must match `[A-Za-z_][A-Za-z0-9_-]{0,63}`. The two forms may be mixed, and a named configuration may be reused on several lines.

Fill values may contain multiple characters, such as `"- "`. The value is repeated from its beginning, and the final repetition is truncated as needed to reach `targetWidth` exactly.

Workspace definitions override user definitions with the same name.

## Use a snippet

1. Type the complete prefix (`#h1`) at the start of a line or after whitespace, then press Tab. You can also select Smart Snippets from the completion list.
2. Enter text at `$1`, `$2`, and other native tab stops.
3. Press Tab. Smart Snippets computes every pending pad driven by the tab stop being left, then continues native navigation.

If the non-padding text is already at least as wide as `targetWidth`, no padding is inserted.
Exact-prefix Tab expansion works without changing VS Code's `editor.tabCompletion` setting. When no Smart Snippet prefix matches, Tab keeps its normal editor behavior.
Each inserted pad is evaluated once. Revisiting an earlier tab stop does not rewrite existing padding, while pads attached to later tab stops remain pending.
If navigation produces a partial multicursor transition, Smart Snippets discards pending dynamic state without evaluating it, including in best-effort mode. On the final Tab, unchanged or cardinality-collapsed selections are accepted only when every surviving cursor is at a final position proven to be the rendered insertion endpoint (an implicit final stop, or one trailing zero-width `$0`/`${0}`). This preserves co-located exits such as `$1${pad}` and collapsed multicursor finals. Arbitrary explicit final stops still work when a complete, valid-cardinality movement is observable, but fail closed after a partial collapse or command no-op.

## Constraints

- Snippet names may contain at most 256 UTF-16 code units. A definition may have at most 16 own enumerable properties, and each pad configuration at most 8.
- A snippet may contain up to 128 active `${pad}` or `${pad:name}` tokens and 128 named pad configurations.
- A snippet may define up to 32 prefixes; each prefix may contain at most 256 UTF-16 code units.
- A snippet may define up to 256 non-empty comma-separated scope IDs, counted before deduplication, across at most 4,096 UTF-16 code units of scope strings.
- A body may contain up to 100,000 UTF-16 code units and 1,000 array lines.
- A pad token must be the final token on its source line or at the end of the body.
- The nearest preceding positive numeric tab stop on that source line drives the pad; literal text may appear between them.
- Mirrored occurrences of a driving tab-stop number are supported. Every pad driven by that number is evaluated together.
- Dynamic snippets with an active pad support numeric placeholders and numeric transforms. Numeric choices and native VS Code variables such as `$TM_FILENAME` or `${CLIPBOARD}` are static-only because their UI-driven transitions cannot be safely observed; static snippets without active pads preserve this syntax unchanged.
- Dynamic bodies cannot contain a CR that is not followed by LF. LF and CRLF bodies remain supported, while static snippet bodies preserve lone CR byte-for-byte for native handling.
- Dynamic numeric placeholder/default/transform spans cannot contain actual CR or LF characters. One-line numeric transforms remain supported.
- Source-adjacent top-level positive tab stops must use the same identifier: coincident distinct groups such as `$1$2` and `${1:first}${2:second}` are not observable safely. Same-ID mirrors remain supported.
- `pad.fill` must be a non-empty string and cannot contain a tab or newline; it is repeated and truncated to the required UTF-16 length.
- Width is measured in UTF-16 code units, so tabs and wide Unicode characters may not align visually.
- Native rendering must preserve the configured body line count. Dynamic definitions that could hide source line breaks inside numeric spans are rejected before insertion; an unexpected native line-count change still leaves the inserted snippet intact without uncertain pad tracking.
- Exact-prefix dynamic insertion is rejected before editing when a conservative placeholder/transform expansion bound exceeds 1,048,576 UTF-16 code units across all cursors. The bound uses the editor's resolved `indentSize`, `insertSpaces`, and target EOL, widening every tab by up to `indentSize - 1` even though native normalization only affects leading whitespace, plus one insertion-indent prefix per rendered line. Invalid or unresolved rendering options abort dynamic insertion.
- Multicursor replacement ranges must lie in the target document, cannot overlap or share a start, and may span at most 1,048,576 aggregate UTF-16 code units of gaps. A driver group's worst-case generated edit must also fit the shared offset-work limit.
- Multiple generated pads on the same physical line, more than 4,096 tracked pad instances, and nested Smart Snippets are not supported.

Supported native snippet constructs are handed to VS Code unchanged.

## Settings

- `smartSnippets.enablePrefixTabExpansion`: expand a complete configured prefix with Tab. Disable it to leave all pre-expansion Tab handling to VS Code and other extensions.
- `smartSnippets.enableTabInterception`: coordinate padding with native Tab navigation while a dynamic snippet is active. If disabled or unsupported by the installed VS Code version, Smart Snippets evaluates only complete, safely attributable observed selection transitions as a best-effort fallback.
- `smartSnippets.userSnippetFile`: optional absolute user-level path for a user snippet file. Workspace values are ignored.

Configuration errors appear in the Problems panel. Smart Snippets retains the last valid configuration while a file contains errors.
Each configuration source is limited to 1 MiB, 2,000 snippets, 5,000 prefixes, 100,000 raw non-empty scope IDs, 262,144 UTF-16 code units of scope strings, and 100 JSON nesting levels to keep untrusted workspace configuration bounded. Raw scope IDs are counted before normalization and deduplication. Duplicate-prefix conflict indexing is preflighted and rejected above 262,144 conservative `(prefix, scope)` work units. Semantic diagnostics are capped at 100 per source (including an omission summary), with at most 65,536 aggregate UTF-16 code units of retained paths and messages.

## Development

Development requires Node.js 22.13.x or Node.js 24 and later. Node.js 24 LTS is recommended.

```sh
npm install
npm run build
npm run test:unit
npm run test:vscode
```

Set `VSCODE_TEST_VERSION` to exercise a specific compatible release, for example `VSCODE_TEST_VERSION=1.90.0 npm run test:vscode`.
