export interface TokenSpan {
  readonly start: number;
  readonly end: number;
}

export interface DynamicPadToken extends TokenSpan {
  readonly configurationName?: string;
}

export interface NumericTabstop extends TokenSpan {
  readonly number: number;
  readonly nestingDepth: number;
}

export interface NativeVariable extends TokenSpan {
  readonly name: string;
  readonly braced: boolean;
  readonly containsLineBreak: boolean;
}

export interface SnippetSyntax {
  readonly pad_tid: readonly DynamicPadToken[];
  readonly numericPad_tid: readonly TokenSpan[];
  readonly tabstop_tid: readonly NumericTabstop[];
  readonly choice_tid: readonly NumericTabstop[];
  readonly variable_vid: readonly NativeVariable[];
  readonly malformed: boolean;
}

interface NumericCandidate {
  readonly start: number;
  end: number;
  readonly number: number;
  readonly nestingDepth: number;
  complete: boolean;
}

interface VariableCandidate {
  readonly start: number;
  end: number;
  readonly name: string;
  readonly braced: true;
  containsLineBreak: boolean;
  complete: boolean;
}

interface DefaultFrame {
  readonly candidate: NumericCandidate | VariableCandidate;
  readonly startLineBreakCount: number;
}

interface ScanResult {
  readonly end: number;
  readonly lineBreakCount: number;
}

interface RecoverableScanResult extends ScanResult {
  readonly malformed: boolean;
}

const PAD_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/u;
const NUMERIC_PAD_PATTERN = /^[0-9]+$/u;
const SYNTAX_WORK_PER_CODE_UNIT = 16;
const BASE_SYNTAX_WORK = 64;

/**
 * Shared by speculative grammar scanners so failed lookaheads cannot repeatedly
 * traverse an unbounded suffix. Grammar scanning performs at most
 * `16 * text.length + 64` charged iterations. Format-value indexes are built in
 * charged linear passes against that same bound, so collection is O(text + tokens).
 */
class SyntaxWorkBudget {
  private remaining: number;

  public constructor(textLength: number) {
    this.remaining = SYNTAX_WORK_PER_CODE_UNIT * textLength + BASE_SYNTAX_WORK;
  }

  public consume(): boolean {
    if (this.remaining <= 0) {
      return false;
    }
    this.remaining -= 1;
    return true;
  }

  public get exhausted(): boolean {
    return this.remaining <= 0;
  }
}

class FormatValueIndex {
  private closeDelimiterByOffset: Int32Array | undefined;
  private colonDelimiterByOffset: Int32Array | undefined;
  private lineBreakCountByOffset: Uint32Array | undefined;

  public constructor(private readonly text: string) {}

  public scan(
    start: number,
    delimiter: ":" | "}",
    workBudget: SyntaxWorkBudget,
  ): ScanResult | undefined {
    const delimiterByOffset = this.getDelimiterIndex(delimiter, workBudget);
    if (delimiterByOffset === undefined) {
      return undefined;
    }
    const delimiterOffset = delimiterByOffset[start];
    if (delimiterOffset === undefined || delimiterOffset < 0 || delimiterOffset === start) {
      return undefined;
    }
    const lineBreakCountByOffset = this.getLineBreakIndex(workBudget);
    if (lineBreakCountByOffset === undefined) {
      return undefined;
    }
    const startLineBreakCount = lineBreakCountByOffset[start];
    const endLineBreakCount = lineBreakCountByOffset[delimiterOffset];
    return startLineBreakCount === undefined || endLineBreakCount === undefined
      ? undefined
      : {
        end: delimiterOffset + 1,
        lineBreakCount: endLineBreakCount - startLineBreakCount,
      };
  }

