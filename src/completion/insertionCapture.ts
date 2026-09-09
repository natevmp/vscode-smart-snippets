import {
  MAX_PAD_TARGET_WIDTH,
  type CompiledPadMetadata,
  type CompiledSnippet,
} from "../core/types.js";
import { MAX_OFFSET_TRACKING_WORK } from "../core/offsetTracking.js";
import {
  analyzeSnippetSyntax,
  hasAdjacentDistinctNumericTabstopGroups,
  hasLoneCarriageReturn,
  numericTabstopsContainLineBreak,
  type NumericTabstop,
} from "../core/syntax.js";

export const MAX_TRACKED_PADS_PER_SESSION = 4_096;
export const MAX_TRACKED_TABSTOPS_PER_SESSION = 4_096;
export const MAX_TRACKED_SELECTION_RANGES_PER_SESSION = 4_096;
export const MAX_PLANNED_RENDERED_CODE_UNITS = 1_048_576;
export const MAX_RETAINED_OBSERVED_CHANGE_TEXT_CODE_UNITS = 1_048_576;
export const MAX_AGGREGATE_REPLACEMENT_GAP_CODE_UNITS = 1_048_576;
export const MAX_INSERTION_INDENT_CODE_UNITS = 1_048_576;
export const MAX_RENDERING_INDENT_SIZE = 1_048_576;

const PAD_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/u;

export interface InsertionReplacementRange {
  readonly rangeOffset: number;
  readonly rangeLength: number;
}

export interface InsertionReplacementContext extends InsertionReplacementRange {
  readonly targetEolWidth: number;
  readonly indentSize: number;
  readonly insertSpaces: boolean;
  readonly insertionIndent: string;
}

export interface InsertionContentChange extends InsertionReplacementRange {
  readonly text: string;
}

export interface InsertionDocumentEvent {
  readonly targetDocumentVersion: number;
  readonly change_cid: readonly InsertionContentChange[];
}

export interface InsertionCapturePlanRequest {
  readonly snippetName: string;
  readonly sourceUri: string;
  readonly targetDocumentUri: string;
  readonly targetDocumentVersion: number;
  readonly targetDocumentLength: number;
  readonly compiled: Pick<CompiledSnippet, "body" | "pad_pid">;
  readonly replacement_rid: readonly InsertionReplacementContext[];
}

export interface PlannedPad extends Omit<CompiledPadMetadata, "kind" | "offset"> {
  readonly sourceLineIndex: number;
}

export interface InsertionCapturePlan {
  readonly snippetName: string;
  readonly sourceUri: string;
  readonly targetDocumentUri: string;
  readonly targetDocumentVersion: number;
  readonly targetDocumentLength: number;
  readonly sourceLineBreakCount: number;
  readonly nativeFinalAtRenderedInsertionEnd: boolean;
  readonly tabstop_tid: readonly number[];
  readonly pad_pid: readonly PlannedPad[];
  readonly replacement_rid: readonly InsertionReplacementContext[];
}

export interface InsertionCaptureObservation {
  readonly insertionSucceeded: boolean;
  readonly targetDocumentUri: string;
  readonly targetDocumentVersion: number;
  readonly event: InsertionDocumentEvent | undefined;
  readonly eventAmbiguousOrOverflow: boolean;
}

export interface GeneratedOffsetRange {
  readonly start: number;
  readonly end: number;
}

export interface CapturedPad extends Omit<PlannedPad, "sourceLineIndex"> {
  readonly generated: GeneratedOffsetRange;
}

export interface PadInsertionSnapshot {
  readonly snippetName: string;
  readonly sourceUri: string;
  readonly targetDocumentUri: string;
  readonly targetDocumentVersion: number;
  readonly instanceCount: number;
  readonly tabstop_tid: readonly number[];
  readonly pad_pid: readonly CapturedPad[];
  readonly terminal_rid: readonly GeneratedOffsetRange[];
}

export type InsertionCaptureResult<T> =
  | { readonly success: true; readonly value: T }
  | { readonly success: false; readonly reason: string };

