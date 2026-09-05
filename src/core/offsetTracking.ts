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

interface IndexedChange extends ContentChange {
  readonly originalIndex: number;
}

function orderedChanges(change_cid: readonly ContentChange[]): readonly IndexedChange[] {
  const indexed_cid = change_cid.map((change, originalIndex) => ({ ...change, originalIndex }));
  indexed_cid.sort((left, right) => left.rangeOffset - right.rangeOffset);

  let previousEnd = -1;
  let previousStart = -1;
  for (const change of indexed_cid) {
    if (!Number.isInteger(change.rangeOffset)
      || !Number.isInteger(change.rangeLength)
      || change.rangeOffset < 0
      || change.rangeLength < 0) {
      throw new RangeError("Content change ranges must contain non-negative integer offsets and lengths.");
    }
    if (change.rangeOffset < previousEnd || change.rangeOffset === previousStart) {
      throw new RangeError("Content changes must be non-overlapping and unambiguous.");
    }
    previousStart = change.rangeOffset;
    previousEnd = change.rangeOffset + change.rangeLength;
  }
  return indexed_cid;
}

/** Rebases one UTF-16 offset through changes whose ranges refer to the pre-change text. */
export function rebaseOffset(
  offset: number,
  change_cid: readonly ContentChange[],
  affinity: OffsetAffinity,
): number {
  if (!Number.isInteger(offset) || offset < 0) {
    throw new RangeError("Offset must be a non-negative integer.");
  }

  let delta = 0;
  for (const change of orderedChanges(change_cid)) {
    const start = change.rangeOffset;
    const end = start + change.rangeLength;
    if (offset < start) {
      break;
    }
    if (offset === start) {
      return start + delta + (affinity === "right" ? change.text.length : 0);
    }
    if (offset < end) {
      return start + delta + (affinity === "right" ? change.text.length : 0);
    }
    delta += change.text.length - change.rangeLength;
  }
  return offset + delta;
}

export function rebaseRange(
  range: OffsetRange,
  change_cid: readonly ContentChange[],
  startAffinity: OffsetAffinity = "right",
  endAffinity: OffsetAffinity = "left",
): OffsetRange {
  if (!Number.isInteger(range.start) || !Number.isInteger(range.end) || range.start < 0 || range.end < range.start) {
    throw new RangeError("Range must contain ordered non-negative integer offsets.");
  }
  const effectiveEndAffinity = range.start === range.end ? startAffinity : endAffinity;
  return {
    start: rebaseOffset(range.start, change_cid, startAffinity),
    end: rebaseOffset(range.end, change_cid, effectiveEndAffinity),
  };
}

/** Rebases a generated range only when every change is provably outside it. */
export function rebaseProtectedRange(
  range: OffsetRange,
  change_cid: readonly ContentChange[],
): RebasedRangeResult {
  let ordered_cid: readonly IndexedChange[];
  try {
    ordered_cid = orderedChanges(change_cid);
  } catch (error: unknown) {
    return {
      valid: false,
      reason: "invalid-change-set",
      message: error instanceof Error ? error.message : "Invalid content changes.",
    };
  }

  if (!Number.isInteger(range.start) || !Number.isInteger(range.end) || range.start < 0 || range.end < range.start) {
    return { valid: false, reason: "invalid-change-set", message: "Tracked range is invalid." };
  }

  for (const change of ordered_cid) {
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

  return { valid: true, range: rebaseRange(range, change_cid) };
}
