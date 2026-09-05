import { MAX_PAD_TARGET_WIDTH, type OffsetRange } from "../core/index.js";

export interface PadInsertionSnapshotInput {
  readonly snippetName: string;
  readonly sourceUri: string;
  readonly targetDocumentUri: string;
  readonly targetDocumentVersion: number;
  readonly driverTabstop: number;
  readonly fill: string;
  readonly targetWidth: number;
}

export interface DriverSelectionTransitions {
  readonly enteredDriverIndex_did: readonly number[];
  readonly exitedPendingDriverIndex_did: readonly number[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function hasOwnDataProperties(value: Record<string, unknown>, property_pid: readonly string[]): boolean {
  const descriptorByProperty = Object.getOwnPropertyDescriptors(value);
  return property_pid.every((property) => {
    const descriptor = descriptorByProperty[property];
    return descriptor !== undefined && "value" in descriptor;
  });
}

/** Validates the serialized command argument without trusting its prototype or fields. */
export function isPadInsertionSnapshot(value: unknown): value is PadInsertionSnapshotInput {
  try {
    return isPlainObject(value)
      && hasOwnDataProperties(value, [
        "snippetName",
        "sourceUri",
        "targetDocumentUri",
        "targetDocumentVersion",
        "driverTabstop",
        "fill",
        "targetWidth",
      ])
      && typeof value.snippetName === "string"
      && value.snippetName.length > 0
      && typeof value.sourceUri === "string"
      && value.sourceUri.length > 0
      && typeof value.targetDocumentUri === "string"
      && value.targetDocumentUri.length > 0
      && typeof value.targetDocumentVersion === "number"
      && Number.isInteger(value.targetDocumentVersion)
      && value.targetDocumentVersion >= 0
      && typeof value.driverTabstop === "number"
      && Number.isInteger(value.driverTabstop)
      && value.driverTabstop > 0
      && typeof value.fill === "string"
      && value.fill.length === 1
      && !/[\r\n\t]/u.test(value.fill)
      && typeof value.targetWidth === "number"
      && Number.isInteger(value.targetWidth)
      && value.targetWidth > 0
      && value.targetWidth <= MAX_PAD_TARGET_WIDTH;
  } catch {
    return false;
  }
}

export function isRangeContainedByRange(inner: OffsetRange, outer: OffsetRange): boolean {
  return inner.start >= 0
    && inner.end >= inner.start
    && outer.start >= 0
    && outer.end >= outer.start
    && inner.start >= outer.start
    && inner.end <= outer.end;
}

/**
 * Matches selections and drivers by document order. The returned indices refer to
 * the original driver array, so VS Code's primary-selection ordering is irrelevant.
 */
export function matchSelectionRangesToDriverRanges(
  selection_sid: readonly OffsetRange[],
  driver_did: readonly OffsetRange[],
): readonly number[] | undefined {
  if (selection_sid.length !== driver_did.length) {
    return undefined;
  }

  const orderedSelection_sid = selection_sid
    .map((range, index) => ({ range, index }))
    .sort((left, right) => left.range.start - right.range.start
      || left.range.end - right.range.end
      || left.index - right.index);
  const orderedDriver_did = driver_did
    .map((range, index) => ({ range, index }))
    .sort((left, right) => left.range.start - right.range.start
      || left.range.end - right.range.end
      || left.index - right.index);

  const matchedDriverIndex_did: number[] = [];
  for (let index = 0; index < orderedSelection_sid.length; index += 1) {
    const selection = orderedSelection_sid[index];
    const driver = orderedDriver_did[index];
    if (selection === undefined
      || driver === undefined
      || !isRangeContainedByRange(selection.range, driver.range)) {
      return undefined;
    }
    matchedDriverIndex_did.push(driver.index);
  }
  return matchedDriverIndex_did;
}

/** Finds driver entry and pending-driver exit transitions independent of selection order. */
export function getDriverSelectionTransitions(
  previousSelection_sid: readonly OffsetRange[],
  currentSelection_sid: readonly OffsetRange[],
  driver_did: readonly OffsetRange[],
  pendingDriver_pid: readonly boolean[],
): DriverSelectionTransitions {
  const enteredDriverIndex_did: number[] = [];
  const exitedPendingDriverIndex_did: number[] = [];

  for (let index = 0; index < driver_did.length; index += 1) {
    const driver = driver_did[index];
    if (driver === undefined) {
      continue;
    }
    const wasInside = previousSelection_sid.some((selection) => isRangeContainedByRange(selection, driver));
    const isInside = currentSelection_sid.some((selection) => isRangeContainedByRange(selection, driver));
    if (!wasInside && isInside) {
      enteredDriverIndex_did.push(index);
    }
    if (wasInside && !isInside && pendingDriver_pid[index] === true) {
      exitedPendingDriverIndex_did.push(index);
    }
  }

  return { enteredDriverIndex_did, exitedPendingDriverIndex_did };
}
