import {
  MAX_SCOPE_IDS_PER_SNIPPET,
  MAX_SCOPE_TEXT_LENGTH_PER_SNIPPET,
  type CompiledSnippet,
} from "../core/index.js";

/** Converts a native snippet prefix into a stable, duplicate-free array. */
export function normalizePrefixes(prefix: string | readonly string[]): readonly string[] {
  return [...new Set((typeof prefix === "string" ? [prefix] : prefix).filter((value) => value.length > 0))];
}

/**
 * Normalizes both VS Code's comma-separated scope syntax and scope arrays.
 * Omitted scope means "all languages". Supplied malformed or oversized values
 * throw rather than being mistaken for global scope.
 */
export function normalizeScopes(scope?: string | readonly string[]): readonly string[] {
  if (scope === undefined) {
    return [];
  }

  const value_sid: readonly unknown[] = typeof scope === "string"
    ? [scope]
    : Array.isArray(scope)
      ? scope
      : [];
  if (value_sid.length === 0 || value_sid.length > MAX_SCOPE_IDS_PER_SNIPPET) {
    throw new RangeError("Scope must be a bounded, non-empty string or string array.");
  }

  let textLength = 0;
  for (const value of value_sid as readonly string[]) {
    if (typeof value !== "string") {
      throw new TypeError("Scope arrays may contain only strings.");
    }
    textLength += value.length;
    if (textLength > MAX_SCOPE_TEXT_LENGTH_PER_SNIPPET) {
      throw new RangeError("Scope text exceeds the per-snippet limit.");
    }
  }

  const scope_lid: string[] = [];
  const seen = new Set<string>();
  let scopeIdCount = 0;
  for (const value of value_sid as readonly string[]) {
    let segmentStart = 0;
    let valueHasScopeId = false;
    for (let index = 0; index <= value.length; index += 1) {
      if (value[index] !== undefined && value[index] !== ",") {
        continue;
      }
      const languageId = value.slice(segmentStart, index).trim();
      if (languageId.length > 0) {
        valueHasScopeId = true;
        scopeIdCount += 1;
        if (scopeIdCount > MAX_SCOPE_IDS_PER_SNIPPET) {
          throw new RangeError("Scope ID count exceeds the per-snippet limit.");
        }
        if (!seen.has(languageId)) {
          seen.add(languageId);
          scope_lid.push(languageId);
        }
      }
      segmentStart = index + 1;
    }
    if (!valueHasScopeId) {
      throw new TypeError("Every scope string must contain a non-empty language ID.");
    }
  }
  return scope_lid;
}

export function isLanguageInScope(languageId: string, scope_lid: readonly string[]): boolean {
  return scope_lid.length === 0 || scope_lid.includes(languageId.trim());
}

export interface NormalizedCompiledSnippet {
  readonly compiled: CompiledSnippet;
  readonly prefix_pid: readonly string[];
  readonly scope_lid: readonly string[];
}

export function normalizeCompiledSnippet(compiled: CompiledSnippet): NormalizedCompiledSnippet {
  return {
    compiled,
    prefix_pid: normalizePrefixes(compiled.prefix),
    scope_lid: normalizeScopes(compiled.scope),
  };
}
