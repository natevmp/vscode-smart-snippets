import {
  MAX_TRACKED_PADS_PER_SESSION,
  MAX_TRACKED_SELECTION_RANGES_PER_SESSION,
  MAX_TRACKED_TABSTOPS_PER_SESSION,
  type PadInsertionSnapshot,
} from "../completion/insertionCapture.js";
import {
  MAX_PAD_TARGET_WIDTH,
  rebaseOffsetWithPreparedChanges,
  type OffsetRange,
  type PreparedContentChanges,
} from "../core/index.js";

export type TrackedPadState = "pending" | "settled" | "invalid";

export type SerialTaskIdentityLifecycle = "active" | "completed" | "invalidated" | "retired";

export interface SerialTaskIdentity {
  lifecycle: SerialTaskIdentityLifecycle;
  acceptedTaskCount: number;
}

export type SerialTaskIdentityEndReason = "completed" | "invalidated";

export type CompletedNavigationEvent =
  | { readonly kind: "document" }
  | { readonly kind: "selection"; readonly selection_sid: readonly OffsetRange[] };

export interface DriverPadState {
  readonly driverTabstop: number;
  readonly state: TrackedPadState;
}

export interface TabstopSelectionGroup {
  readonly tabstop: number;
  readonly selection_sid: readonly OffsetRange[];
}

export type SelectionTransition =
  | { readonly kind: "observed"; readonly tabstop: number }
  | { readonly kind: "terminal" };

export type ForwardSelectionTransition =
  | { readonly kind: "unsafe" }
  | { readonly kind: "next" }
  | { readonly kind: "terminal" };

export type CurrentGroupSelectionAttribution = "none" | "all" | "mixed" | "unsafe";

export type FallbackSelectionTransition =
  | { readonly kind: "stay" }
  | { readonly kind: "discard" }
  | { readonly kind: "observed"; readonly tabstop: number }
  | { readonly kind: "terminal" };

export interface CompletedNavigationGroup {
  readonly tabstop: number;
  readonly selection_sid: readonly OffsetRange[] | undefined;
}

export interface CompletedNavigationState {
  readonly instanceCount: number;
  readonly currentGroup_sid: readonly OffsetRange[];
  readonly remainingGroup_gid: readonly CompletedNavigationGroup[];
  readonly nextGroupIndex: number;
  readonly terminal_rid: readonly OffsetRange[];
}

export type CompletedNavigationTransition =
  | { readonly kind: "unsafe" }
  | { readonly kind: "next"; readonly state: CompletedNavigationState }
  | { readonly kind: "terminal" };

function dataProperties(
  value: unknown,
  requiredProperty_pid: readonly string[],
  optionalProperty_pid: readonly string[] = [],
): Readonly<Record<string, unknown>> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    return undefined;
  }
  if (Object.getOwnPropertySymbols(value).length !== 0) {
    return undefined;
  }

  const allowedProperty = new Set([...requiredProperty_pid, ...optionalProperty_pid]);
  const descriptorByProperty = Object.getOwnPropertyDescriptors(value) as Record<
    string,
    PropertyDescriptor | undefined
  >;
  if (Object.keys(descriptorByProperty).some((property) => !allowedProperty.has(property))) {
    return undefined;
  }

  const propertyValues: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const property of requiredProperty_pid) {
    const descriptor = descriptorByProperty[property];
    if (descriptor === undefined || !("value" in descriptor)) {
      return undefined;
    }
    propertyValues[property] = descriptor.value;
  }
  for (const property of optionalProperty_pid) {
    const descriptor = descriptorByProperty[property];
    if (descriptor !== undefined) {
      if (!("value" in descriptor)) {
        return undefined;
      }
      propertyValues[property] = descriptor.value;
    }
  }
  return propertyValues;
}

