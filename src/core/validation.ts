import {
  MAX_NAMED_PAD_CONFIGURATIONS,
  MAX_PAD_CONFIGURATION_PROPERTIES,
  MAX_PADS_PER_SNIPPET,
  MAX_PAD_TARGET_WIDTH,
  MAX_PREFIXES_PER_SNIPPET,
  MAX_SCOPE_IDS_PER_SNIPPET,
  MAX_SCOPE_TEXT_LENGTH_PER_SNIPPET,
  MAX_SNIPPET_BODY_LENGTH,
  MAX_SNIPPET_BODY_LINES,
  MAX_SNIPPET_DEFINITION_PROPERTIES,
  MAX_SNIPPET_NAME_LENGTH,
  MAX_SNIPPET_PREFIX_LENGTH,
  type NamedSnippetDefinition,
  type PadConfiguration,
  type ParsedSnippets,
  type SnippetDefinition,
  type SnippetIssue,
} from "./types.js";
import {
  boundIssuePathSegment,
  quoteIssuePathSegment,
  SemanticIssueCollector,
} from "./issueBudget.js";
import { analyzeSnippetSyntax } from "./syntax.js";

const PAD_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/u;
const DOT_PATH_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const SNIPPET_PROPERTY_NAME_SET = new Set([
  "prefix",
  "body",
  "description",
  "scope",
  "pad",
  "pads",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface BoundedPropertyNames {
  readonly propertyName_pid: readonly string[];
  readonly exceeded: boolean;
}

function ownPropertyNamesThroughLimit(
  value: Record<string, unknown>,
  maximumCount: number,
): BoundedPropertyNames {
  const propertyName_pid: string[] = [];
  for (const propertyName in value) {
    if (!Object.hasOwn(value, propertyName)) {
      continue;
    }
    propertyName_pid.push(propertyName);
    if (propertyName_pid.length > maximumCount) {
      return { propertyName_pid, exceeded: true };
    }
  }
  return { propertyName_pid, exceeded: false };
}

function snippetPath(name: string, property?: string): string {
  const base = `$[${quoteIssuePathSegment(name)}]`;
  return property === undefined
    ? base
    : property.startsWith("[") ? `${base}${property}` : `${base}.${property}`;
}

function issue(
  severity: "error" | "warning",
  name: string,
  property: string | undefined,
  message: string,
): SnippetIssue {
  return { severity, snippetName: name, path: snippetPath(name, property), message };
}

function namedPadProperty(configurationName: string): string {
  const boundedName = boundIssuePathSegment(configurationName);
  return DOT_PATH_NAME_PATTERN.test(configurationName)
    ? `pads.${boundedName}`
    : `pads[${quoteIssuePathSegment(configurationName)}]`;
}

function snippetDefinitionProperty(propertyName: string): string {
  const boundedName = boundIssuePathSegment(propertyName);
  return DOT_PATH_NAME_PATTERN.test(propertyName)
    ? boundedName
    : `[${quoteIssuePathSegment(propertyName)}]`;
}

function nestedProperty(parent: string, property: string): string {
  const boundedProperty = boundIssuePathSegment(property);
  return DOT_PATH_NAME_PATTERN.test(property)
    ? `${parent}.${boundedProperty}`
    : `${parent}[${quoteIssuePathSegment(property)}]`;
}

function namedPadToken(configurationName: string): string {
  return `\${pad:${configurationName}}`;
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

type ScopeValidationFailure = "invalid" | "count" | "text";

/** Counts non-empty comma-delimited fields without materializing an unbounded split. */
function countScopeIds(value: string, maximumCount: number): number {
  let count = 0;
  let segmentHasContent = false;
  for (let index = 0; index <= value.length; index += 1) {
    const character = value[index];
    if (character === undefined || character === ",") {
      if (segmentHasContent) {
        count += 1;
        if (count > maximumCount) {
          return count;
        }
      }
      segmentHasContent = false;
    } else if (character.trim().length > 0) {
      segmentHasContent = true;
    }
  }
  return count;
}

function validateScope(value: unknown): ScopeValidationFailure | undefined {
  const scopeValue_sid: readonly unknown[] = typeof value === "string"
    ? [value]
    : Array.isArray(value)
      ? value
      : [];
  if (scopeValue_sid.length === 0 || scopeValue_sid.length > MAX_SCOPE_IDS_PER_SNIPPET) {
    return scopeValue_sid.length > MAX_SCOPE_IDS_PER_SNIPPET ? "count" : "invalid";
  }

  let textLength = 0;
  for (const scopeValue of scopeValue_sid) {
    if (typeof scopeValue !== "string") {
      return "invalid";
    }
    textLength += scopeValue.length;
    if (textLength > MAX_SCOPE_TEXT_LENGTH_PER_SNIPPET) {
      return "text";
    }
  }

  let scopeIdCount = 0;
  for (const scopeValue of scopeValue_sid as readonly string[]) {
    const valueCount = countScopeIds(scopeValue, MAX_SCOPE_IDS_PER_SNIPPET - scopeIdCount);
    if (valueCount === 0) {
      return "invalid";
    }
    scopeIdCount += valueCount;
    if (scopeIdCount > MAX_SCOPE_IDS_PER_SNIPPET) {
      return "count";
    }
  }
  return undefined;
}

function validatePad(
  value: unknown,
  name: string,
  property: string,
  issueCollector: SemanticIssueCollector,
): PadConfiguration | undefined {
  if (!isRecord(value)) {
    issueCollector.add(issue("error", name, property, `${property} must be an object with fill and targetWidth.`));
    return undefined;
  }

  let valid = true;
  const padProperties = ownPropertyNamesThroughLimit(value, MAX_PAD_CONFIGURATION_PROPERTIES);
  if (padProperties.exceeded) {
    issueCollector.add(issue(
      "error",
      name,
      property,
      `Pad configurations may contain at most ${MAX_PAD_CONFIGURATION_PROPERTIES} own enumerable properties.`,
    ));
    valid = false;
  } else {
    for (const propertyName of padProperties.propertyName_pid) {
      if (propertyName === "fill" || propertyName === "targetWidth") {
        continue;
      }
      const extraProperty = nestedProperty(property, propertyName);
      issueCollector.add(issue(
        "error",
        name,
        extraProperty,
        `${extraProperty} is not allowed; pad configurations may contain only fill and targetWidth.`,
      ));
      valid = false;
    }
  }
  if (typeof value.fill !== "string" || value.fill.length === 0 || /[\r\n\t]/u.test(value.fill)) {
    issueCollector.add(issue(
      "error",
      name,
      `${property}.fill`,
      `${property}.fill must be a non-empty string containing no newline or tab characters.`,
    ));
    valid = false;
  }
  if (typeof value.targetWidth !== "number"
    || !Number.isInteger(value.targetWidth)
    || value.targetWidth <= 0
    || value.targetWidth > MAX_PAD_TARGET_WIDTH) {
    issueCollector.add(issue(
      "error",
      name,
      `${property}.targetWidth`,
      `${property}.targetWidth must be a positive integer no greater than ${MAX_PAD_TARGET_WIDTH}.`,
    ));
    valid = false;
  }

  return valid
    ? { fill: value.fill as string, targetWidth: value.targetWidth as number }
    : undefined;
}

function validateNamedPads(
  value: unknown,
  name: string,
  issueCollector: SemanticIssueCollector,
): Readonly<Record<string, PadConfiguration>> | undefined {
  if (!isRecord(value)) {
    issueCollector.add(issue("error", name, "pads", "pads must be an object of named pad configurations."));
    return undefined;
  }

  const namedPadProperties = ownPropertyNamesThroughLimit(value, MAX_NAMED_PAD_CONFIGURATIONS);
  if (namedPadProperties.exceeded) {
    issueCollector.add(issue(
      "error",
      name,
      "pads",
      `pads may contain at most ${MAX_NAMED_PAD_CONFIGURATIONS} named configurations.`,
    ));
    return undefined;
  }

  let valid = true;
  const configuration_cid: [string, PadConfiguration][] = [];
  for (const configurationName of namedPadProperties.propertyName_pid) {
    const property = namedPadProperty(configurationName);
    if (!PAD_NAME_PATTERN.test(configurationName)) {
      issueCollector.add(issue(
        "error",
        name,
        property,
        "Named pad keys must match [A-Za-z_][A-Za-z0-9_-]{0,63}.",
      ));
      valid = false;
      continue;
    }
    const configuration = validatePad(value[configurationName], name, property, issueCollector);
    if (configuration === undefined) {
      valid = false;
    } else {
      configuration_cid.push([configurationName, configuration]);
    }
  }

  return valid ? Object.fromEntries(configuration_cid) : undefined;
}

function validateDefinition(
  name: string,
  value: unknown,
  issueCollector: SemanticIssueCollector,
): NamedSnippetDefinition | undefined {
  if (!isRecord(value)) {
    issueCollector.add(issue("error", name, undefined, "Snippet definition must be an object."));
    return undefined;
  }

  let valid = true;
  const definitionProperties = ownPropertyNamesThroughLimit(
    value,
    MAX_SNIPPET_DEFINITION_PROPERTIES,
  );
  if (definitionProperties.exceeded) {
    issueCollector.add(issue(
      "error",
      name,
      undefined,
      `Snippet definitions may contain at most ${MAX_SNIPPET_DEFINITION_PROPERTIES} own enumerable properties.`,
    ));
    valid = false;
  } else {
    for (const propertyName of definitionProperties.propertyName_pid) {
      if (SNIPPET_PROPERTY_NAME_SET.has(propertyName)) {
        continue;
      }
      const extraProperty = snippetDefinitionProperty(propertyName);
      issueCollector.add(issue(
        "error",
        name,
        extraProperty,
        `${extraProperty} is not allowed; snippet definitions may contain only prefix, body, description, scope, pad, and pads.`,
      ));
      valid = false;
    }
  }
  if (!isStringOrStringArray(value.prefix)
    || value.prefix.length === 0
    || (Array.isArray(value.prefix) && value.prefix.some((prefix) => prefix.length === 0))) {
    issueCollector.add(issue("error", name, "prefix", "prefix must be a non-empty string or a non-empty array of non-empty strings."));
    valid = false;
  } else {
    const prefix_pid = typeof value.prefix === "string" ? [value.prefix] : value.prefix;
    if (prefix_pid.length > MAX_PREFIXES_PER_SNIPPET) {
      issueCollector.add(issue(
        "error",
        name,
        "prefix",
        `A snippet may define at most ${MAX_PREFIXES_PER_SNIPPET} prefixes.`,
      ));
      valid = false;
    } else if (prefix_pid.some((prefix) => prefix.length > MAX_SNIPPET_PREFIX_LENGTH)) {
      issueCollector.add(issue(
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
    issueCollector.add(issue("error", name, "body", "body must be a non-empty string or a non-empty array whose joined body is non-empty."));
    valid = false;
  } else if (Array.isArray(value.body) && value.body.length > MAX_SNIPPET_BODY_LINES) {
    issueCollector.add(issue(
      "error",
      name,
      "body",
      `A snippet body may contain at most ${MAX_SNIPPET_BODY_LINES} lines.`,
    ));
    valid = false;
  } else {
    const bodyLength = joinedBodyLength(value.body);
    if (bodyLength === 0) {
      issueCollector.add(issue("error", name, "body", "body must not be empty after its lines are joined."));
      valid = false;
    } else if (bodyLength > MAX_SNIPPET_BODY_LENGTH) {
      issueCollector.add(issue(
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
    issueCollector.add(issue("error", name, "description", "description must be a string."));
    valid = false;
  }
  if (value.scope !== undefined) {
    const scopeFailure = validateScope(value.scope);
    if (scopeFailure !== undefined) {
      const message = scopeFailure === "count"
        ? `scope may contain at most ${MAX_SCOPE_IDS_PER_SNIPPET} non-empty comma-separated language IDs per snippet, counted before deduplication.`
        : scopeFailure === "text"
          ? `scope strings may contain at most ${MAX_SCOPE_TEXT_LENGTH_PER_SNIPPET} aggregate UTF-16 code units per snippet.`
          : "scope must contain at least one non-empty language ID in every string value.";
      issueCollector.add(issue("error", name, "scope", message));
      valid = false;
    }
  }

  let pad: PadConfiguration | undefined;
  if (value.pad !== undefined) {
    pad = validatePad(value.pad, name, "pad", issueCollector);
    if (pad === undefined) {
      valid = false;
    }
  }

  let pads: Readonly<Record<string, PadConfiguration>> | undefined;
  if (value.pads !== undefined) {
    pads = validateNamedPads(value.pads, name, issueCollector);
    if (pads === undefined) {
      valid = false;
    }
  }

  if (bodyWithinLimits && (typeof value.body === "string" || Array.isArray(value.body))) {
    const body = typeof value.body === "string" ? value.body : value.body.join("\n");
    const syntax = analyzeSnippetSyntax(body);
    const { pad_tid } = syntax;
    const defaultPadUsed = pad_tid.some((token) => token.configurationName === undefined);
    const usedConfigurationName = new Set(
      pad_tid.flatMap((token) => token.configurationName === undefined ? [] : [token.configurationName]),
    );
    if (pad_tid.length > MAX_PADS_PER_SNIPPET) {
      issueCollector.add(issue(
        "error",
        name,
        "body",
        `A snippet may contain at most ${MAX_PADS_PER_SNIPPET} active pad tokens.`,
      ));
      valid = false;
    }
    if ((value.pad !== undefined || value.pads !== undefined) && syntax.numericPad_tid.length > 0) {
      issueCollector.add(issue(
        "error",
        name,
        "body",
        "Numeric ${pad:...} forms are reserved; named pad tokens must use a name matching [A-Za-z_][A-Za-z0-9_-]{0,63}.",
      ));
      valid = false;
    }
    if (defaultPadUsed && value.pad === undefined) {
      issueCollector.add(issue("error", name, "body", "${pad} requires a valid pad configuration."));
      valid = false;
    } else if (!defaultPadUsed && pad !== undefined) {
      issueCollector.add(issue("warning", name, "pad", "pad configuration is unused because body has no unescaped ${pad} token."));
    }

    for (const configurationName of usedConfigurationName) {
      if (isRecord(value.pads) && Object.hasOwn(value.pads, configurationName)) {
        continue;
      }
      const message = value.pads === undefined
        ? `${namedPadToken(configurationName)} requires a valid pads.${configurationName} configuration.`
        : `Unknown named pad reference ${namedPadToken(configurationName)}; pads.${configurationName} is not configured.`;
      issueCollector.add(issue("error", name, "body", message));
      valid = false;
    }
    if (pads !== undefined) {
      for (const configurationName of Object.keys(pads)) {
        if (!usedConfigurationName.has(configurationName)) {
          issueCollector.add(issue(
            "warning",
            name,
            namedPadProperty(configurationName),
            `pads.${configurationName} is unused because body has no unescaped ${namedPadToken(configurationName)} token.`,
          ));
        }
      }
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
    ...(pads === undefined ? {} : { pads }),
  };
  return { name, definition };
}

/** Parses already-decoded JSON and returns structurally valid named definitions. */
export function parseSnippetDefinitions(
  value: unknown,
  issueCollector = new SemanticIssueCollector(),
): ParsedSnippets {
  const snippet_sid: NamedSnippetDefinition[] = [];

  if (!isRecord(value)) {
    issueCollector.add({
      severity: "error",
      path: "$",
      message: "The snippet file must contain a top-level object of named snippets.",
    });
    return { snippet_sid, issue_iid: issueCollector.toArray() };
  }

  for (const [name, definitionValue] of Object.entries(value)) {
    if (name.length > MAX_SNIPPET_NAME_LENGTH) {
      issueCollector.add(issue(
        "error",
        name,
        undefined,
        `Snippet names may contain at most ${MAX_SNIPPET_NAME_LENGTH} UTF-16 code units.`,
      ));
      continue;
    }
    const snippet = validateDefinition(name, definitionValue, issueCollector);
    if (snippet !== undefined) {
      snippet_sid.push(snippet);
    }
  }
  return { snippet_sid, issue_iid: issueCollector.toArray() };
}