function failed<T>(reason: string): InsertionCaptureResult<T> {
  return { success: false, reason };
}

function isSafeNonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function safeIntegerSum(left: number, right: number): number | undefined {
  if (!Number.isSafeInteger(left) || !Number.isSafeInteger(right)
    || (right > 0 && left > Number.MAX_SAFE_INTEGER - right)
    || (right < 0 && left < Number.MIN_SAFE_INTEGER - right)) {
    return undefined;
  }
  return left + right;
}

function isProductWithinLimit(left: number, right: number, limit: number): boolean {
  return isSafeNonnegativeInteger(left)
    && isSafeNonnegativeInteger(right)
    && (left === 0 || right <= Math.floor(limit / left));
}

function boundedSum(left: number, right: number, limit: number): number | undefined {
  return isSafeNonnegativeInteger(left)
    && isSafeNonnegativeInteger(right)
    && left <= limit
    && right <= limit - left
    ? left + right
    : undefined;
}

function boundedProduct(left: number, right: number, limit: number): number | undefined {
  return isProductWithinLimit(left, right, limit) ? left * right : undefined;
}

function isNumericTransform(body: string, tabstop: NumericTabstop): boolean {
  if (body[tabstop.start] !== "$" || body[tabstop.start + 1] !== "{") {
    return false;
  }
  let offset = tabstop.start + 2;
  for (let character = body[offset]; character !== undefined
    && character >= "0" && character <= "9"; character = body[offset]) {
    offset += 1;
  }
  return body[offset] === "/";
}

function countDollars(body: string, start: number, end: number): number {
  let count = 0;
  for (let offset = start; offset < end; offset += 1) {
    if (body[offset] === "$") {
      count += 1;
    }
  }
  return count;
}

interface RenderingSpanMetrics {
  readonly sourceLength: number;
  readonly tabCount: number;
  readonly lineBreakCount: number;
}

interface TabstopRenderingMetrics {
  readonly transformSpan: RenderingSpanMetrics | undefined;
  readonly formatReferenceCount: number;
}

function measureRenderingSpan(body: string, start: number, end: number): RenderingSpanMetrics {
  let tabCount = 0;
  let lineBreakCount = 0;
  for (let offset = start; offset < end; offset += 1) {
    if (body[offset] === "\t") {
      tabCount += 1;
    } else if (body[offset] === "\n") {
      lineBreakCount += 1;
    }
  }
  return { sourceLength: end - start, tabCount, lineBreakCount };
}

function expandedSpanBound(
  metrics: RenderingSpanMetrics,
  context: InsertionReplacementContext,
  limit: number,
): number | undefined {
  // Conservatively widen every tab even though native normalization only
  // changes leading whitespace, and regardless of insertSpaces.
  const tabExpansion = boundedProduct(metrics.tabCount, context.indentSize - 1, limit);
  const eolExpansion = boundedProduct(
    metrics.lineBreakCount,
    context.targetEolWidth - 1,
    limit,
  );
  const withTabs = tabExpansion === undefined
    ? undefined
    : boundedSum(metrics.sourceLength, tabExpansion, limit);
  return withTabs === undefined || eolExpansion === undefined
    ? undefined
    : boundedSum(withTabs, eolExpansion, limit);
}

/**
 * Bounds initial native rendering without expanding placeholders. Every source
 * span is first widened for target tab/EOL normalization. The source body covers
 * literals once; every ordinary numeric occurrence may inherit one whole body,
 * while every transform may copy one body through each `$` for at most one match
 * per normalized input boundary, plus unmatched input and its own source span.
 * Each rendered source line may additionally receive one insertion-indent prefix.
 */
