export const MAX_JSON_NESTING_DEPTH = 100;
export const DEFAULT_MAX_PREFIXES_PER_SOURCE = 5_000;

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