  private getDelimiterIndex(
    delimiter: ":" | "}",
    workBudget: SyntaxWorkBudget,
  ): Int32Array | undefined {
    const existing = delimiter === "}"
      ? this.closeDelimiterByOffset
      : this.colonDelimiterByOffset;
    if (existing !== undefined) {
      return existing;
    }

    const delimiterByOffset = new Int32Array(this.text.length + 1);
    delimiterByOffset[this.text.length] = -1;
    for (let index = this.text.length - 1; index >= 0; index -= 1) {
      if (!workBudget.consume()) {
        return undefined;
      }
      const character = this.text[index];
      if (character === delimiter) {
        delimiterByOffset[index] = index;
      } else if (character === "\\") {
        const escaped = this.text[index + 1];
        delimiterByOffset[index] = escaped === "$" || escaped === "}" || escaped === "\\"
          ? delimiterByOffset[index + 2] ?? -1
          : -1;
      } else {
        delimiterByOffset[index] = delimiterByOffset[index + 1] ?? -1;
      }
    }
    if (delimiter === "}") {
      this.closeDelimiterByOffset = delimiterByOffset;
    } else {
      this.colonDelimiterByOffset = delimiterByOffset;
    }
    return delimiterByOffset;
  }

  private getLineBreakIndex(workBudget: SyntaxWorkBudget): Uint32Array | undefined {
    if (this.lineBreakCountByOffset !== undefined) {
      return this.lineBreakCountByOffset;
    }
    const lineBreakCountByOffset = new Uint32Array(this.text.length + 1);
    let lineBreakCount = 0;
    for (let index = 0; index < this.text.length; index += 1) {
      if (!workBudget.consume()) {
        return undefined;
      }
      if (this.text[index] === "\r" || this.text[index] === "\n") {
        lineBreakCount += 1;
      }
      lineBreakCountByOffset[index + 1] = lineBreakCount;
    }
    this.lineBreakCountByOffset = lineBreakCountByOffset;
    return lineBreakCountByOffset;
  }
}

/** Detects a carriage return that is not the first half of CRLF. */
export function hasLoneCarriageReturn(text: string): boolean {
  for (let index = text.indexOf("\r"); index >= 0; index = text.indexOf("\r", index + 1)) {
    if (text[index + 1] !== "\n") {
      return true;
    }
  }
  return false;
}

function isDigit(character: string | undefined): boolean {
  return character !== undefined && character >= "0" && character <= "9";
}

function isVariableStart(character: string | undefined): boolean {
  return character !== undefined
    && ((character >= "A" && character <= "Z")
      || (character >= "a" && character <= "z")
      || character === "_");
}

function isVariablePart(character: string | undefined): boolean {
  return isVariableStart(character) || isDigit(character);
}

function isPadValuePart(character: string | undefined): boolean {
  return isVariablePart(character) || character === "-";
}

function isComplexFormatCandidate(text: string, start: number): boolean {
  if (text[start] !== "$" || text[start + 1] !== "{") {
    return false;
  }
  let index = start + 2;
  const numberStart = index;
  while (isDigit(text[index])) {
    index += 1;
  }
  return index > numberStart && text[index] === ":";
}

function scanChoice(
  text: string,
  start: number,
  workBudget: SyntaxWorkBudget,
): RecoverableScanResult | undefined {
  let lineBreakCount = 0;
  let optionLength = 0;
  let malformed = false;
  for (let index = start; index < text.length; index += 1) {
    if (!workBudget.consume()) {
      return undefined;
    }
    const character = text[index];
    if (character === "\\") {
      const escaped = text[index + 1];
      if (escaped === "," || escaped === "|" || escaped === "\\") {
        optionLength += 1;
        index += 1;
      } else {
        optionLength += 1;
      }
    } else if (character === "\r" || character === "\n") {
      lineBreakCount += 1;
      optionLength += 1;
    } else if (character === ",") {
      if (optionLength === 0) {
        malformed = true;
      }
      optionLength = 0;
    } else if (character === "|") {
      if (text[index + 1] === "}") {
        return { end: index + 2, lineBreakCount, malformed: malformed || optionLength === 0 };
      }
      malformed = true;
      optionLength += 1;
    } else {
      optionLength += 1;
    }
  }
  return undefined;
}

