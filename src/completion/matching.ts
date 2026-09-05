export interface PrefixMatch {
  readonly prefix: string;
  readonly typed: string;
  readonly startCharacter: number;
}

/** Returns token boundaries only within the longest possible configured prefix. */
export function getPrefixBoundaryStarts(
  lineBeforeCursor: string,
  maxPrefixLength = lineBeforeCursor.length,
): readonly number[] {
  const boundedLength = Number.isFinite(maxPrefixLength)
    ? Math.max(0, Math.floor(maxPrefixLength))
    : lineBeforeCursor.length;
  const earliestStart = Math.max(0, lineBeforeCursor.length - boundedLength);
  const boundary_bid: number[] = [];
  for (let start = earliestStart; start < lineBeforeCursor.length; start += 1) {
    if (start === 0 || /\s/u.test(lineBeforeCursor[start - 1] ?? "")) {
      boundary_bid.push(start);
    }
  }
  return boundary_bid;
}

/**
 * Matches only the token beginning at the line start or immediately after
 * whitespace, so completion never replaces unrelated same-line text.
 */
export function matchSnippetPrefixes(
  lineBeforeCursor: string,
  prefix_pid: readonly string[],
  allowEmpty: boolean,
  boundary_bid: readonly number[] = getPrefixBoundaryStarts(lineBeforeCursor),
): readonly PrefixMatch[] {
  if (lineBeforeCursor.length === 0) {
    return allowEmpty
      ? [...new Set(prefix_pid)].map((prefix) => ({ prefix, typed: "", startCharacter: 0 }))
      : [];
  }
  if (/\s$/u.test(lineBeforeCursor)) {
    return allowEmpty
      ? [...new Set(prefix_pid)].map((prefix) => ({
        prefix,
        typed: "",
        startCharacter: lineBeforeCursor.length,
      }))
      : [];
  }

  if (!allowEmpty && boundary_bid.length === 0) {
    return [];
  }

  const seen = new Set<string>();
  const match_mid: PrefixMatch[] = [];
  for (const prefix of prefix_pid) {
    if (seen.has(prefix)) {
      continue;
    }
    // The latest matching boundary consumes the least surrounding text.
    for (let index = boundary_bid.length - 1; index >= 0; index -= 1) {
      const startCharacter = boundary_bid[index];
      if (startCharacter === undefined) {
        continue;
      }
      const typed = lineBeforeCursor.slice(startCharacter);
      if (typed.length > 0 && prefix.startsWith(typed)) {
        seen.add(prefix);
        match_mid.push({ prefix, typed, startCharacter });
        break;
      }
    }
  }
  return match_mid;
}
