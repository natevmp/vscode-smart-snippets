import {
  MAX_PAD_TARGET_WIDTH,
  MAX_PREFIXES_PER_SNIPPET,
  MAX_SNIPPET_BODY_LENGTH,
  MAX_SNIPPET_BODY_LINES,
  MAX_SNIPPET_PREFIX_LENGTH,
  type NamedSnippetDefinition,
  type PadConfiguration,
  type ParsedSnippets,
  type SnippetDefinition,
  type SnippetIssue,
} from "./types.js";
import { findDynamicPadTokens } from "./syntax.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function snippetPath(name: string, property?: string): string {
  const base = `$[${JSON.stringify(name)}]`;
  return property === undefined ? base : `${base}.${property}`;
}

function issue(
  severity: "error" | "warning",
  name: string,
  property: string | undefined,
  message: string,
): SnippetIssue {
  return { severity, snippetName: name, path: snippetPath(name, property), message };
}

function isStringOrStringArray(value: unknown): value is string | readonly string[] {
  return typeof value === "string"
    || (Array.isArray(value) && value.every((element) => typeof element === "string"));
}

function joinedBodyLength(body: string | readonly string[]): number {
  if (typeof body === "string") {
    return body.length;
  }
  let length = Math.max(0, body.length - 1);
  for (const line of body) {
    length += line.length;
    if (length > MAX_SNIPPET_BODY_LENGTH) {
      break;
    }
  }
  return length;
}

function validatePad(
  value: unknown,
  name: string,
  issue_iid: SnippetIssue[],
): PadConfiguration | undefined {
  if (!isRecord(value)) {
    issue_iid.push(issue("error", name, "pad", "pad must be an object with fill and targetWidth."));
    return undefined;
  }

  let valid = true;
  if (typeof value.fill !== "string" || value.fill.length !== 1 || /[\r\n\t]/u.test(value.fill)) {
    issue_iid.push(issue(
      "error",
      name,
      "pad.fill",
      "pad.fill must be exactly one non-newline, non-tab UTF-16 code unit.",
    ));
    valid = false;
  }
  if (typeof value.targetWidth !== "number"
    || !Number.isInteger(value.targetWidth)
    || value.targetWidth <= 0
    || value.targetWidth > MAX_PAD_TARGET_WIDTH) {
    issue_iid.push(issue(
      "error",
      name,
      "pad.targetWidth",
      `pad.targetWidth must be a positive integer no greater than ${MAX_PAD_TARGET_WIDTH}.`,
    ));
    valid = false;
  }

  return valid
    ? { fill: value.fill as string, targetWidth: value.targetWidth as number }
    : undefined;
}

