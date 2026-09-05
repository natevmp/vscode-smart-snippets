# Dynamic Snippet Extension — Specification

## 1. Overview

Build a VS Code extension that provides **dynamic, parameterized snippets** using a JSON configuration format intentionally modeled on native VS Code snippets.

The extension should preserve the normal snippet workflow:

1. Type a snippet prefix.
2. Trigger the snippet.
3. Edit `$1`, `$2`, etc.
4. Press `Tab` to move through tab stops.
5. Finish at `$0`.

The extension adds support for **computed placeholders** whose contents are generated dynamically from the surrounding text.

The first computed placeholder to implement is `${pad}`.

`${pad}` fills the remainder of the current line with a configured string until the line reaches a configured target width.

The design should be extensible so that other computed placeholders can be added later.

---

## 2. Primary Use Case

Example configuration:

```json
{
  "Heading Level 1": {
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

User workflow:

```text
#h1<Tab>
```

expands to:

```text
## @h1 |
```

The user types:

```text
## @h1 Bayesian inference|
```

and presses `Tab`.

The extension computes the number of fill characters needed and produces something equivalent to:

```text
## @h1 Bayesian inference --------------------------------------------------
|
```

The final fill should make the heading line reach the configured target width of 80 characters.

---

## 3. Design Goals

The extension should:

- Feel as close as possible to native VS Code snippets.
- Reuse familiar snippet concepts such as:
  - `prefix`
  - `body`
  - `description`
  - `$1`, `$2`, `$3`, ...
  - `$0`
- Add minimal extension-specific syntax.
- Support computed placeholders such as `${pad}`.
- Allow snippet-specific configuration of dynamic behavior.
- Keep snippet definitions declarative and human-readable.
- Permit future computed placeholders without redesigning the file format.
- Work independently of programming language where possible.

The extension should **not** initially attempt to replace the entire VS Code snippet engine.

---

## 4. Proposed Configuration Format

The configuration format should resemble native VS Code snippet JSON.

Example:

```json
{
  "Heading Level 1": {
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

### Required snippet properties

#### `prefix`

```json
"prefix": "#h1"
```

The trigger used to invoke the dynamic snippet.

Ideally this behaves similarly to native snippet prefixes and can participate in VS Code completion.

---

#### `body`

```json
"body": [
  "## @h1 $1${pad}",
  "$0"
]
```

The snippet body.

It should support standard snippet-style tab stops:

```text
$1
$2
$3
...
$0
```

The first custom computed placeholder is:

```text
${pad}
```

---

#### `description`

```json
"description": "Create a level 1 heading"
```

Human-readable description shown in completion UI where applicable.

---

## 5. `${pad}` Computed Placeholder

`${pad}` is a dynamic placeholder whose rendered value is calculated from the current line.

Example:

```text
## @h1 $1${pad}
```

Configuration:

```json
"pad": {
  "fill": "-",
  "targetWidth": 80
}
```

If `$1` contains:

```text
Bayesian inference
```

then `${pad}` should expand to enough `-` characters to make the full line reach the configured width.

Conceptually:

```text
padLength = targetWidth - currentLineLengthWithoutPad
```

then:

```text
padValue = fill repeated until padLength is reached
```

---

## 6. Padding Semantics

### Target width

`targetWidth` represents the desired final line width.

Example:

```json
"targetWidth": 80
```

The extension should calculate padding against the full contents of the line containing `${pad}`.

---

### Fill string

Example:

```json
"fill": "-"
```

The fill value should ideally be a string rather than strictly a single character.

This permits future usage such as:

```json
"fill": "- "
```

or:

```json
"fill": "·"
```

For the MVP, supporting single-character fills is acceptable if it simplifies implementation.

---

### Overflow behavior

If the text before and after `${pad}` already exceeds `targetWidth`, the default behavior should be:

```text
insert no padding
```

The extension must never insert a negative number of characters or delete user content automatically.

Possible future configuration:

```json
"overflow": "none"
```

Future alternatives could include:

```text
truncate
error
warn
```

but these are out of scope for the MVP.

---

## 7. When Padding Is Evaluated

For the initial implementation, `${pad}` should be evaluated when the user leaves the relevant editable tab stop.

Typical flow:

```text
$1 -> Tab -> recompute ${pad} -> move to next tab stop
```

Example:

```text
## @h1 $1${pad}
```

The user edits `$1`.

When they press `Tab` to leave `$1`:

1. Determine the current text on the line.
2. Exclude the existing `${pad}` generated region from the measurement.
3. Calculate the required padding.
4. Replace the generated padding region.
5. Continue normal tab-stop navigation.

A future version may support live recomputation while `$1` is edited, but this is not required for the MVP.

---

## 8. Snippet Lifecycle

Recommended lifecycle:

### Step 1 — Completion

The extension registers configured prefixes as VS Code completion items.

Example:

```text
#h1
```

appears as a snippet-like completion.

---

### Step 2 — Expansion

When selected, the configured body is inserted.

The extension should preserve snippet tab-stop behavior using VS Code's snippet APIs wherever possible.

---

### Step 3 — User edits tab stop

The user types into `$1`, `$2`, etc.

---

### Step 4 — Dynamic placeholder calculation

When moving away from the tab stop associated with a dynamic placeholder, the extension computes the placeholder's value.

For `${pad}`, this means padding the current line to `targetWidth`.

---

### Step 5 — Continue snippet navigation

After the computed placeholder is updated, tab navigation continues normally.

Eventually `$0` ends the snippet session.

---

## 9. Important Implementation Principle

`${pad}` should be treated conceptually as a **computed snippet placeholder**, not merely as a command such as "pad current line".

This distinction is important.

The desired user mental model is:

> I am using a snippet with dynamic fields.

Not:

> I inserted a snippet and then ran a separate line-formatting command.

This should guide both architecture and UX decisions.

---

## 10. Proposed Internal Representation

The extension may preprocess the configured body before handing it to VS Code's `SnippetString`.

For example:

```text
## @h1 $1${pad}
```

could internally become something such as:

```text
## @h1 $1<managed-placeholder>
```

The extension must retain metadata indicating:

- which dynamic placeholder occupies that location;
- which line it belongs to;
- which configuration controls it;
- which snippet instance it belongs to.

A generated range, decoration, marker, or hidden metadata structure can then be used to update the placeholder when required.

The exact mechanism is implementation-dependent.

---

## 11. Recommended Architecture

Suggested components:

### Configuration loader

Responsibilities:

- Locate the extension's snippet configuration files.
- Parse JSON.
- Validate snippet definitions.
- Watch for configuration changes if practical.
- Produce an internal snippet model.

---

### Completion provider

Responsibilities:

- Register configured prefixes.
- Show snippet name and description.
- Trigger dynamic snippet insertion.

Likely VS Code API:

```text
CompletionItemProvider
```

---

### Snippet engine / expansion layer

Responsibilities:

- Convert the configured body into a `SnippetString`.
- Preserve `$1`, `$2`, etc.
- Track computed placeholders.
- Insert the snippet into the editor.

Prefer using VS Code's native snippet functionality rather than manually recreating tab-stop editing.

---

### Dynamic placeholder manager

Responsibilities:

- Track `${pad}` locations for active snippets.
- Recalculate generated content.
- Maintain valid ranges when surrounding content changes.
- Avoid modifying user-entered text.

---

### Pad evaluator

Input:

```text
document
line
placeholder range
pad configuration
```

Output:

```text
computed padding string
```

Core logic:

```text
availableWidth = targetWidth - lineWidthWithoutGeneratedPadding
```

Then repeat the fill string until the appropriate width is reached.

---

## 12. Configuration Validation

The extension should report useful errors for malformed definitions.

Examples:

### Missing `fill`

```json
"pad": {
  "targetWidth": 80
}
```

Suggested error:

```text
Snippet "Heading Level 1": ${pad} is used but pad.fill is not configured.
```

---

### Missing `targetWidth`

```json
"pad": {
  "fill": "-"
}
```

Suggested error:

```text
Snippet "Heading Level 1": ${pad} is used but pad.targetWidth is not configured.
```

---

### Invalid target width

```json
"targetWidth": -20
```

Suggested error:

```text
pad.targetWidth must be a positive integer.
```

---

## 13. Character Width Definition

For the MVP, `targetWidth` should mean **string/code-unit length of the line**, rather than rendered pixel width.

This is sufficient for common ASCII heading separators such as:

```text
-
=
#
```

Tabs and wide Unicode characters introduce ambiguity.

Suggested MVP behavior:

- treat normal ASCII characters as width 1;
- document that tabs and wide Unicode characters may not visually align exactly.

A future release may support display-column-aware width calculation.

---

## 14. Multiple Dynamic Placeholders

Multiple pads do not need to be supported in the first MVP, but the architecture should not prevent them.

Possible future syntax:

```text
${pad:left}
${pad:right}
```

with configuration:

```json
"pads": {
  "left": {
    "fill": "-",
    "targetWidth": 20
  },
  "right": {
    "fill": "-",
    "targetWidth": 80
  }
}
```

Do not implement this unless it falls out naturally from the initial architecture.

---

## 15. Inline Overrides — Future Feature

A later version could allow inline parameters.

Examples:

```text
${pad}
${pad:60}
${pad:80:-}
```

Possible semantics:

```text
${pad}
```

Use snippet-level defaults.

```text
${pad:60}
```

Override target width.

```text
${pad:80:-}
```

Override target width and fill string.

This is explicitly **not required for the MVP**, but the parser should ideally not make this extension impossible.

---

## 16. Prefix Parameters — Future Feature

A later version may support parameters supplied as part of the snippet trigger.

Example:

```text
#h1:100
```

could invoke the `#h1` snippet with:

```text
targetWidth = 100
```

This would permit per-invocation configuration while retaining the snippet workflow.

Possible examples:

```text
#h1
#h1:60
#h1:80
#h1:120
```

The default width would still come from the JSON configuration.

This is desirable but should be considered a second-stage feature after basic `${pad}` behavior works reliably.

---

## 17. Example Snippet File

```json
{
  "Heading Level 1": {
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
  },

  "Heading Level 2": {
    "prefix": "#h2",
    "body": [
      "### @h2 $1${pad}",
      "$0"
    ],
    "pad": {
      "fill": "-",
      "targetWidth": 72
    },
    "description": "Create a level 2 heading"
  }
}
```

---

## 18. MVP Requirements

The first working version should support:

- A JSON snippet configuration file.
- Multiple named snippets.
- `prefix`.
- `body`.
- `description`.
- Standard tab stops:
  - `$1`
  - `$2`
  - etc.
  - `$0`
- `${pad}`.
- Per-snippet:
  - `pad.fill`
  - `pad.targetWidth`
- Completion-based snippet triggering.
- Dynamic pad calculation after editing the preceding tab stop.
- Safe behavior when the line exceeds the target width.
- Multiple snippet definitions in one file.
- At minimum, activation for Julia files.
- Preferably language-agnostic architecture.

---

## 19. Explicitly Out of Scope for MVP

Do not initially implement:

- A complete replacement for VS Code's snippet parser.
- Arbitrary arithmetic expressions inside snippets.
- JavaScript execution from configuration.
- Live padding on every keystroke.
- Multiple named pad placeholders.
- Pixel-based visual alignment.
- Sophisticated Unicode display-width handling.
- Prefix arguments such as `#h1:100`.
- Inline syntax such as `${pad:80:-}`.
- User-defined computed placeholder functions.

These can be considered after the basic architecture is stable.

---

## 20. Suggested Development Order

1. Create a minimal VS Code extension.
2. Hard-code one dynamic heading snippet.
3. Insert it using `SnippetString`.
4. Confirm native `$1` / `$0` navigation works.
5. Find a reliable mechanism to track a generated pad range.
6. Recompute that range when the user leaves `$1`.
7. Generalize the behavior into a `${pad}` evaluator.
8. Add JSON configuration loading.
9. Register snippet prefixes dynamically.
10. Add validation and helpful error messages.
11. Test multiple simultaneous editors/snippet instances.
12. Add language configuration.
13. Only then consider parameterized triggers such as `#h1:100`.

---

## 21. Acceptance Tests

### Basic expansion

Given:

```json
{
  "prefix": "#h1",
  "body": [
    "## @h1 $1${pad}",
    "$0"
  ],
  "pad": {
    "fill": "-",
    "targetWidth": 80
  }
}
```

typing:

```text
#h1
```

and selecting the snippet should insert the body and place the cursor at `$1`.

---

### Tab navigation

After typing text in `$1`, pressing `Tab` must:

1. update `${pad}`;
2. preserve the user-entered heading;
3. move to the next snippet tab stop.

---

### Correct width

For ASCII input, the resulting line containing `${pad}` must have:

```text
length == targetWidth
```

unless the non-padding content already exceeds the target width.

---

### Overflow

If:

```text
nonPaddingLength >= targetWidth
```

then:

```text
${pad} == ""
```

and user text must remain untouched.

---

### Different snippets

Two snippets may have:

```json
"targetWidth": 80
```

and:

```json
"targetWidth": 60
```

respectively.

Each must use its own configured width.

---

### Different fill strings

One snippet may use:

```json
"fill": "-"
```

while another uses:

```json
"fill": "="
```

Each must render independently.

---

## 22. UX Principle

The extension should remain almost invisible during normal use.

From the user's perspective:

```text
type prefix
→ Tab
→ type content
→ Tab
→ dynamic snippet finishes its computation
→ continue typing
```

The extra dynamic behavior should feel like a natural extension of VS Code snippets rather than a separate command system.

---

## 23. Long-Term Direction

The underlying abstraction should be:

> **VS Code snippets with computed placeholders and optional invocation parameters.**

`${pad}` is the first computed placeholder.

Potential future placeholders might include concepts such as:

```text
${date}
${uuid}
${repeat}
${align}
${column}
```

However, future functionality should only be added where it fits the declarative snippet model and does not turn the configuration format into a general-purpose scripting language.

The project's core value is preserving the simplicity and ergonomics of native snippets while allowing a small amount of dynamic computation that native VS Code snippets cannot express.