/** Scans one VS Code transform format reference and its line breaks. */
function scanFormatString(
  text: string,
  start: number,
  workBudget: SyntaxWorkBudget,
  formatValueIndex: FormatValueIndex,
): ScanResult | undefined {
  if (text[start] !== "$") {
    return undefined;
  }
  let index = start + 1;
  const complex = text[index] === "{";
  if (complex) {
    index += 1;
  }
  const numberStart = index;
  while (isDigit(text[index])) {
    if (!workBudget.consume()) {
      return undefined;
    }
    index += 1;
  }
  if (index === numberStart) {
    return undefined;
  }
  if (!complex) {
    return { end: index, lineBreakCount: 0 };
  }
  if (text[index] === "}") {
    return { end: index + 1, lineBreakCount: 0 };
  }
  if (text[index] !== ":") {
    return undefined;
  }
  index += 1;

  if (text[index] === "/") {
    index += 1;
    if (!isVariableStart(text[index])) {
      return undefined;
    }
    while (isVariablePart(text[index])) {
      if (!workBudget.consume()) {
        return undefined;
      }
      index += 1;
    }
    return text[index] === "}" ? { end: index + 1, lineBreakCount: 0 } : undefined;
  }
  if (text[index] === "+" || text[index] === "-") {
    return formatValueIndex.scan(index + 1, "}", workBudget);
  }
  if (text[index] === "?") {
    const ifResult = formatValueIndex.scan(index + 1, ":", workBudget);
    if (ifResult === undefined) {
      return undefined;
    }
    const elseResult = formatValueIndex.scan(ifResult.end, "}", workBudget);
    return elseResult === undefined
      ? undefined
      : {
        end: elseResult.end,
        lineBreakCount: ifResult.lineBreakCount + elseResult.lineBreakCount,
      };
  }
  return formatValueIndex.scan(index, "}", workBudget);
}

function scanTransform(
  text: string,
  firstSlash: number,
  workBudget: SyntaxWorkBudget,
  formatValueIndex: FormatValueIndex,
): RecoverableScanResult | undefined {
  let lineBreakCount = 0;
  let index = firstSlash + 1;
  const regexCharacter_cid: string[] = [];
  let regexRecoveryEnd: number | undefined;
  let regexRecoveryLineBreakCount = 0;
  let regexClosed = false;
  for (; index < text.length; index += 1) {
    if (!workBudget.consume()) {
      return undefined;
    }
    const character = text[index];
    if (character === undefined) {
      return undefined;
    }
    if (character === "\\") {
      if (text[index + 1] === "/") {
        regexCharacter_cid.push("/");
        index += 1;
      } else {
        regexCharacter_cid.push("\\");
      }
    } else if (character === "\r" || character === "\n") {
      lineBreakCount += 1;
      regexCharacter_cid.push(character);
    } else if (character === "}") {
      if (regexRecoveryEnd === undefined) {
        regexRecoveryEnd = index + 1;
        regexRecoveryLineBreakCount = lineBreakCount;
      }
      regexCharacter_cid.push(character);
    } else if (character === "/") {
      regexClosed = true;
      index += 1;
      break;
    } else {
      regexCharacter_cid.push(character);
    }
  }
  if (!regexClosed) {
    return regexRecoveryEnd === undefined
      ? undefined
      : { end: regexRecoveryEnd, lineBreakCount: regexRecoveryLineBreakCount, malformed: true };
  }

  let formatRecoveryEnd: number | undefined;
  let formatRecoveryLineBreakCount = 0;
  let formatClosed = false;
  let formatMalformed = false;
  for (; index < text.length; index += 1) {
    if (!workBudget.consume()) {
      return undefined;
    }
    const character = text[index];
    if (character === "\\") {
      if (text[index + 1] === "\\" || text[index + 1] === "/") {
        index += 1;
      }
    } else if (character === "\r" || character === "\n") {
      lineBreakCount += 1;
    } else if (character === "$") {
      const formatResult = scanFormatString(text, index, workBudget, formatValueIndex);
      if (formatResult !== undefined) {
        lineBreakCount += formatResult.lineBreakCount;
        index = formatResult.end - 1;
      } else if (workBudget.exhausted) {
        return undefined;
      } else if (isComplexFormatCandidate(text, index)) {
        formatMalformed = true;
      }
    } else if (character === "}") {
      if (formatRecoveryEnd === undefined) {
        formatRecoveryEnd = index + 1;
        formatRecoveryLineBreakCount = lineBreakCount;
      }
    } else if (character === "/") {
      formatClosed = true;
      index += 1;
      break;
    }
  }
  if (!formatClosed) {
    return formatRecoveryEnd === undefined
      ? undefined
      : { end: formatRecoveryEnd, lineBreakCount: formatRecoveryLineBreakCount, malformed: true };
  }

  const regexOption_cid: string[] = [];
  for (; index < text.length; index += 1) {
    if (!workBudget.consume()) {
      return undefined;
    }
    const character = text[index];
    if (character === undefined) {
      return undefined;
    }
    if (character === "\r" || character === "\n") {
      lineBreakCount += 1;
    }
    if (character === "}") {
      try {
        RegExp(regexCharacter_cid.join(""), regexOption_cid.join(""));
      } catch {
        return { end: index + 1, lineBreakCount, malformed: true };
      }
      return { end: index + 1, lineBreakCount, malformed: formatMalformed };
    }
    regexOption_cid.push(character);
  }
  return undefined;
}

