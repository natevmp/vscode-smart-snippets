export interface ExactPrefixSnippet {
  readonly name: string;
  readonly prefix_pid: readonly string[];
  readonly source: {
    readonly kind: "user" | "workspace";
    readonly priority: number;
  };
}

export interface ExactPrefixMatch<TSnippet extends ExactPrefixSnippet = ExactPrefixSnippet> {
  readonly snippet: TSnippet;
  readonly prefix: string;
  readonly startCharacter: number;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Returns whether a complete prefix ends at the cursor on a safe token boundary. */
export function isExactPrefixAtBoundary(lineBeforeCursor: string, prefix: string): boolean {
  if (prefix.length === 0 || !lineBeforeCursor.endsWith(prefix)) {
    return false;
  }
  const startCharacter = lineBeforeCursor.length - prefix.length;
  return startCharacter === 0 || /\s/u.test(lineBeforeCursor[startCharacter - 1] ?? "");
}

/** Resolves an exact prefix using registry source priority, snippet name, then prefix order. */
export function findExactPrefixMatch<TSnippet extends ExactPrefixSnippet>(
  lineBeforeCursor: string,
  snippet_sid: readonly TSnippet[],
): ExactPrefixMatch<TSnippet> | undefined {
  const match_mid: ExactPrefixMatch<TSnippet>[] = [];
  for (const snippet of snippet_sid) {
    for (const prefix of new Set(snippet.prefix_pid)) {
      if (isExactPrefixAtBoundary(lineBeforeCursor, prefix)) {
        match_mid.push({
          snippet,
          prefix,
          startCharacter: lineBeforeCursor.length - prefix.length,
        });
      }
    }
  }
  match_mid.sort((left, right) => left.snippet.source.priority - right.snippet.source.priority
    || compareText(left.snippet.name, right.snippet.name)
    || compareText(left.prefix, right.prefix));
  return match_mid[0];
}

/** Resolves only when every cursor has the same effective snippet and exact prefix. */
export function findAgreedExactPrefixMatch<TSnippet extends ExactPrefixSnippet>(
  lineBeforeCursor_sid: readonly string[],
  snippet_sid: readonly TSnippet[],
): ExactPrefixMatch<TSnippet> | undefined {
  const firstLine = lineBeforeCursor_sid[0];
  if (firstLine === undefined) {
    return undefined;
  }
  const first = findExactPrefixMatch(firstLine, snippet_sid);
  if (first === undefined) {
    return undefined;
  }
  for (const lineBeforeCursor of lineBeforeCursor_sid.slice(1)) {
    const match = findExactPrefixMatch(lineBeforeCursor, snippet_sid);
    if (match === undefined || match.snippet !== first.snippet || match.prefix !== first.prefix) {
      return undefined;
    }
  }
  return first;
}
