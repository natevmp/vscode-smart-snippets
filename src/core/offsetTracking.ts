export type OffsetAffinity = "left" | "right";

export interface ContentChange {
  readonly rangeOffset: number;
  readonly rangeLength: number;
  readonly text: string;
}

export interface OffsetRange {
  readonly start: number;
  readonly end: number;
}

export interface RebasedRangeSuccess {
  readonly valid: true;
  readonly range: OffsetRange;
}

export interface RebasedRangeFailure {
  readonly valid: false;
  readonly reason: "invalid-change-set" | "protected-range-overlap";
  readonly message: string;
  readonly changeIndex?: number;
}

export type RebasedRangeResult = RebasedRangeSuccess | RebasedRangeFailure;

export const MAX_PREPARED_CONTENT_CHANGES = 4_096;
export const MAX_OFFSET_TRACKING_WORK = 1_048_576;

export interface PreparedContentChange extends ContentChange {
  readonly originalIndex: number;
}

export interface PreparedContentChanges {
  readonly change_cid: readonly PreparedContentChange[];
}

/** Validates, copies, and orders one change set for reuse across tracked ranges. */
export function prepareContentChanges(
  change_cid: readonly ContentChange[],
): PreparedContentChanges {
  if (change_cid.length > MAX_PREPARED_CONTENT_CHANGES) {
    throw new RangeError("Content change count exceeds the tracking limit.");
  }
  const indexed_cid = change_cid.map((change, originalIndex) => ({ ...change, originalIndex }));
  indexed_cid.sort((left, right) => left.rangeOffset - right.rangeOffset);

  let previousEnd = -1;
  let previousStart = -1;
  for (const change of indexed_cid) {
    if (!Number.isSafeInteger(change.rangeOffset)
      || !Number.isSafeInteger(change.rangeLength)
      || change.rangeOffset < 0
      || change.rangeLength < 0
      || typeof change.text !== "string"
      || !Number.isSafeInteger(change.rangeOffset + change.rangeLength)) {
      throw new RangeError("Content change ranges must contain non-negative integer offsets and lengths.");
    }
    if (change.rangeOffset < previousEnd || change.rangeOffset === previousStart) {
      throw new RangeError("Content changes must be non-overlapping and unambiguous.");
    }
    previousStart = change.rangeOffset;
    previousEnd = change.rangeOffset + change.rangeLength;
  }
  return { change_cid: indexed_cid };
}

/** Checks a range/change workload before any quadratic tracking pass is attempted. */
export function isOffsetTrackingWorkWithinLimit(
  rangeCount: number,
  prepared: PreparedContentChanges,
): boolean {
  return Number.isSafeInteger(rangeCount)
    && rangeCount >= 0
    && (rangeCount === 0
      || prepared.change_cid.length <= Math.floor(MAX_OFFSET_TRACKING_WORK / rangeCount));
}

/** Rebases one offset through an already validated and ordered change set. */
export function rebaseOffsetWithPreparedChanges(
  offset: number,
  prepared: PreparedContentChanges,
  affinity: OffsetAffinity,
): number {
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new RangeError("Offset must be a non-negative integer.");
  }

  let delta = 0;
  for (const change of prepared.change_cid) {
    const start = change.rangeOffset;
    const end = start + change.rangeLength;
    if (offset < start) {
      break;
    }
    if (offset === start) {
      const rebased = start + delta + (affinity === "right" ? change.text.length : 0);
      if (!Number.isSafeInteger(rebased)) {
        throw new RangeError("Rebased offset exceeds the safe integer range.");
      }
      return rebased;
    }
    if (offset < end) {
      const rebased = start + delta + (affinity === "right" ? change.text.length : 0);
      if (!Number.isSafeInteger(rebased)) {
        throw new RangeError("Rebased offset exceeds the safe integer range.");
      }
      return rebased;
    }
    delta += change.text.length - change.rangeLength;
    if (!Number.isSafeInteger(delta)) {
      throw new RangeError("Content change delta exceeds the safe integer range.");
    }
  }
  const rebased = offset + delta;
  if (!Number.isSafeInteger(rebased)) {
    throw new RangeError("Rebased offset exceeds the safe integer range.");
  }
  return rebased;
}

/** Rebases one UTF-16 offset through changes whose ranges refer to the pre-change text. */
export function rebaseOffset(
  offset: number,
  change_cid: readonly ContentChange[],
  affinity: OffsetAffinity,
): number {
  return rebaseOffsetWithPreparedChanges(offset, prepareContentChanges(change_cid), affinity);
}

export function rebaseRangeWithPreparedChanges(
  range: OffsetRange,
  prepared: PreparedContentChanges,
  startAffinity: OffsetAffinity = "right",
  endAffinity: OffsetAffinity = "left",
): OffsetRange {
  if (!Number.isSafeInteger(range.start)
    || !Number.isSafeInteger(range.end)
    || range.start < 0
    || range.end < range.start) {
    throw new RangeError("Range must contain ordered non-negative integer offsets.");
  }
  const effectiveEndAffinity = range.start === range.end ? startAffinity : endAffinity;
  return {
    start: rebaseOffsetWithPreparedChanges(range.start, prepared, startAffinity),
    end: rebaseOffsetWithPreparedChanges(range.end, prepared, effectiveEndAffinity),
  };
}

export function rebaseRange(
  range: OffsetRange,
  change_cid: readonly ContentChange[],
  startAffinity: OffsetAffinity = "right",
  endAffinity: OffsetAffinity = "left",
): OffsetRange {
  return rebaseRangeWithPreparedChanges(
    range,
    prepareContentChanges(change_cid),
    startAffinity,
    endAffinity,
  );
}

/** Rebases a protected range through an already validated and ordered change set. */
export function rebaseProtectedRangeWithPreparedChanges(
  range: OffsetRange,
  prepared: PreparedContentChanges,
): RebasedRangeResult {
  if (!Number.isSafeInteger(range.start)
    || !Number.isSafeInteger(range.end)
    || range.start < 0
    || range.end < range.start) {
    return { valid: false, reason: "invalid-change-set", message: "Tracked range is invalid." };
  }

  for (const change of prepared.change_cid) {
    const changeEnd = change.rangeOffset + change.rangeLength;
    const insertionInside = change.rangeLength === 0
      && change.rangeOffset > range.start
      && change.rangeOffset < range.end;
    const replacementIntersects = change.rangeLength > 0
      && change.rangeOffset < range.end
      && changeEnd > range.start;
    if (insertionInside || replacementIntersects) {
      return {
        valid: false,
        reason: "protected-range-overlap",
        message: "A content change intersects the protected generated range.",
        changeIndex: change.originalIndex,
      };
    }
  }

  try {
    return { valid: true, range: rebaseRangeWithPreparedChanges(range, prepared) };
  } catch (error: unknown) {
    return {
      valid: false,
      reason: "invalid-change-set",
      message: error instanceof Error ? error.message : "Invalid content changes.",
    };
  }
}

/** Rebases a generated range only when every change is provably outside it. */
export function rebaseProtectedRange(
  range: OffsetRange,
  change_cid: readonly ContentChange[],
): RebasedRangeResult {
  let prepared: PreparedContentChanges;
  try {
    prepared = prepareContentChanges(change_cid);
  } catch (error: unknown) {
    return {
      valid: false,
      reason: "invalid-change-set",
      message: error instanceof Error ? error.message : "Invalid content changes.",
    };
  }

  return rebaseProtectedRangeWithPreparedChanges(range, prepared);
}