/** Analyzes the bounded snippet grammar needed by dynamic pad compilation. */
export function analyzeSnippetSyntax(text: string): SnippetSyntax {
  const pad_tid: DynamicPadToken[] = [];
  const numericPad_tid: TokenSpan[] = [];
  const numericCandidate_tid: NumericCandidate[] = [];
  const choiceCandidate_tid: NumericCandidate[] = [];
  const variableCandidate_vid: VariableCandidate[] = [];
  const unbracedVariable_vid: NativeVariable[] = [];
  const defaultFrame_fid: DefaultFrame[] = [];
  const workBudget = new SyntaxWorkBudget(text.length);
  const formatValueIndex = new FormatValueIndex(text);
  let lineBreakCount = 0;
  let malformed = false;

  for (let offset = 0; offset < text.length;) {
    if (!workBudget.consume()) {
      malformed = true;
      break;
    }
    const character = text[offset];
    if (character === "\\") {
      if (text[offset + 1] === "\r" || text[offset + 1] === "\n") {
        lineBreakCount += 1;
      }
      offset += Math.min(2, text.length - offset);
      continue;
    }
    if (character === "\r" || character === "\n") {
      lineBreakCount += 1;
      offset += 1;
      continue;
    }
    if (character === "}" && defaultFrame_fid.length > 0) {
      const frame = defaultFrame_fid.pop();
      if (frame !== undefined) {
        frame.candidate.end = offset + 1;
        frame.candidate.complete = true;
        if ("name" in frame.candidate) {
          frame.candidate.containsLineBreak = lineBreakCount > frame.startLineBreakCount;
        }
      }
      offset += 1;
      continue;
    }
    if (character !== "$") {
      offset += 1;
      continue;
    }

    const tokenStart = offset;
    if (text[offset + 1] !== "{") {
      let valueEnd = offset + 1;
      if (isDigit(text[valueEnd])) {
        while (isDigit(text[valueEnd])) {
          valueEnd += 1;
        }
        numericCandidate_tid.push({
          start: tokenStart,
          end: valueEnd,
          number: Number(text.slice(offset + 1, valueEnd)),
          nestingDepth: defaultFrame_fid.length,
          complete: true,
        });
        offset = valueEnd;
        continue;
      }
      if (isVariableStart(text[valueEnd])) {
        while (isVariablePart(text[valueEnd])) {
          valueEnd += 1;
        }
        unbracedVariable_vid.push({
          start: tokenStart,
          end: valueEnd,
          name: text.slice(offset + 1, valueEnd),
          braced: false,
          containsLineBreak: false,
        });
        offset = valueEnd;
        continue;
      }
      offset += 1;
      continue;
    }

    const valueStart = offset + 2;
    let valueEnd = valueStart;
    const numeric = isDigit(text[valueStart]);
    if (numeric) {
      while (isDigit(text[valueEnd])) {
        valueEnd += 1;
      }
      const delimiter = text[valueEnd];
      if (delimiter === "}") {
        numericCandidate_tid.push({
          start: tokenStart,
          end: valueEnd + 1,
          number: Number(text.slice(valueStart, valueEnd)),
          nestingDepth: defaultFrame_fid.length,
          complete: true,
        });
        offset = valueEnd + 1;
      } else if (delimiter === ":") {
        const candidate: NumericCandidate = {
          start: tokenStart,
          end: valueEnd + 1,
          number: Number(text.slice(valueStart, valueEnd)),
          nestingDepth: defaultFrame_fid.length,
          complete: false,
        };
        numericCandidate_tid.push(candidate);
        defaultFrame_fid.push({ candidate, startLineBreakCount: lineBreakCount });
        offset = valueEnd + 1;
      } else if (delimiter === "|" && Number(text.slice(valueStart, valueEnd)) > 0) {
        const result = scanChoice(text, valueEnd + 1, workBudget);
        if (result === undefined) {
          malformed = true;
          break;
        }
        lineBreakCount += result.lineBreakCount;
        offset = result.end;
        if (result.malformed) {
          malformed = true;
          continue;
        }
        const candidate: NumericCandidate = {
          start: tokenStart,
          end: result.end,
          number: Number(text.slice(valueStart, valueEnd)),
          nestingDepth: defaultFrame_fid.length,
          complete: true,
        };
        numericCandidate_tid.push(candidate);
        choiceCandidate_tid.push(candidate);
      } else if (delimiter === "/") {
        const result = scanTransform(text, valueEnd, workBudget, formatValueIndex);
        if (result === undefined) {
          malformed = true;
          break;
        }
        lineBreakCount += result.lineBreakCount;
        offset = result.end;
        if (result.malformed) {
          malformed = true;
          continue;
        }
        numericCandidate_tid.push({
          start: tokenStart,
          end: result.end,
          number: Number(text.slice(valueStart, valueEnd)),
          nestingDepth: defaultFrame_fid.length,
          complete: true,
        });
      } else {
        malformed = true;
        offset += 2;
      }
      continue;
    }

    if (!isVariableStart(text[valueStart])) {
      malformed = true;
      offset += 2;
      continue;
    }
    while (isVariablePart(text[valueEnd])) {
      valueEnd += 1;
    }
    const name = text.slice(valueStart, valueEnd);
    const delimiter = text[valueEnd];
    if (name === "pad" && delimiter === "}") {
      pad_tid.push({ start: tokenStart, end: valueEnd + 1 });
      offset = valueEnd + 1;
      continue;
    }
    if (name === "pad" && delimiter === ":") {
      const padValueStart = valueEnd + 1;
      let padValueEnd = padValueStart;
      while (isPadValuePart(text[padValueEnd])) {
        padValueEnd += 1;
      }
      if (text[padValueEnd] === "}") {
        const padValue = text.slice(padValueStart, padValueEnd);
        if (PAD_NAME_PATTERN.test(padValue)) {
          pad_tid.push({
            start: tokenStart,
            end: padValueEnd + 1,
            configurationName: padValue,
          });
          offset = padValueEnd + 1;
          continue;
        }
        if (NUMERIC_PAD_PATTERN.test(padValue)) {
          numericPad_tid.push({ start: tokenStart, end: padValueEnd + 1 });
          offset = padValueEnd + 1;
          continue;
        }
      }
    }

    if (delimiter === "}") {
      variableCandidate_vid.push({
        start: tokenStart,
        end: valueEnd + 1,
        name,
        braced: true,
        containsLineBreak: false,
        complete: true,
      });
      offset = valueEnd + 1;
    } else if (delimiter === ":") {
      const candidate: VariableCandidate = {
        start: tokenStart,
        end: valueEnd + 1,
        name,
        braced: true,
        containsLineBreak: false,
        complete: false,
      };
      variableCandidate_vid.push(candidate);
      defaultFrame_fid.push({ candidate, startLineBreakCount: lineBreakCount });
      offset = valueEnd + 1;
    } else if (delimiter === "/") {
      const result = scanTransform(text, valueEnd, workBudget, formatValueIndex);
      if (result === undefined) {
        malformed = true;
        break;
      }
      lineBreakCount += result.lineBreakCount;
      offset = result.end;
      if (result.malformed) {
        malformed = true;
        continue;
      }
      variableCandidate_vid.push({
        start: tokenStart,
        end: result.end,
        name,
        braced: true,
        containsLineBreak: result.lineBreakCount > 0,
        complete: true,
      });
    } else {
      malformed = true;
      offset += 2;
    }
  }

  if (defaultFrame_fid.length > 0) {
    malformed = true;
  }
  const tabstop_tid: NumericTabstop[] = numericCandidate_tid
    .filter((candidate) => candidate.complete)
    .map(({ start, end, number, nestingDepth }) => ({ start, end, number, nestingDepth }));
  const choice_tid: NumericTabstop[] = choiceCandidate_tid
    .map(({ start, end, number, nestingDepth }) => ({ start, end, number, nestingDepth }));
  const variable_vid: NativeVariable[] = [
    ...variableCandidate_vid
      .filter((candidate) => candidate.complete)
      .map(({ start, end, name, braced, containsLineBreak }) => ({
        start,
        end,
        name,
        braced,
        containsLineBreak,
      })),
    ...unbracedVariable_vid,
  ].sort((left, right) => left.start - right.start);

  return { pad_tid, numericPad_tid, tabstop_tid, choice_tid, variable_vid, malformed };
}

