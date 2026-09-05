interface TokenSpan {
  readonly start: number;
  readonly end: number;
}

export interface NumericTabstop extends TokenSpan {
  readonly number: number;
}

function isDigit(character: string | undefined): boolean {
  return character !== undefined && character >= "0" && character <= "9";
}

function isEscaped(text: string, offset: number): boolean {
  let slashCount = 0;
  for (let index = offset - 1; index >= 0 && text[index] === "\\"; index -= 1) {
    slashCount += 1;
  }
  return slashCount % 2 === 1;
}

function indexBalancedBraceEnds(text: string): ReadonlyMap<number, number> {
  const openingBrace_bid: number[] = [];
  const endByOpeningBrace = new Map<number, number>();
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\\") {
      index += 1;
      continue;
    }
    if (text[index] === "{") {
      openingBrace_bid.push(index);
    } else if (text[index] === "}") {
      const openingBrace = openingBrace_bid.pop();
      if (openingBrace !== undefined) {
        endByOpeningBrace.set(openingBrace, index + 1);
      }
    }
  }
  return endByOpeningBrace;
}

function findTransformBraceEnd(
  text: string,
  firstSlash: number,
): number | undefined {
  let index = firstSlash + 1;
  let inCharacterClass = false;
  for (; index < text.length; index += 1) {
    const character = text[index];
    if (character === "\\") {
      index += 1;
    } else if (character === "[") {
      inCharacterClass = true;
    } else if (character === "]") {
      inCharacterClass = false;
    } else if (character === "/" && !inCharacterClass) {
      index += 1;
      break;
    }
  }

  let nestedFormatDepth = 0;
  for (; index < text.length; index += 1) {
    const character = text[index];
    if (character === "\\") {
      index += 1;
    } else if (character === "$" && text[index + 1] === "{") {
      nestedFormatDepth += 1;
      index += 1;
    } else if (character === "}" && nestedFormatDepth > 0) {
      nestedFormatDepth -= 1;
    } else if (character === "/" && nestedFormatDepth === 0) {
      index += 1;
      break;
    }
  }

  for (; index < text.length; index += 1) {
    if (text[index] === "\\") {
      index += 1;
    } else if (text[index] === "}") {
      return index + 1;
    }
  }
  return undefined;
}

export function findDynamicPadTokens(text: string): readonly TokenSpan[] {
  const token_tid: TokenSpan[] = [];
  const tokenText = "${pad}";
  for (let offset = 0; offset <= text.length - tokenText.length; offset += 1) {
    if (text.startsWith(tokenText, offset) && !isEscaped(text, offset)) {
      token_tid.push({ start: offset, end: offset + tokenText.length });
      offset += tokenText.length - 1;
    }
  }
  return token_tid;
}

export function findNumericTabstops(text: string): readonly NumericTabstop[] {
  const tabstop_tid: NumericTabstop[] = [];
  const endByOpeningBrace = indexBalancedBraceEnds(text);

  for (let offset = 0; offset < text.length; offset += 1) {
    if (text[offset] !== "$" || isEscaped(text, offset)) {
      continue;
    }

    const tokenStart = offset;
    const braced = text[tokenStart + 1] === "{";
    const digitStart = tokenStart + (braced ? 2 : 1);
    if (!isDigit(text[digitStart])) {
      if (braced) {
        let variableEnd = digitStart;
        while (/^[A-Za-z0-9_]$/u.test(text[variableEnd] ?? "")) {
          variableEnd += 1;
        }
        if (text[variableEnd] === "/") {
          const transformEnd = findTransformBraceEnd(text, variableEnd);
          if (transformEnd !== undefined) {
            offset = transformEnd - 1;
          } else {
            break;
          }
        }
      }
      continue;
    }

    let digitEnd = digitStart;
    while (isDigit(text[digitEnd])) {
      digitEnd += 1;
    }

    let end: number | undefined;
    let skipBracedContent = false;
    if (!braced) {
      end = digitEnd;
    } else if (text[digitEnd] === "}") {
      end = digitEnd + 1;
    } else if (text[digitEnd] === ":") {
      end = endByOpeningBrace.get(tokenStart + 1);
    } else if (text[digitEnd] === "|") {
      end = endByOpeningBrace.get(tokenStart + 1);
      skipBracedContent = end !== undefined;
    } else if (text[digitEnd] === "/") {
      const transformEnd = findTransformBraceEnd(text, digitEnd);
      if (transformEnd !== undefined) {
        offset = transformEnd - 1;
      } else {
        break;
      }
    }

    if (end !== undefined) {
      tabstop_tid.push({
        start: tokenStart,
        end,
        number: Number(text.slice(digitStart, digitEnd)),
      });
      if (skipBracedContent) {
        offset = end - 1;
      }
    }
  }

  return tabstop_tid;
}