function isPlannedRenderingWithinLimit(
  body: string,
  tabstop_tid: readonly NumericTabstop[],
  replacement_rid: readonly InsertionReplacementContext[],
): boolean {
  if (replacement_rid.length === 0) {
    return false;
  }
  const bodyMetrics = measureRenderingSpan(body, 0, body.length);
  const tabstopMetrics_tid = tabstop_tid.map((tabstop): TabstopRenderingMetrics => {
    if (!isNumericTransform(body, tabstop)) {
      return { transformSpan: undefined, formatReferenceCount: 0 };
    }
    return {
      transformSpan: measureRenderingSpan(body, tabstop.start, tabstop.end),
      formatReferenceCount: countDollars(body, tabstop.start, tabstop.end),
    };
  });
  let aggregateBound = 0;

  for (const context of replacement_rid) {
    const instanceLimit = MAX_PLANNED_RENDERED_CODE_UNITS - aggregateBound;
    const bodyBound = expandedSpanBound(bodyMetrics, context, instanceLimit);
    if (bodyBound === undefined) {
      return false;
    }
    let renderedBound = bodyBound;

    for (let index = 0; index < tabstop_tid.length; index += 1) {
      const metrics = tabstopMetrics_tid[index];
      if (metrics === undefined) {
        return false;
      }
      if (metrics.transformSpan === undefined) {
        const nextBound = boundedSum(renderedBound, bodyBound, instanceLimit);
        if (nextBound === undefined) {
          return false;
        }
        renderedBound = nextBound;
        continue;
      }

      const transformSpanBound = expandedSpanBound(
        metrics.transformSpan,
        context,
        instanceLimit,
      );
      const formatReferenceCopies = boundedProduct(
        metrics.formatReferenceCount,
        bodyBound,
        instanceLimit,
      );
      const replacementPerMatch = transformSpanBound === undefined
        || formatReferenceCopies === undefined
        ? undefined
        : boundedSum(transformSpanBound, formatReferenceCopies, instanceLimit);
      const inputBoundaryCount = boundedSum(bodyBound, 1, instanceLimit);
      const allReplacements = replacementPerMatch === undefined
        || inputBoundaryCount === undefined
        ? undefined
        : boundedProduct(inputBoundaryCount, replacementPerMatch, instanceLimit);
      const transformBound = allReplacements === undefined
        ? undefined
        : boundedSum(bodyBound, allReplacements, instanceLimit);
      const nextBound = transformBound === undefined
        ? undefined
        : boundedSum(renderedBound, transformBound, instanceLimit);
      if (nextBound === undefined) {
        return false;
      }
      renderedBound = nextBound;
    }

    const indentMetrics = measureRenderingSpan(
      context.insertionIndent,
      0,
      context.insertionIndent.length,
    );
    const indentBound = expandedSpanBound(indentMetrics, context, instanceLimit);
    const renderedLineCount = boundedSum(bodyMetrics.lineBreakCount, 1, instanceLimit);
    const allIndentPrefixes = indentBound === undefined || renderedLineCount === undefined
      ? undefined
      : boundedProduct(indentBound, renderedLineCount, instanceLimit);
    const withIndent = allIndentPrefixes === undefined
      ? undefined
      : boundedSum(renderedBound, allIndentPrefixes, instanceLimit);
    const nextAggregateBound = withIndent === undefined
      ? undefined
      : boundedSum(aggregateBound, withIndent, MAX_PLANNED_RENDERED_CODE_UNITS);
    if (nextAggregateBound === undefined) {
      return false;
    }
    aggregateBound = nextAggregateBound;
  }
  return true;
}

function compareRanges(
  left: InsertionReplacementRange,
  right: InsertionReplacementRange,
): number {
  return left.rangeOffset - right.rangeOffset || left.rangeLength - right.rangeLength;
}

function hasAmbiguousRanges(range_rid: readonly InsertionReplacementRange[]): boolean {
  for (let index = 1; index < range_rid.length; index += 1) {
    const previous = range_rid[index - 1];
    const current = range_rid[index];
    if (previous === undefined || current === undefined) {
      return true;
    }
    const previousEnd = safeIntegerSum(previous.rangeOffset, previous.rangeLength);
    if (previousEnd === undefined
      || current.rangeOffset === previous.rangeOffset
      || current.rangeOffset < previousEnd) {
      return true;
    }
  }
  return false;
}