export function findDynamicPadTokens(text: string): readonly DynamicPadToken[] {
  return analyzeSnippetSyntax(text).pad_tid;
}

/** Finds reserved numeric pad forms so they can be diagnosed without activating them. */
export function findNumericNamedPadTokens(text: string): readonly TokenSpan[] {
  return analyzeSnippetSyntax(text).numericPad_tid;
}

export function findNumericTabstops(text: string): readonly NumericTabstop[] {
  return analyzeSnippetSyntax(text).tabstop_tid;
}

/**
 * Reports whether any complete numeric span contains a source line break.
 * Building one UTF-16 offset index and querying every span is O(text + tokens),
 * including arbitrarily overlapping positive and zero placeholder defaults.
 */
export function numericTabstopsContainLineBreak(
  text: string,
  tabstop_tid: readonly NumericTabstop[],
): boolean {
  const lineBreakCountByOffset = new Uint32Array(text.length + 1);
  let lineBreakCount = 0;
  for (let offset = 0; offset < text.length; offset += 1) {
    if (text[offset] === "\r" || text[offset] === "\n") {
      lineBreakCount += 1;
    }
    lineBreakCountByOffset[offset + 1] = lineBreakCount;
  }
  for (const tabstop of tabstop_tid) {
    if (!Number.isSafeInteger(tabstop.start)
      || !Number.isSafeInteger(tabstop.end)
      || tabstop.start < 0
      || tabstop.end < tabstop.start
      || tabstop.end > text.length) {
      return true;
    }
    const startLineBreakCount = lineBreakCountByOffset[tabstop.start];
    const endLineBreakCount = lineBreakCountByOffset[tabstop.end];
    if (startLineBreakCount === undefined
      || endLineBreakCount === undefined
      || endLineBreakCount > startLineBreakCount) {
      return true;
    }
  }
  return false;
}

/** Detects coincident groups whose backward transition cannot be identified. */
export function hasAdjacentDistinctNumericTabstopGroups(
  tabstop_tid: readonly NumericTabstop[],
): boolean {
  let previous: NumericTabstop | undefined;
  for (const tabstop of tabstop_tid) {
    if (tabstop.number <= 0 || tabstop.nestingDepth !== 0) {
      continue;
    }
    if (previous !== undefined
      && previous.end === tabstop.start
      && previous.number !== tabstop.number) {
      return true;
    }
    previous = tabstop;
  }
  return false;
}
