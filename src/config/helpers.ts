import type { CompiledSnippet } from "../core/index.js";

/** Converts a native snippet prefix into a stable, duplicate-free array. */
export function normalizePrefixes(prefix: string | readonly string[]): readonly string[] {
  return [...new Set((typeof prefix === "string" ? [prefix] : prefix).filter((value) => value.length > 0))];
}

/**
 * Normalizes both VS Code's comma-separated scope syntax and scope arrays.
 * Empty scope values are ignored; an empty result therefore means "all languages".
 */
export function normalizeScopes(scope?: string | readonly string[]): readonly string[] {
  if (scope === undefined) {
    return [];
  }

  const value_sid = typeof scope === "string" ? [scope] : scope;
  const scope_lid: string[] = [];
  const seen = new Set<string>();
  for (const value of value_sid) {
    for (const part of value.split(",")) {
      const languageId = part.trim();
      if (languageId.length > 0 && !seen.has(languageId)) {
        seen.add(languageId);
        scope_lid.push(languageId);
      }
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