function copyReplacementContexts(
  replacement_rid: readonly InsertionReplacementContext[],
  targetDocumentLength: number,
): InsertionCaptureResult<InsertionReplacementContext[]> {
  const copied_rid: InsertionReplacementContext[] = [];
  let retainedIndentCodeUnits = 0;
  for (const replacement of replacement_rid) {
    if (typeof replacement !== "object" || replacement === null
      || !isSafeNonnegativeInteger(replacement.rangeOffset)
      || !isSafeNonnegativeInteger(replacement.rangeLength)) {
      return failed("An intended replacement range is invalid.");
    }
    const rangeEnd = safeIntegerSum(replacement.rangeOffset, replacement.rangeLength);
    if (rangeEnd === undefined) {
      return failed("An intended replacement range is invalid.");
    }
    if (rangeEnd > targetDocumentLength) {
      return failed("An intended replacement range lies outside the target document.");
    }
    if ((replacement.targetEolWidth !== 1 && replacement.targetEolWidth !== 2)
      || !Number.isSafeInteger(replacement.indentSize)
      || replacement.indentSize <= 0
      || replacement.indentSize > MAX_RENDERING_INDENT_SIZE
      || typeof replacement.insertSpaces !== "boolean"
      || typeof replacement.insertionIndent !== "string"
      || replacement.insertionIndent.length > MAX_INSERTION_INDENT_CODE_UNITS
      || !/^[ \t]*$/u.test(replacement.insertionIndent)) {
      return failed("An intended replacement has invalid rendering context.");
    }
    const nextRetainedIndentCodeUnits = boundedSum(
      retainedIndentCodeUnits,
      replacement.insertionIndent.length,
      MAX_INSERTION_INDENT_CODE_UNITS,
    );
    if (nextRetainedIndentCodeUnits === undefined) {
      return failed("Intended replacement rendering contexts exceed the retention limit.");
    }
    retainedIndentCodeUnits = nextRetainedIndentCodeUnits;
    copied_rid.push({
      rangeOffset: replacement.rangeOffset,
      rangeLength: replacement.rangeLength,
      targetEolWidth: replacement.targetEolWidth,
      indentSize: replacement.indentSize,
      insertSpaces: replacement.insertSpaces,
      insertionIndent: replacement.insertionIndent,
    });
  }

  copied_rid.sort(compareRanges);
  if (hasAmbiguousRanges(copied_rid)) {
    return failed("Intended replacement ranges overlap or share a start offset.");
  }
  let aggregateGap = 0;
  for (let index = 1; index < copied_rid.length; index += 1) {
    const previous = copied_rid[index - 1];
    const current = copied_rid[index];
    const previousEnd = previous === undefined
      ? undefined
      : safeIntegerSum(previous.rangeOffset, previous.rangeLength);
    if (previousEnd === undefined || current === undefined) {
      return failed("Intended replacement ranges are invalid.");
    }
    const gap = current.rangeOffset - previousEnd;
    const nextAggregateGap = boundedSum(
      aggregateGap,
      gap,
      MAX_AGGREGATE_REPLACEMENT_GAP_CODE_UNITS,
    );
    if (nextAggregateGap === undefined) {
      return failed("Intended replacement ranges exceed the aggregate document-gap limit.");
    }
    aggregateGap = nextAggregateGap;
  }
  return { success: true, value: copied_rid };
}

function countLineBreaks(text: string): number {
  let count = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\n") {
      count += 1;
    }
  }
  return count;
}

