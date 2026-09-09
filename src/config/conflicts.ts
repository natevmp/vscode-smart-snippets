import {
  MAX_PREFIXES_PER_SNIPPET,
  MAX_SCOPE_IDS_PER_SNIPPET,
  MAX_SCOPE_TEXT_LENGTH_PER_SNIPPET,
  MAX_SNIPPET_PREFIX_LENGTH,
} from "../core/index.js";

export const MAX_DUPLICATE_PREFIX_WARNINGS = 100;
export const MAX_DUPLICATE_PREFIX_WORK_UNITS = 262_144;

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

export interface CompleteDuplicatePrefixConflictResult {
  readonly status: "ok";
  readonly conflict_cid: readonly DuplicatePrefixConflict[];
  readonly omittedCount: number;
  readonly workUnits: number;
}

export interface ExhaustedDuplicatePrefixConflictResult {
  readonly status: "exhausted";
  readonly reason: "invalidInput" | "workLimit";
  readonly conflict_cid: readonly [];
  readonly omittedCount: 0;
  readonly workUnits: number;
}

export type DuplicatePrefixConflictResult = CompleteDuplicatePrefixConflictResult
  | ExhaustedDuplicatePrefixConflictResult;

interface IndexedSnippet {
  readonly name: string;
}

interface PrefixScopeIndex {
  readonly first: IndexedSnippet;
  global?: IndexedSnippet;
  readonly snippetByLanguage: Map<string, IndexedSnippet>;
}

function exhausted(
  reason: ExhaustedDuplicatePrefixConflictResult["reason"],
  workUnits: number,
): ExhaustedDuplicatePrefixConflictResult {
  return { status: "exhausted", reason, conflict_cid: [], omittedCount: 0, workUnits };
}

/** Computes the full indexing budget before any prefix or language maps exist. */
function preflightIndexWork(
  snippet_sid: readonly PrefixScopeSnippet[],
  workLimit: number,
): number | ExhaustedDuplicatePrefixConflictResult {
  let workUnits = 0;
  for (const snippet of snippet_sid) {
    if (snippet === undefined
      || typeof snippet.name !== "string"
      || !Array.isArray(snippet.prefix_pid)
      || !Array.isArray(snippet.scope_lid)
      || snippet.prefix_pid.length === 0
      || snippet.prefix_pid.length > MAX_PREFIXES_PER_SNIPPET
      || snippet.scope_lid.length > MAX_SCOPE_IDS_PER_SNIPPET) {
      return exhausted("invalidInput", workUnits);
    }

    let scopeTextLength = 0;
    for (const prefix of snippet.prefix_pid) {
      if (typeof prefix !== "string"
        || prefix.length === 0
        || prefix.length > MAX_SNIPPET_PREFIX_LENGTH) {
        return exhausted("invalidInput", workUnits);
      }
    }
    for (const languageId of snippet.scope_lid) {
      if (typeof languageId !== "string" || languageId.length === 0) {
        return exhausted("invalidInput", workUnits);
      }
      scopeTextLength += languageId.length;
      if (scopeTextLength > MAX_SCOPE_TEXT_LENGTH_PER_SNIPPET) {
        return exhausted("invalidInput", workUnits);
      }
    }

    const scopeFactor = Math.max(1, snippet.scope_lid.length);
    const remainingWork = workLimit - workUnits;
    if (remainingWork < 0
      || snippet.prefix_pid.length > Math.floor(remainingWork / 2 / scopeFactor)) {
      return exhausted("workLimit", workLimit + 1);
    }
    workUnits += 2 * snippet.prefix_pid.length * scopeFactor;
  }
  return workUnits;
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
  maxWorkUnits = MAX_DUPLICATE_PREFIX_WORK_UNITS,
): DuplicatePrefixConflictResult {
  const warningLimit = Number.isFinite(maxWarnings)
    ? Math.max(0, Math.floor(maxWarnings))
    : MAX_DUPLICATE_PREFIX_WARNINGS;
  const workLimit = Number.isFinite(maxWorkUnits)
    ? Math.max(0, Math.floor(maxWorkUnits))
    : MAX_DUPLICATE_PREFIX_WORK_UNITS;
  const preflight = preflightIndexWork(snippet_sid, workLimit);
  if (typeof preflight !== "number") {
    return preflight;
  }

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

  return { status: "ok", conflict_cid, omittedCount, workUnits: preflight };
}