function arrayDataValues(value: unknown, maximumLength: number): readonly unknown[] | undefined {
  if (!Array.isArray(value)
    || Object.getPrototypeOf(value) !== Array.prototype
    || Object.getOwnPropertySymbols(value).length !== 0) {
    return undefined;
  }
  const descriptorByProperty = Object.getOwnPropertyDescriptors(value) as Record<
    string,
    PropertyDescriptor | undefined
  >;
  const lengthDescriptor = descriptorByProperty.length;
  if (lengthDescriptor === undefined
    || !("value" in lengthDescriptor)
    || typeof lengthDescriptor.value !== "number"
    || !Number.isSafeInteger(lengthDescriptor.value)) {
    return undefined;
  }
  const length = lengthDescriptor.value;
  if (length < 0
    || length > maximumLength
    || Object.keys(descriptorByProperty).length !== length + 1) {
    return undefined;
  }

  const element_eid: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptorByProperty[String(index)];
    if (descriptor === undefined || !("value" in descriptor)) {
      return undefined;
    }
    element_eid.push(descriptor.value);
  }
  return element_eid;
}

function isSafeNonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Validates the complete serialized command argument without trusting nested fields. */
export function isPadInsertionSnapshot(value: unknown): value is PadInsertionSnapshot {
  try {
    const snapshot = dataProperties(value, [
      "snippetName",
      "sourceUri",
      "targetDocumentUri",
      "targetDocumentVersion",
      "instanceCount",
      "tabstop_tid",
      "pad_pid",
      "terminal_rid",
    ]);
    if (snapshot === undefined
      || typeof snapshot.snippetName !== "string"
      || snapshot.snippetName.length === 0
      || typeof snapshot.sourceUri !== "string"
      || snapshot.sourceUri.length === 0
      || typeof snapshot.targetDocumentUri !== "string"
      || snapshot.targetDocumentUri.length === 0
      || !isSafeNonnegativeInteger(snapshot.targetDocumentVersion)
      || typeof snapshot.instanceCount !== "number"
      || !Number.isSafeInteger(snapshot.instanceCount)
      || snapshot.instanceCount <= 0) {
      return false;
    }

    const tabstop_tid = arrayDataValues(snapshot.tabstop_tid, MAX_TRACKED_TABSTOPS_PER_SESSION);
    if (tabstop_tid === undefined || tabstop_tid.length === 0) {
      return false;
    }
    if (tabstop_tid.length > Math.floor(
      MAX_TRACKED_SELECTION_RANGES_PER_SESSION / snapshot.instanceCount,
    )) {
      return false;
    }
    let previousTabstop = 0;
    for (const tabstop of tabstop_tid) {
      if (typeof tabstop !== "number"
        || !Number.isSafeInteger(tabstop)
        || tabstop <= previousTabstop) {
        return false;
      }
      previousTabstop = tabstop;
    }
    const tabstopSet = new Set(tabstop_tid);

    const pad_pid = arrayDataValues(snapshot.pad_pid, MAX_TRACKED_PADS_PER_SESSION);
    if (pad_pid === undefined
      || pad_pid.length === 0
      || pad_pid.length % snapshot.instanceCount !== 0) {
      return false;
    }
    for (const padValue of pad_pid) {
      const pad = dataProperties(
        padValue,
        ["driverTabstop", "fill", "targetWidth", "generated"],
        ["configurationName"],
      );
      if (pad === undefined
        || typeof pad.driverTabstop !== "number"
        || !Number.isSafeInteger(pad.driverTabstop)
        || !tabstopSet.has(pad.driverTabstop)
        || typeof pad.fill !== "string"
        || pad.fill.length === 0
        || /[\r\n\t]/u.test(pad.fill)
        || typeof pad.targetWidth !== "number"
        || !Number.isSafeInteger(pad.targetWidth)
        || pad.targetWidth <= 0
        || pad.targetWidth > MAX_PAD_TARGET_WIDTH
        || ("configurationName" in pad && typeof pad.configurationName !== "string")) {
        return false;
      }
      const generated = dataProperties(pad.generated, ["start", "end"]);
      if (generated === undefined
        || !isSafeNonnegativeInteger(generated.start)
        || !isSafeNonnegativeInteger(generated.end)
        || generated.end < generated.start) {
        return false;
      }
    }

    const terminal_rid = arrayDataValues(
      snapshot.terminal_rid,
      MAX_TRACKED_SELECTION_RANGES_PER_SESSION,
    );
    if (terminal_rid === undefined
      || (terminal_rid.length !== 0 && terminal_rid.length !== snapshot.instanceCount)) {
      return false;
    }
    for (const terminalValue of terminal_rid) {
      const terminal = dataProperties(terminalValue, ["start", "end"]);
      if (terminal === undefined
        || !isSafeNonnegativeInteger(terminal.start)
        || !isSafeNonnegativeInteger(terminal.end)
        || terminal.start !== terminal.end) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

function isValidOffsetRange(range: OffsetRange | null | undefined): boolean {
  return range !== null
    && range !== undefined
    && Number.isSafeInteger(range.start)
    && Number.isSafeInteger(range.end)
    && range.start >= 0
    && range.end >= range.start;
}

function selectionRangesAreValid(selection_sid: readonly OffsetRange[]): boolean {
  if (selection_sid.length === 0
    || selection_sid.length > MAX_TRACKED_SELECTION_RANGES_PER_SESSION) {
    return false;
  }
  for (let index = 0; index < selection_sid.length; index += 1) {
    if (!isValidOffsetRange(selection_sid[index])) {
      return false;
    }
  }
  return true;
}

export function isRangeContainedByRange(inner: OffsetRange, outer: OffsetRange): boolean {
  return isValidOffsetRange(inner)
    && isValidOffsetRange(outer)
    && inner.start >= outer.start
    && inner.end <= outer.end;
}

/** Matches mirrored selections to one observed tabstop group independent of selection order. */
export function selectionRangesMatchGroup(
  selection_sid: readonly OffsetRange[],
  observedSelection_sid: readonly OffsetRange[],
): boolean {
  if (selection_sid.length !== observedSelection_sid.length) {
    return false;
  }
  const rangeOrder = (left: OffsetRange, right: OffsetRange): number => left.start - right.start || left.end - right.end;
  const orderedSelection_sid = [...selection_sid].sort(rangeOrder);
  const orderedObservedSelection_sid = [...observedSelection_sid].sort(rangeOrder);
  return orderedSelection_sid.every((selection, index) => {
    const observed = orderedObservedSelection_sid[index];
    return observed !== undefined && isRangeContainedByRange(selection, observed);
  });
}

/** Classifies how many selections remain attributable to the current group. */
export function classifyCurrentGroupSelectionAttribution(
  selection_sid: readonly OffsetRange[],
  currentGroup_sid: readonly OffsetRange[],
): CurrentGroupSelectionAttribution {
  if (!selectionRangesAreValid(selection_sid) || !selectionRangesAreValid(currentGroup_sid)) {
    return "unsafe";
  }

  const rangeOrder = (left: OffsetRange, right: OffsetRange): number => left.start - right.start || left.end - right.end;
  const orderedSelection_sid = [...selection_sid].sort(rangeOrder);
  const orderedCurrentGroup_sid = [...currentGroup_sid].sort(rangeOrder);
  let currentGroupIndex = 0;
  let maximumCurrentEnd = -1;
  let attributedSelectionCount = 0;
  for (const selection of orderedSelection_sid) {
    while (currentGroupIndex < orderedCurrentGroup_sid.length) {
      const currentRange = orderedCurrentGroup_sid[currentGroupIndex];
      if (currentRange === undefined || currentRange.start > selection.start) {
        break;
      }
      maximumCurrentEnd = Math.max(maximumCurrentEnd, currentRange.end);
      currentGroupIndex += 1;
    }
    if (selection.end <= maximumCurrentEnd) {
      // Count duplicate selections independently; current ranges are not consumed.
      attributedSelectionCount += 1;
    }
  }

  if (attributedSelectionCount === 0) {
    return "none";
  }
  return attributedSelectionCount === selection_sid.length ? "all" : "mixed";
}

/** Requires every surviving selection to be a captured, zero-width final endpoint. */
export function selectionsMatchPredictedTerminalEndpoints(
  selection_sid: readonly OffsetRange[],
  terminal_rid: readonly OffsetRange[],
): boolean {
  if (!selectionRangesAreValid(selection_sid)
    || terminal_rid.length === 0
    || terminal_rid.length > MAX_TRACKED_SELECTION_RANGES_PER_SESSION) {
    return false;
  }
  const terminalOffsetSet = new Set<number>();
  for (const terminal of terminal_rid) {
    if (!isValidOffsetRange(terminal) || terminal.start !== terminal.end) {
      return false;
    }
    terminalOffsetSet.add(terminal.start);
  }
  return selection_sid.every((selection) => (
    selection.start === selection.end && terminalOffsetSet.has(selection.start)
  ));
}

/**
 * Resolves a commanded forward transition from public selection ranges only.
 * Range copies are sorted so attribution remains order-independent and bounded.
 */
export function resolveForwardSelectionTransition(
  postSelection_sid: readonly OffsetRange[],
  currentGroup_sid: readonly OffsetRange[],
  expectedNextGroup_sid: readonly OffsetRange[] | undefined,
  terminalTransition: boolean,
  terminal_rid: readonly OffsetRange[],
  selectionCardinalityValid = true,
): ForwardSelectionTransition {
  if (expectedNextGroup_sid !== undefined
    && !selectionRangesAreValid(expectedNextGroup_sid)) {
    return { kind: "unsafe" };
  }

  const attribution = classifyCurrentGroupSelectionAttribution(
    postSelection_sid,
    currentGroup_sid,
  );
  if (attribution === "unsafe" || attribution === "mixed") {
    return { kind: "unsafe" };
  }

  if (terminalTransition) {
    if (attribution === "none" && selectionCardinalityValid) {
      return { kind: "terminal" };
    }
    return selectionsMatchPredictedTerminalEndpoints(postSelection_sid, terminal_rid)
      ? { kind: "terminal" }
      : { kind: "unsafe" };
  }
  if (!selectionCardinalityValid
    || attribution !== "none"
    || (expectedNextGroup_sid !== undefined
      && !selectionRangesMatchGroup(postSelection_sid, expectedNextGroup_sid))) {
    return { kind: "unsafe" };
  }
  return { kind: "next" };
}

/** Advances bounded post-session navigation, learning only complete positive groups. */
export function resolveCompletedNavigationTransition(
  state: CompletedNavigationState,
  postSelection_sid: readonly OffsetRange[],
): CompletedNavigationTransition {
  const nextGroup = state.remainingGroup_gid[state.nextGroupIndex];
  if (nextGroup === undefined) {
    return selectionsMatchPredictedTerminalEndpoints(postSelection_sid, state.terminal_rid)
      ? { kind: "terminal" }
      : { kind: "unsafe" };
  }
  const transition = resolveForwardSelectionTransition(
    postSelection_sid,
    state.currentGroup_sid,
    nextGroup.selection_sid,
    false,
    state.terminal_rid,
    isValidSelectionCardinality(postSelection_sid.length, state.instanceCount),
  );
  if (transition.kind !== "next") {
    return { kind: "unsafe" };
  }
  return {
    kind: "next",
    state: {
      ...state,
      currentGroup_sid: postSelection_sid.map((selection) => ({ ...selection })),
      nextGroupIndex: state.nextGroupIndex + 1,
    },
  };
}

/** Rebases predicted final points with right affinity and keeps them in-document. */
export function rebaseTerminalEndpoints(
  terminal_rid: readonly OffsetRange[],
  preparedChanges: PreparedContentChanges,
  documentLength: number,
): readonly OffsetRange[] | undefined {
  if (!isSafeNonnegativeInteger(documentLength)
    || terminal_rid.length > MAX_TRACKED_SELECTION_RANGES_PER_SESSION) {
    return undefined;
  }
  const rebasedTerminal_rid: OffsetRange[] = [];
  try {
    for (const terminal of terminal_rid) {
      if (!isValidOffsetRange(terminal) || terminal.start !== terminal.end) {
        return undefined;
      }
      const start = rebaseOffsetWithPreparedChanges(terminal.start, preparedChanges, "right");
      const end = rebaseOffsetWithPreparedChanges(terminal.end, preparedChanges, "right");
      if (!isSafeNonnegativeInteger(start)
        || !isSafeNonnegativeInteger(end)
        || start !== end
        || end > documentLength) {
        return undefined;
      }
      rebasedTerminal_rid.push({ start, end });
    }
  } catch {
    return undefined;
  }
  return rebasedTerminal_rid;
}

/** Counts every range retained by a session for offset-work accounting. */
export function countTrackedSessionRanges(
  padCount: number,
  group_gid: readonly TabstopSelectionGroup[],
  terminal_rid: readonly OffsetRange[],
): number | undefined {
  if (!isSafeNonnegativeInteger(padCount)) {
    return undefined;
  }
  let trackedRangeCount = padCount + terminal_rid.length;
  if (!Number.isSafeInteger(trackedRangeCount)) {
    return undefined;
  }
  for (const group of group_gid) {
    trackedRangeCount += group.selection_sid.length;
    if (!Number.isSafeInteger(trackedRangeCount)) {
      return undefined;
    }
  }
  return trackedRangeCount;
}

/** Requires at least one selection per instance while allowing mirrored occurrences. */
export function isValidSelectionCardinality(
  selectionCount: number,
  instanceCount: number,
): boolean {
  return Number.isSafeInteger(selectionCount)
    && Number.isSafeInteger(instanceCount)
    && instanceCount > 0
    && selectionCount >= instanceCount
    && selectionCount <= MAX_TRACKED_SELECTION_RANGES_PER_SESSION
    && selectionCount % instanceCount === 0;
}

/** Bounds the ranges retained after adding or replacing one observed tabstop group. */
export function canRememberTabstopSelections(
  instanceCount: number,
  group_gid: readonly TabstopSelectionGroup[],
  tabstop: number,
  selection_sid: readonly OffsetRange[],
): boolean {
  if (!isValidSelectionCardinality(selection_sid.length, instanceCount)) {
    return false;
  }
  let retainedRangeCount = selection_sid.length;
  const seenTabstop = new Set<number>();
  for (const group of group_gid) {
    if (seenTabstop.has(group.tabstop)
      || !isValidSelectionCardinality(group.selection_sid.length, instanceCount)) {
      return false;
    }
    seenTabstop.add(group.tabstop);
    if (group.tabstop !== tabstop) {
      retainedRangeCount += group.selection_sid.length;
      if (retainedRangeCount > MAX_TRACKED_SELECTION_RANGES_PER_SESSION) {
        return false;
      }
    }
  }
  return retainedRangeCount <= MAX_TRACKED_SELECTION_RANGES_PER_SESSION;
}

/** Returns a unique previously observed tabstop group, failing safely on ambiguity. */
export function matchingTabstopForSelections(
  selection_sid: readonly OffsetRange[],
  group_gid: readonly TabstopSelectionGroup[],
): number | undefined {
  let matchedTabstop: number | undefined;
  for (const group of group_gid) {
    if (!selectionRangesMatchGroup(selection_sid, group.selection_sid)) {
      continue;
    }
    if (matchedTabstop !== undefined && matchedTabstop !== group.tabstop) {
      return undefined;
    }
    matchedTabstop = group.tabstop;
  }
  return matchedTabstop;
}

/** Confirms ownership against the remembered current group, preserving managed provenance. */
export function selectionsOwnTabstop(
  selection_sid: readonly OffsetRange[],
  currentTabstop: number,
  group_gid: readonly TabstopSelectionGroup[],
): boolean {
  let currentGroup: TabstopSelectionGroup | undefined;
  for (const group of group_gid) {
    if (group.tabstop !== currentTabstop) {
      continue;
    }
    if (currentGroup !== undefined) {
      return false;
    }
    currentGroup = group;
  }
  return currentGroup !== undefined
    && selectionRangesMatchGroup(selection_sid, currentGroup.selection_sid);
}

/** Resolves only previously observed groups; unmatched or ambiguous selections are terminal. */
export function resolveSelectionTransition(
  selection_sid: readonly OffsetRange[],
  group_gid: readonly TabstopSelectionGroup[],
): SelectionTransition {
  const tabstop = matchingTabstopForSelections(selection_sid, group_gid);
  return tabstop === undefined ? { kind: "terminal" } : { kind: "observed", tabstop };
}

/** Resolves whether a best-effort selection event may evaluate the exited group. */
export function resolveFallbackSelectionTransition(
  selection_sid: readonly OffsetRange[],
  currentTabstop: number,
  currentGroup_sid: readonly OffsetRange[],
  group_gid: readonly TabstopSelectionGroup[],
  instanceCount: number,
  lastPositiveGroup: boolean,
  terminal_rid: readonly OffsetRange[],
): FallbackSelectionTransition {
  const attribution = classifyCurrentGroupSelectionAttribution(selection_sid, currentGroup_sid);
  if (attribution === "unsafe" || attribution === "mixed") {
    return { kind: "discard" };
  }
  if (attribution === "all") {
    if (selectionsOwnTabstop(selection_sid, currentTabstop, group_gid)) {
      return { kind: "stay" };
    }
    return lastPositiveGroup
      && selectionsMatchPredictedTerminalEndpoints(selection_sid, terminal_rid)
      ? { kind: "terminal" }
      : { kind: "discard" };
  }

  if (!isValidSelectionCardinality(selection_sid.length, instanceCount)) {
    return lastPositiveGroup
      && selectionsMatchPredictedTerminalEndpoints(selection_sid, terminal_rid)
      ? { kind: "terminal" }
      : { kind: "discard" };
  }
  return resolveSelectionTransition(selection_sid, group_gid);
}

/** Runs tasks serially per key and removes the queue tail once it becomes idle. */
export function enqueueSerialTask<TKey>(
  taskByKey: Map<TKey, Promise<void>>,
  key: TKey,
  task: () => Promise<void>,
): Promise<void> {
  const previousTask = taskByKey.get(key) ?? Promise.resolve();
  const entry = { task: Promise.resolve() };
  entry.task = previousTask
    .catch(() => undefined)
    .then(task)
    .finally(() => {
      if (taskByKey.get(key) === entry.task) {
        taskByKey.delete(key);
      }
    });
  taskByKey.set(key, entry.task);
  return entry.task;
}

/**
 * Ends one queue identity without rearming an invalidated identity. A completed
 * identity retains only tickets that were admitted while it was active.
 */
export function finishSerialTaskIdentity(
  identity: SerialTaskIdentity,
  reason: SerialTaskIdentityEndReason,
): void {
  if (identity.lifecycle === "invalidated" || identity.lifecycle === "retired") {
    return;
  }
  identity.lifecycle = reason;
  if (identity.acceptedTaskCount === 0) {
    identity.lifecycle = "retired";
  }
}

/**
 * Admits work only while an identity is active, then lets that accepted ticket
 * finish after normal completion. The identity retires when its tickets drain.
 */
export function enqueueSerialTaskForIdentity<TKey, TIdentity extends SerialTaskIdentity>(
  taskByKey: Map<TKey, Promise<void>>,
  key: TKey,
  identity: TIdentity,
  task: () => Promise<void>,
  onIdentityRetired: (identity: TIdentity) => void = () => undefined,
): Promise<void> {
  if (identity.lifecycle !== "active") {
    return Promise.resolve();
  }
  identity.acceptedTaskCount += 1;
  return enqueueSerialTask(taskByKey, key, async () => {
    try {
      if (identity.lifecycle !== "invalidated" && identity.lifecycle !== "retired") {
        await task();
      }
    } finally {
      identity.acceptedTaskCount -= 1;
      if (identity.acceptedTaskCount === 0 && identity.lifecycle !== "active") {
        identity.lifecycle = "retired";
        onIdentityRetired(identity);
      }
    }
  });
}

/** Allows only an exact predicted selection; content changes are never inferred safe. */
export function isExpectedCompletedNavigationEvent(
  event: CompletedNavigationEvent,
  expectedSelection_sid: readonly OffsetRange[] | undefined,
): boolean {
  if (event.kind === "document"
    || expectedSelection_sid === undefined
    || event.selection_sid.length !== expectedSelection_sid.length) {
    return false;
  }
  return event.selection_sid.every((selection, index) => {
    const expected = expectedSelection_sid[index];
    return expected !== undefined
      && selection.start === expected.start
      && selection.end === expected.end;
  });
}

export function pendingPadsForDriver<T extends DriverPadState>(
  pad_pid: readonly T[],
  driverTabstop: number,
): readonly T[] {
  return pad_pid.filter((pad) => pad.driverTabstop === driverTabstop && pad.state === "pending");
}

/** Makes completion terminal: a settled or invalid pad can never be rearmed. */
export function finishPendingPad(
  state: TrackedPadState,
  terminalState: Exclude<TrackedPadState, "pending">,
): TrackedPadState {
  return state === "pending" ? terminalState : state;
}