function isNativeFinalAtRenderedInsertionEnd(
  body: string,
  tabstop_tid: readonly NumericTabstop[],
): boolean {
  const zeroTabstop_tid = tabstop_tid.filter((tabstop) => tabstop.number === 0);
  if (zeroTabstop_tid.length === 0) {
    return true;
  }
  if (zeroTabstop_tid.length !== 1) {
    return false;
  }
  const finalTabstop = zeroTabstop_tid[0];
  if (finalTabstop === undefined
    || finalTabstop.nestingDepth !== 0
    || finalTabstop.end !== body.length) {
    return false;
  }
  const sourceSpelling = body.slice(finalTabstop.start, finalTabstop.end);
  return sourceSpelling === "$0" || sourceSpelling === "${0}";
}

function sourceLineIndex(body: string, offset: number): number {
  let count = 0;
  for (let index = 0; index < offset; index += 1) {
    if (body[index] === "\n") {
      count += 1;
    }
  }
  return count;
}

function copyPlannedPad(
  body: string,
  pad: CompiledPadMetadata,
  tabstop_tid: ReadonlySet<number>,
): InsertionCaptureResult<PlannedPad> {
  if (!isSafeNonnegativeInteger(pad.offset) || pad.offset > body.length) {
    return failed("A compiled pad has an invalid body offset.");
  }
  if (!Number.isSafeInteger(pad.driverTabstop)
    || pad.driverTabstop <= 0
    || !tabstop_tid.has(pad.driverTabstop)) {
    return failed("A compiled pad has an invalid driver tabstop.");
  }
  if (typeof pad.fill !== "string"
    || pad.fill.length === 0
    || /[\r\n\t]/u.test(pad.fill)
    || !Number.isSafeInteger(pad.targetWidth)
    || pad.targetWidth <= 0
    || pad.targetWidth > MAX_PAD_TARGET_WIDTH
    || (pad.configurationName !== undefined
      && (typeof pad.configurationName !== "string"
        || !PAD_NAME_PATTERN.test(pad.configurationName)))) {
    return failed("A compiled pad has an invalid configuration.");
  }
  return {
    success: true,
    value: {
      sourceLineIndex: sourceLineIndex(body, pad.offset),
      driverTabstop: pad.driverTabstop,
      fill: pad.fill,
      targetWidth: pad.targetWidth,
      ...(pad.configurationName === undefined
        ? {}
        : { configurationName: pad.configurationName }),
    },
  };
}

