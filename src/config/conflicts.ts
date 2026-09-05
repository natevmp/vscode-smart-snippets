export const MAX_DUPLICATE_PREFIX_WARNINGS = 100;

export interface PrefixScopeSnippet {
  readonly name: string;
  /** Prefixes and scopes are expected to be normalized and duplicate-free. */
  readonly prefix_pid: readonly string[];
  readonly scope_lid: readonly string[];
}

export interface DuplicatePrefixConflict {
  readonly snippetIndex: number;
  readonly prefix: string;
  readonly conflictingSnippetName: string;
}

export interface DuplicatePrefixConflictResult {
  readonly conflict_cid: readonly DuplicatePrefixConflict[];
  readonly omittedCount: number;
}

interface IndexedSnippet {
  readonly name: string;
}

interface PrefixScopeIndex {
  readonly first: IndexedSnippet;
  global?: IndexedSnippet;
  readonly snippetByLanguage: Map<string, IndexedSnippet>;
}

function findConflict(
  index: PrefixScopeIndex,
  scope_lid: readonly string[],
): IndexedSnippet | undefined {
  if (scope_lid.length === 0) {
    return index.first;
  }
  if (index.global !== undefined) {
    return index.global;
  }
  for (const languageId of scope_lid) {
    const snippet = index.snippetByLanguage.get(languageId);
    if (snippet !== undefined) {
      return snippet;
    }
  }
  return undefined;
}

function addToIndex(
  index: PrefixScopeIndex,
  snippet: IndexedSnippet,
  scope_lid: readonly string[],
): void {
  if (scope_lid.length === 0) {
    index.global ??= snippet;
    return;
  }
  for (const languageId of scope_lid) {
    if (!index.snippetByLanguage.has(languageId)) {
      index.snippetByLanguage.set(languageId, snippet);
    }
  }
}

/**
 * Indexes prefixes by global and language-specific scope. Each later
 * snippet/prefix receives at most one conflict, regardless of how many prior
 * snippets or language IDs overlap it.
 */
export function indexDuplicatePrefixConflicts(
  snippet_sid: readonly PrefixScopeSnippet[],
  maxWarnings = MAX_DUPLICATE_PREFIX_WARNINGS,
): DuplicatePrefixConflictResult {
  const warningLimit = Number.isFinite(maxWarnings)
    ? Math.max(0, Math.floor(maxWarnings))
    : MAX_DUPLICATE_PREFIX_WARNINGS;
  const indexByPrefix = new Map<string, PrefixScopeIndex>();
  const conflict_cid: DuplicatePrefixConflict[] = [];
  let omittedCount = 0;

  for (let snippetIndex = 0; snippetIndex < snippet_sid.length; snippetIndex += 1) {
    const snippet = snippet_sid[snippetIndex];
    if (snippet === undefined) {
      continue;
    }
    const indexedSnippet: IndexedSnippet = { name: snippet.name };

    for (const prefix of snippet.prefix_pid) {
      const index = indexByPrefix.get(prefix);
      if (index === undefined) {
        const nextIndex: PrefixScopeIndex = {
          first: indexedSnippet,
          snippetByLanguage: new Map<string, IndexedSnippet>(),
        };
        addToIndex(nextIndex, indexedSnippet, snippet.scope_lid);
        indexByPrefix.set(prefix, nextIndex);
        continue;
      }

      const conflictingSnippet = findConflict(index, snippet.scope_lid);
      if (conflictingSnippet !== undefined) {
        if (conflict_cid.length < warningLimit) {
          conflict_cid.push({
            snippetIndex,
            prefix,
            conflictingSnippetName: conflictingSnippet.name,
          });
        } else {
          omittedCount += 1;
        }
      }
      addToIndex(index, indexedSnippet, snippet.scope_lid);
    }
  }

  return { conflict_cid, omittedCount };
}
