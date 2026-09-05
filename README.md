# Smart Snippets

Smart Snippets adds computed placeholders to native-feeling Visual Studio Code snippets. The first computed placeholder, `${pad}`, fills the rest of its line to a configured width when you leave the preceding tab stop.

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

Workspace definitions override user definitions with the same name.

## Use a snippet

1. Type the complete prefix (`#h1`) at the start of a line or after whitespace, then press Tab. You can also select Smart Snippets from the completion list.
2. Enter text at `$1`.
3. Press Tab. Smart Snippets computes the padding as VS Code moves to the next native tab stop.

If the non-padding text is already at least as wide as `targetWidth`, no padding is inserted.
Exact-prefix Tab expansion works without changing VS Code's `editor.tabCompletion` setting. When no Smart Snippet prefix matches, Tab keeps its normal editor behavior.
For safety, the MVP evaluates each inserted `${pad}` once and then releases its tracking state; revisiting an earlier tab stop does not rewrite existing padding.

## MVP constraints

- A snippet may contain one unescaped `${pad}`.
- A snippet may define up to 32 prefixes; each prefix may contain at most 256 UTF-16 code units.
- A body may contain up to 100,000 UTF-16 code units and 1,000 array lines.
- `${pad}` must immediately follow the first positive numeric tab stop.
- The driving tab stop must occur exactly once.
- `pad.fill` must be one UTF-16 code unit and cannot be a tab or newline.
- Width is measured in UTF-16 code units, so tabs and wide Unicode characters may not align visually.
- Multiple active pads on the same physical line and nested Smart Snippets are not supported.

Other native snippet constructs are handed to VS Code unchanged.

## Settings

- `smartSnippets.enablePrefixTabExpansion`: expand a complete configured prefix with Tab. Disable it to leave all pre-expansion Tab handling to VS Code and other extensions.
- `smartSnippets.enableTabInterception`: coordinate padding with native Tab navigation while a dynamic snippet is active. If disabled or unsupported by the installed VS Code version, Smart Snippets evaluates on the observed selection transition as a best-effort fallback.
- `smartSnippets.userSnippetFile`: optional absolute user-level path for a user snippet file. Workspace values are ignored.

Configuration errors appear in the Problems panel. Smart Snippets retains the last valid configuration while a file contains errors.
Each configuration source is limited to 1 MiB, 2,000 snippets, 5,000 prefixes, and 100 JSON nesting levels to keep untrusted workspace configuration bounded.

## Development

Development requires Node.js 22.13.x or Node.js 24 and later. Node.js 24 LTS is recommended.

```sh
npm install
npm run build
npm run test:unit
npm run test:vscode
```

Set `VSCODE_TEST_VERSION` to exercise a specific compatible release, for example `VSCODE_TEST_VERSION=1.90.0 npm run test:vscode`.