/** Builds an immutable-by-copy description of a dynamic insertion before editing. */
export function createInsertionCapturePlan(
  request: InsertionCapturePlanRequest,
): InsertionCaptureResult<InsertionCapturePlan> {
  try {
    if (typeof request.snippetName !== "string" || request.snippetName.length === 0
      || typeof request.sourceUri !== "string" || request.sourceUri.length === 0
      || typeof request.targetDocumentUri !== "string" || request.targetDocumentUri.length === 0) {
      return failed("Insertion identity is invalid.");
    }
    if (!isSafeNonnegativeInteger(request.targetDocumentVersion)
      || request.targetDocumentVersion === Number.MAX_SAFE_INTEGER) {
      return failed("The pre-insertion document version is invalid.");
    }
    if (!isSafeNonnegativeInteger(request.targetDocumentLength)) {
      return failed("The pre-insertion document length is invalid.");
    }
    if (typeof request.compiled !== "object" || request.compiled === null
      || typeof request.compiled.body !== "string"
      || !Array.isArray(request.compiled.pad_pid)
      || request.compiled.pad_pid.length === 0
      || !Array.isArray(request.replacement_rid)
      || request.replacement_rid.length === 0) {
      return failed("The dynamic insertion plan is incomplete.");
    }
    if (hasLoneCarriageReturn(request.compiled.body)) {
      return failed("Lone CR line breaks are not supported in dynamic snippets; use LF or CRLF instead.");
    }

    const instanceCount = request.replacement_rid.length;
    const copiedReplacements = copyReplacementContexts(
      request.replacement_rid,
      request.targetDocumentLength,
    );
    if (!copiedReplacements.success) {
      return copiedReplacements;
    }
    const replacement_rid = copiedReplacements.value;
    const syntax = analyzeSnippetSyntax(request.compiled.body);
    if (syntax.choice_tid.length > 0) {
      return failed(
        "Numeric choices are not supported in dynamic snippets because choice UI navigation cannot be safely observed.",
      );
    }
    if (syntax.malformed) {
      return failed("The compiled dynamic snippet syntax is malformed.");
    }
    if (syntax.variable_vid.length > 0) {
      return failed("Native variables are not supported in dynamic snippets.");
    }
    if (numericTabstopsContainLineBreak(request.compiled.body, syntax.tabstop_tid)) {
      return failed(
        "Actual CR or LF characters inside numeric tab stop spans are not supported in dynamic snippets because rendered pad lines cannot be mapped safely.",
      );
    }
    if (hasAdjacentDistinctNumericTabstopGroups(syntax.tabstop_tid)) {
      return failed(
        "Source-adjacent top-level positive numeric tab stops with different identifiers are not supported in dynamic snippets because coincident group transitions cannot be observed safely.",
      );
    }
    const tabstop_tid: number[] = [];
    const occurrenceCountByTabstop = new Map<number, number>();
    let positiveTabstopOccurrenceCount = 0;
    for (const tabstop of syntax.tabstop_tid) {
      if (tabstop.number === 0) {
        continue;
      }
      if (!Number.isSafeInteger(tabstop.number) || tabstop.number < 0) {
        return failed("The snippet contains an unsafe numeric tabstop.");
      }
      tabstop_tid.push(tabstop.number);
      occurrenceCountByTabstop.set(
        tabstop.number,
        (occurrenceCountByTabstop.get(tabstop.number) ?? 0) + 1,
      );
      positiveTabstopOccurrenceCount += 1;
    }
    const sortedTabstop_tid = [...new Set(tabstop_tid)].sort((left, right) => left - right);
    const nativeFinalAtRenderedInsertionEnd = isNativeFinalAtRenderedInsertionEnd(
      request.compiled.body,
      syntax.tabstop_tid,
    );
    if (sortedTabstop_tid.length > MAX_TRACKED_TABSTOPS_PER_SESSION) {
      return failed("The insertion would exceed the tracked-tabstop limit.");
    }
    const maximumRangesPerInstance = Math.floor(
      MAX_TRACKED_SELECTION_RANGES_PER_SESSION / instanceCount,
    );
    if (sortedTabstop_tid.length > maximumRangesPerInstance
      || positiveTabstopOccurrenceCount > maximumRangesPerInstance) {
      return failed("The insertion would exceed the tracked-selection limit.");
    }
    if (!isPlannedRenderingWithinLimit(
      request.compiled.body,
      syntax.tabstop_tid,
      replacement_rid,
    )) {
      return failed("The insertion would exceed the planned-rendering limit.");
    }
    const tabstopSet = new Set(sortedTabstop_tid);

    if (request.compiled.pad_pid.length
      > Math.floor(MAX_TRACKED_PADS_PER_SESSION / instanceCount)) {
      return failed("The insertion would exceed the tracked-pad limit.");
    }

    const pad_pid: PlannedPad[] = [];
    const padCountByDriver = new Map<number, number>();
    for (const pad of request.compiled.pad_pid) {
      const copied = copyPlannedPad(request.compiled.body, pad, tabstopSet);
      if (!copied.success) {
        return copied;
      }
      pad_pid.push(copied.value);
      padCountByDriver.set(
        copied.value.driverTabstop,
        (padCountByDriver.get(copied.value.driverTabstop) ?? 0) + 1,
      );
    }

    const allPadRangeCount = pad_pid.length * instanceCount;
    const terminalRangeCount = nativeFinalAtRenderedInsertionEnd ? instanceCount : 0;
    let rememberedOccurrencesPerInstance = 0;
    for (let index = 0; index < sortedTabstop_tid.length; index += 1) {
      const tabstop = sortedTabstop_tid[index];
      if (tabstop === undefined) {
        return failed("The compiled tabstop groups are invalid.");
      }
      rememberedOccurrencesPerInstance += occurrenceCountByTabstop.get(tabstop) ?? 0;
      const nextTabstop = sortedTabstop_tid[index + 1];
      const maximumRememberedOccurrences = rememberedOccurrencesPerInstance
        + (nextTabstop === undefined ? 0 : occurrenceCountByTabstop.get(nextTabstop) ?? 0);
      const driverPadCount = padCountByDriver.get(tabstop) ?? 0;
      if (driverPadCount === 0) {
        continue;
      }
      const maximumGeneratedChangeCount = driverPadCount * instanceCount;
      const maximumRememberedSelectionCount = maximumRememberedOccurrences * instanceCount;
      const trackedRangeCount = allPadRangeCount
        + maximumRememberedSelectionCount
        + terminalRangeCount;
      if (!isProductWithinLimit(
        maximumGeneratedChangeCount,
        trackedRangeCount,
        MAX_OFFSET_TRACKING_WORK,
      )) {
        return failed("The insertion would exceed the offset-tracking workload limit.");
      }
    }

    return {
      success: true,
      value: {
        snippetName: request.snippetName,
        sourceUri: request.sourceUri,
        targetDocumentUri: request.targetDocumentUri,
        targetDocumentVersion: request.targetDocumentVersion,
        targetDocumentLength: request.targetDocumentLength,
        sourceLineBreakCount: countLineBreaks(request.compiled.body),
        nativeFinalAtRenderedInsertionEnd,
        tabstop_tid: sortedTabstop_tid,
        pad_pid,
        replacement_rid,
      },
    };
  } catch {
    return failed("The dynamic insertion plan is malformed.");
  }
}

