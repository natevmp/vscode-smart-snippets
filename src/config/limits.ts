import {
  MAX_SCOPE_IDS_PER_SNIPPET,
  MAX_SCOPE_TEXT_LENGTH_PER_SNIPPET,
  type CompiledSnippet,
} from "../core/index.js";

export const MAX_JSON_NESTING_DEPTH = 100;
export const DEFAULT_MAX_PREFIXES_PER_SOURCE = 5_000;
export const MAX_SCOPE_IDS_PER_SOURCE = 100_000;
export const MAX_SCOPE_TEXT_LENGTH_PER_SOURCE = 262_144;

export interface SourceScopeMetrics {
  readonly status: "ok" | "scopeIdLimitExceeded" | "scopeTextLimitExceeded" | "invalid";
  /** Exact when status is ok; otherwise bounded at or before the relevant limit plus one. */
  readonly scopeIdCount: number;
  /** Exact when status is ok; scope text exhaustion is represented by limit plus one. */
  readonly scopeTextLength: number;
}

function countNonEmptyScopeIds(value: string, maximumCount: number): number {
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

/**
 * Measures raw source scopes with early termination. Counts are conservative:
 * duplicate non-empty comma-delimited IDs count separately.
 */
export function measureSourceScopeMetrics(
  snippet_sid: readonly Pick<CompiledSnippet, "scope">[],
  maximumScopeIds = MAX_SCOPE_IDS_PER_SOURCE,
  maximumScopeTextLength = MAX_SCOPE_TEXT_LENGTH_PER_SOURCE,
): SourceScopeMetrics {
  const scopeIdLimit = Number.isFinite(maximumScopeIds)
    ? Math.max(0, Math.floor(maximumScopeIds))
    : MAX_SCOPE_IDS_PER_SOURCE;
  const scopeTextLimit = Number.isFinite(maximumScopeTextLength)
    ? Math.max(0, Math.floor(maximumScopeTextLength))
    : MAX_SCOPE_TEXT_LENGTH_PER_SOURCE;
  let scopeIdCount = 0;
  let scopeTextLength = 0;

  for (const snippet of snippet_sid) {
    const scope = snippet.scope;
    if (scope === undefined) {
      continue;
    }
    const value_sid: readonly unknown[] = typeof scope === "string"
      ? [scope]
      : Array.isArray(scope)
        ? scope
        : [];
    if (value_sid.length === 0 || value_sid.length > MAX_SCOPE_IDS_PER_SNIPPET) {
      return { status: "invalid", scopeIdCount, scopeTextLength };
    }

    let snippetScopeTextLength = 0;
    for (const value of value_sid) {
      if (typeof value !== "string") {
        return { status: "invalid", scopeIdCount, scopeTextLength };
      }
      snippetScopeTextLength += value.length;
      if (snippetScopeTextLength > MAX_SCOPE_TEXT_LENGTH_PER_SNIPPET) {
        return { status: "invalid", scopeIdCount, scopeTextLength };
      }
      if (scopeTextLength > scopeTextLimit
        || value.length > scopeTextLimit - scopeTextLength) {
        return {
          status: "scopeTextLimitExceeded",
          scopeIdCount,
          scopeTextLength: scopeTextLimit + 1,
        };
      }
      scopeTextLength += value.length;
    }

    let snippetScopeIdCount = 0;
    for (const value of value_sid as readonly string[]) {
      const valueCount = countNonEmptyScopeIds(
        value,
        Math.min(
          scopeIdLimit - scopeIdCount,
          MAX_SCOPE_IDS_PER_SNIPPET - snippetScopeIdCount,
        ),
      );
      if (valueCount === 0) {
        return { status: "invalid", scopeIdCount, scopeTextLength };
      }
      snippetScopeIdCount += valueCount;
      if (snippetScopeIdCount > MAX_SCOPE_IDS_PER_SNIPPET) {
        return { status: "invalid", scopeIdCount, scopeTextLength };
      }
      scopeIdCount += valueCount;
      if (scopeIdCount > scopeIdLimit) {
        return { status: "scopeIdLimitExceeded", scopeIdCount, scopeTextLength };
      }
    }
  }

  return { status: "ok", scopeIdCount, scopeTextLength };
}

/** Scans JSONC structure without recursing, ignoring braces inside strings and comments. */
export function exceedsJsonNestingDepth(
  text: string,
  maxDepth = MAX_JSON_NESTING_DEPTH,
): boolean {
  const depthLimit = Math.max(0, Math.floor(maxDepth));
  let depth = 0;
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    const nextCharacter = text[index + 1];
    if (inString) {
      if (character === "\\") {
        index += 1;
      } else if (character === "\"") {
        inString = false;
      }
      continue;
    }
    if (inLineComment) {
      if (character === "\n" || character === "\r") {
        inLineComment = false;
      }
      continue;
    }
    if (inBlockComment) {
      if (character === "*" && nextCharacter === "/") {
        inBlockComment = false;
        index += 1;
      }
      continue;
    }
    if (character === "\"") {
      inString = true;
    } else if (character === "/" && nextCharacter === "/") {
      inLineComment = true;
      index += 1;
    } else if (character === "/" && nextCharacter === "*") {
      inBlockComment = true;
      index += 1;
    } else if (character === "{" || character === "[") {
      depth += 1;
      if (depth > depthLimit) {
        return true;
      }
    } else if ((character === "}" || character === "]") && depth > 0) {
      depth -= 1;
    }
  }
  return false;
}

/** Counts configured scalar/array prefixes, stopping once the supplied limit is exceeded. */
export function countConfiguredPrefixes(value: Record<string, unknown>, limit: number): number {
  let count = 0;
  for (const definition of Object.values(value)) {
    if (typeof definition !== "object" || definition === null || Array.isArray(definition)) {
      continue;
    }
    const prefix = (definition as Record<string, unknown>).prefix;
    count += typeof prefix === "string" ? 1 : Array.isArray(prefix) ? prefix.length : 0;
    if (count > limit) {
      break;
    }
  }
  return count;
}