function validateDefinition(
  name: string,
  value: unknown,
  issue_iid: SnippetIssue[],
): NamedSnippetDefinition | undefined {
  if (!isRecord(value)) {
    issue_iid.push(issue("error", name, undefined, "Snippet definition must be an object."));
    return undefined;
  }

  let valid = true;
  if (!isStringOrStringArray(value.prefix)
    || value.prefix.length === 0
    || (Array.isArray(value.prefix) && value.prefix.some((prefix) => prefix.length === 0))) {
    issue_iid.push(issue("error", name, "prefix", "prefix must be a non-empty string or a non-empty array of non-empty strings."));
    valid = false;
  } else {
    const prefix_pid = typeof value.prefix === "string" ? [value.prefix] : value.prefix;
    if (prefix_pid.length > MAX_PREFIXES_PER_SNIPPET) {
      issue_iid.push(issue(
        "error",
        name,
        "prefix",
        `A snippet may define at most ${MAX_PREFIXES_PER_SNIPPET} prefixes.`,
      ));
      valid = false;
    } else if (prefix_pid.some((prefix) => prefix.length > MAX_SNIPPET_PREFIX_LENGTH)) {
      issue_iid.push(issue(
        "error",
        name,
        "prefix",
        `Each prefix must contain no more than ${MAX_SNIPPET_PREFIX_LENGTH} UTF-16 code units.`,
      ));
      valid = false;
    }
  }
  let bodyWithinLimits = false;
  if (!isStringOrStringArray(value.body) || value.body.length === 0) {
    issue_iid.push(issue("error", name, "body", "body must be a non-empty string or a non-empty array whose joined body is non-empty."));
    valid = false;
  } else if (Array.isArray(value.body) && value.body.length > MAX_SNIPPET_BODY_LINES) {
    issue_iid.push(issue(
      "error",
      name,
      "body",
      `A snippet body may contain at most ${MAX_SNIPPET_BODY_LINES} lines.`,
    ));
    valid = false;
  } else {
    const bodyLength = joinedBodyLength(value.body);
    if (bodyLength === 0) {
      issue_iid.push(issue("error", name, "body", "body must not be empty after its lines are joined."));
      valid = false;
    } else if (bodyLength > MAX_SNIPPET_BODY_LENGTH) {
      issue_iid.push(issue(
        "error",
        name,
        "body",
        `A snippet body may contain at most ${MAX_SNIPPET_BODY_LENGTH} UTF-16 code units.`,
      ));
      valid = false;
    } else {
      bodyWithinLimits = true;
    }
  }
  if (value.description !== undefined && typeof value.description !== "string") {
    issue_iid.push(issue("error", name, "description", "description must be a string."));
    valid = false;
  }
  if (value.scope !== undefined) {
    const scope_sid = typeof value.scope === "string"
      ? [value.scope]
      : Array.isArray(value.scope)
        ? value.scope
        : [];
    if (!isStringOrStringArray(value.scope)
      || value.scope.length === 0
      || scope_sid.some((scope) => typeof scope !== "string"
        || !scope.split(",").some((languageId) => languageId.trim().length > 0))) {
      issue_iid.push(issue(
        "error",
        name,
        "scope",
        "scope must contain at least one non-empty language ID in every string value.",
      ));
      valid = false;
    }
  }

  let pad: PadConfiguration | undefined;
  if (value.pad !== undefined) {
    pad = validatePad(value.pad, name, issue_iid);
    if (pad === undefined) {
      valid = false;
    }
  }

  if (bodyWithinLimits && (typeof value.body === "string" || Array.isArray(value.body))) {
    const body = typeof value.body === "string" ? value.body : value.body.join("\n");
    const padCount = findDynamicPadTokens(body).length;
    if (padCount > 0 && value.pad === undefined) {
      issue_iid.push(issue("error", name, "body", "${pad} requires a valid pad configuration."));
      valid = false;
    } else if (padCount === 0 && pad !== undefined) {
      issue_iid.push(issue("warning", name, "pad", "pad configuration is unused because body has no unescaped ${pad} token."));
    }
  }

  if (!valid) {
    return undefined;
  }

  const definition: SnippetDefinition = {
    prefix: value.prefix as string | readonly string[],
    body: value.body as string | readonly string[],
    ...(value.description === undefined ? {} : { description: value.description as string }),
    ...(value.scope === undefined ? {} : { scope: value.scope as string | readonly string[] }),
    ...(pad === undefined ? {} : { pad }),
  };
  return { name, definition };
}

/** Parses already-decoded JSON and returns structurally valid named definitions. */
export function parseSnippetDefinitions(value: unknown): ParsedSnippets {
  const snippet_sid: NamedSnippetDefinition[] = [];
  const issue_iid: SnippetIssue[] = [];

  if (!isRecord(value)) {
    return {
      snippet_sid,
      issue_iid: [{
        severity: "error",
        path: "$",
        message: "The snippet file must contain a top-level object of named snippets.",
      }],
    };
  }

  for (const [name, definitionValue] of Object.entries(value)) {
    const snippet = validateDefinition(name, definitionValue, issue_iid);
    if (snippet !== undefined) {
      snippet_sid.push(snippet);
    }
  }
  return { snippet_sid, issue_iid };
}