interface RenderedLineIndex {
  readonly lineBreakCount: number;
  readonly lineEndByIndex: ReadonlyMap<number, number>;
}

function indexRenderedLineEnds(
  text: string,
  requiredLineIndexSet: ReadonlySet<number>,
): RenderedLineIndex {
  const lineEndByIndex = new Map<number, number>();
  let lineIndex = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== "\n") {
      continue;
    }
    if (requiredLineIndexSet.has(lineIndex)) {
      lineEndByIndex.set(lineIndex, index > 0 && text[index - 1] === "\r" ? index - 1 : index);
    }
    lineIndex += 1;
  }
  if (requiredLineIndexSet.has(lineIndex)) {
    lineEndByIndex.set(lineIndex, text.length);
  }
  return { lineBreakCount: lineIndex, lineEndByIndex };
}

/** Validates observed native insertion edits and derives marker-free generated ranges. */
export function finalizeInsertionCapture(
  plan: InsertionCapturePlan,
  observation: InsertionCaptureObservation,
): InsertionCaptureResult<PadInsertionSnapshot> {
  try {
    if (observation.insertionSucceeded !== true) {
      return failed("Native snippet insertion did not succeed.");
    }
    if (observation.targetDocumentUri !== plan.targetDocumentUri) {
      return failed("The insertion target document changed.");
    }
    const expectedDocumentVersion = safeIntegerSum(plan.targetDocumentVersion, 1);
    if (expectedDocumentVersion === undefined
      || observation.targetDocumentVersion !== expectedDocumentVersion) {
      return failed("The target document version was not advanced exactly once.");
    }
    if (observation.eventAmbiguousOrOverflow !== false) {
      return failed("Observed target document changes were ambiguous or exceeded the capture limit.");
    }
    const event = observation.event;
    if (event === undefined) {
      return failed("Expected exactly one target document change event.");
    }
    if (event.targetDocumentVersion !== observation.targetDocumentVersion
      || !Array.isArray(event.change_cid)) {
      return failed("The target document change event is invalid.");
    }
    if (event.change_cid.length !== plan.replacement_rid.length) {
      return failed("The insertion change count does not match the intended ranges.");
    }
    if (plan.pad_pid.length > Math.floor(MAX_TRACKED_PADS_PER_SESSION / event.change_cid.length)) {
      return failed("The insertion exceeds the tracked-pad limit.");
    }

    const change_cid: InsertionContentChange[] = [];
    let retainedObservedCodeUnits = 0;
    for (const change of event.change_cid) {
      if (!isSafeNonnegativeInteger(change.rangeOffset)
        || !isSafeNonnegativeInteger(change.rangeLength)
        || safeIntegerSum(change.rangeOffset, change.rangeLength) === undefined
        || typeof change.text !== "string") {
        return failed("An observed insertion change is invalid.");
      }
      if (change.text.length
        > MAX_RETAINED_OBSERVED_CHANGE_TEXT_CODE_UNITS - retainedObservedCodeUnits) {
        return failed("The observed insertion text exceeds the capture limit.");
      }
      retainedObservedCodeUnits += change.text.length;
      change_cid.push({
        rangeOffset: change.rangeOffset,
        rangeLength: change.rangeLength,
        text: change.text,
      });
    }
    change_cid.sort(compareRanges);
    const intended_rid = [...plan.replacement_rid].sort(compareRanges);
    for (let index = 0; index < change_cid.length; index += 1) {
      const change = change_cid[index];
      const intended = intended_rid[index];
      if (change === undefined || intended === undefined
        || change.rangeOffset !== intended.rangeOffset
        || change.rangeLength !== intended.rangeLength) {
        return failed("Observed changes do not match the intended replacement ranges.");
      }
    }

    const pad_pid: CapturedPad[] = [];
    const terminal_rid: GeneratedOffsetRange[] = [];
    const requiredLineIndexSet = new Set(plan.pad_pid.map((pad) => pad.sourceLineIndex));
    let precedingDelta = 0;
    for (const change of change_cid) {
      const insertionStart = safeIntegerSum(change.rangeOffset, precedingDelta);
      if (insertionStart === undefined || insertionStart < 0) {
        return failed("A rendered insertion start offset is invalid.");
      }
      const renderedLineIndex = indexRenderedLineEnds(change.text, requiredLineIndexSet);
      if (renderedLineIndex.lineBreakCount !== plan.sourceLineBreakCount) {
        return failed("A rendered insertion changed the snippet line count.");
      }
      for (const pad of plan.pad_pid) {
        const lineEnd = renderedLineIndex.lineEndByIndex.get(pad.sourceLineIndex);
        const anchor = lineEnd === undefined
          ? undefined
          : safeIntegerSum(insertionStart, lineEnd);
        if (anchor === undefined) {
          return failed("A rendered pad line could not be located.");
        }
        pad_pid.push({
          driverTabstop: pad.driverTabstop,
          fill: pad.fill,
          targetWidth: pad.targetWidth,
          ...(pad.configurationName === undefined
            ? {}
            : { configurationName: pad.configurationName }),
          generated: { start: anchor, end: anchor },
        });
      }
      if (plan.nativeFinalAtRenderedInsertionEnd === true) {
        const terminalOffset = safeIntegerSum(insertionStart, change.text.length);
        if (terminalOffset === undefined) {
          return failed("A rendered terminal endpoint exceeds the safe offset range.");
        }
        terminal_rid.push({ start: terminalOffset, end: terminalOffset });
      }
      const changeDelta = safeIntegerSum(change.text.length, -change.rangeLength);
      const nextPrecedingDelta = changeDelta === undefined
        ? undefined
        : safeIntegerSum(precedingDelta, changeDelta);
      if (nextPrecedingDelta === undefined) {
        return failed("Simultaneous insertion offsets exceed the safe range.");
      }
      precedingDelta = nextPrecedingDelta;
    }

    return {
      success: true,
      value: {
        snippetName: plan.snippetName,
        sourceUri: plan.sourceUri,
        targetDocumentUri: plan.targetDocumentUri,
        targetDocumentVersion: observation.targetDocumentVersion,
        instanceCount: change_cid.length,
        tabstop_tid: [...plan.tabstop_tid],
        pad_pid,
        terminal_rid,
      },
    };
  } catch {
    return failed("The insertion capture observation is malformed.");
  }
}
