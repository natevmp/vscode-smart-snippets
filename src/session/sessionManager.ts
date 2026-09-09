import * as vscode from "vscode";

import {
  MAX_OFFSET_TRACKING_WORK,
  evaluatePad,
  isOffsetTrackingWorkWithinLimit,
  prepareContentChanges,
  rebaseOffsetWithPreparedChanges,
  rebaseProtectedRangeWithPreparedChanges,
  type ContentChange,
  type OffsetRange,
  type PadConfiguration,
  type PreparedContentChanges,
} from "../core/index.js";
import {
  canRememberTabstopSelections,
  countTrackedSessionRanges,
  enqueueSerialTaskForIdentity,
  finishPendingPad,
  finishSerialTaskIdentity,
  isExpectedCompletedNavigationEvent,
  isPadInsertionSnapshot,
  isValidSelectionCardinality,
  pendingPadsForDriver,
  rebaseTerminalEndpoints,
  resolveCompletedNavigationTransition,
  resolveFallbackSelectionTransition,
  resolveForwardSelectionTransition,
  selectionsOwnTabstop,
  type CompletedNavigationState,
  type SerialTaskIdentity,
  type TabstopSelectionGroup,
  type TrackedPadState,
} from "./helpers.js";

const JUMP_TO_NEXT_PLACEHOLDER = "jumpToNextSnippetPlaceholder";
const PAD_PENDING_CONTEXT = "smartSnippets.padPending";
const TAB_INTERCEPTION_SETTING = "smartSnippets.enableTabInterception";
const SESSION_EXPIRATION_MS = 5 * 60 * 1_000;

interface TrackedPad {
  readonly snippetName: string;
  readonly driverTabstop: number;
  readonly config: PadConfiguration;
  generated: OffsetRange;
  previousGeneratedText: string;
  state: TrackedPadState;
}

interface EditorSession {
  readonly editor: vscode.TextEditor;
  readonly document: vscode.TextDocument;
  readonly snippetName: string;
  readonly instanceCount: number;
  readonly tabstop_tid: readonly number[];
  readonly pad_pid: TrackedPad[];
  readonly selectionByTabstop: Map<number, readonly OffsetRange[]>;
  readonly advanceIdentity: AdvanceQueueIdentity;
  terminal_rid: readonly OffsetRange[];
  currentTabstopIndex: number;
  terminating: boolean;
  expirationTimer?: ReturnType<typeof setTimeout>;
}

interface EvaluatedReplacement {
  readonly pad: TrackedPad;
  readonly range: OffsetRange;
  readonly text: string;
}

interface PendingManagedEdit {
  readonly session: EditorSession;
  readonly preparedChanges: PreparedContentChanges;
  observed: boolean;
  unexpected: boolean;
}

interface AdvanceQueueIdentity extends SerialTaskIdentity {
  readonly document: vscode.TextDocument;
  documentVersion: number;
  selection_sid: readonly OffsetRange[];
  forwardingNative: boolean;
  completedNavigationState: CompletedNavigationState | undefined;
}

function documentUtf16Length(document: vscode.TextDocument): number {
  return document.offsetAt(new vscode.Position(document.lineCount, 0));
}

function selectionRanges(
  document: vscode.TextDocument,
  selection_sid: readonly vscode.Selection[],
): readonly OffsetRange[] {
  return selection_sid.map((selection) => ({
    start: document.offsetAt(selection.start),
    end: document.offsetAt(selection.end),
  }));
}

function preparedChangesEqual(
  left: PreparedContentChanges,
  right: PreparedContentChanges,
): boolean {
  if (left.change_cid.length !== right.change_cid.length) {
    return false;
  }
  return left.change_cid.every((leftChange, index) => {
    const rightChange = right.change_cid[index];
    return rightChange !== undefined
      && leftChange.rangeOffset === rightChange.rangeOffset
      && leftChange.rangeLength === rightChange.rangeLength
      && leftChange.text === rightChange.text;
  });
}

/** Owns the public-API-only state needed to evaluate Smart Snippet padding on Tab. */
export class SmartSnippetSessionManager implements vscode.Disposable {
  private readonly sessionByEditor = new Map<vscode.TextEditor, EditorSession>();
  private readonly listener_did: vscode.Disposable[] = [];
  private readonly advancingCountByEditor = new Map<vscode.TextEditor, number>();
  private readonly advanceTaskByEditor = new Map<vscode.TextEditor, Promise<void>>();
  private readonly advanceIdentityByEditor = new Map<vscode.TextEditor, AdvanceQueueIdentity>();
  private readonly advanceIdentitySetByEditor = new Map<vscode.TextEditor, Set<AdvanceQueueIdentity>>();
  private commandAvailable = false;
  private initialized = false;
  private disposed = false;
  private contextGeneration = 0;
  private contextTask: Promise<void> = Promise.resolve();
  private evaluationTask: Promise<void> = Promise.resolve();
  private pendingManagedEdit: PendingManagedEdit | undefined;
  private lastActiveEditor: vscode.TextEditor | undefined;

  public constructor(private readonly output: Pick<vscode.OutputChannel, "appendLine">) {}

  public async initialize(): Promise<void> {
    if (this.initialized || this.disposed) {
      return;
    }
    this.initialized = true;

    try {
      const command_cid = await vscode.commands.getCommands();
      if (this.disposed) {
        return;
      }
      this.commandAvailable = command_cid.includes(JUMP_TO_NEXT_PLACEHOLDER);
      if (!this.commandAvailable) {
        this.log(`VS Code command '${JUMP_TO_NEXT_PLACEHOLDER}' is unavailable; exact Tab interception is disabled.`);
      }
    } catch (error: unknown) {
      this.log(`Failed to discover VS Code snippet commands: ${String(error)}`);
    }

    if (this.disposed) {
      return;
    }
    this.lastActiveEditor = vscode.window.activeTextEditor;
    this.listener_did.push(
      vscode.workspace.onDidChangeTextDocument((event) => { this.onDocumentChanged(event); }),
      vscode.window.onDidChangeTextEditorSelection((event) => { this.onSelectionChanged(event); }),
      vscode.window.onDidChangeActiveTextEditor((editor) => { this.onActiveEditorChanged(editor); }),
      vscode.workspace.onDidCloseTextDocument((document) => { this.onDocumentClosed(document); }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration(TAB_INTERCEPTION_SETTING)) {
          void this.refreshContext();
        }
      }),
    );
    await this.refreshContext();
  }

  public captureInsertion(snapshotValue: unknown, editor: vscode.TextEditor): boolean {
    if (this.disposed) {
      this.log("Ignored a padding insertion capture after the session manager was disposed.");
      return false;
    }
    this.invalidateAdvanceIdentities(editor);
    const previousSession = this.sessionByEditor.get(editor);
    if (previousSession !== undefined) {
      this.discardSession(previousSession);
      void this.refreshContext();
    }
    if (!isPadInsertionSnapshot(snapshotValue)) {
      this.log("Ignored an invalid Smart Snippets padding insertion snapshot.");
      return false;
    }

    let snapshot: typeof snapshotValue;
    try {
      snapshot = {
        snippetName: snapshotValue.snippetName,
        sourceUri: snapshotValue.sourceUri,
        targetDocumentUri: snapshotValue.targetDocumentUri,
        targetDocumentVersion: snapshotValue.targetDocumentVersion,
        instanceCount: snapshotValue.instanceCount,
        tabstop_tid: snapshotValue.tabstop_tid.map((tabstop) => tabstop),
        pad_pid: snapshotValue.pad_pid.map((pad) => ({
          driverTabstop: pad.driverTabstop,
          fill: pad.fill,
          targetWidth: pad.targetWidth,
          ...(pad.configurationName === undefined ? {} : { configurationName: pad.configurationName }),
          generated: { start: pad.generated.start, end: pad.generated.end },
        })),
        terminal_rid: snapshotValue.terminal_rid.map((terminal) => ({
          start: terminal.start,
          end: terminal.end,
        })),
      };
    } catch {
      this.log("Ignored an invalid Smart Snippets padding insertion snapshot.");
      return false;
    }
    if (!isPadInsertionSnapshot(snapshot)) {
      this.log("Ignored an insertion snapshot that mutated while it was being captured.");
      return false;
    }

    const document = editor.document;
    const documentLength = documentUtf16Length(document);
    if (document.uri.toString(true) !== snapshot.targetDocumentUri
      || document.version !== snapshot.targetDocumentVersion
      || snapshot.pad_pid.some((pad) => pad.generated.end > documentLength)
      || snapshot.terminal_rid.some((terminal) => terminal.end > documentLength)) {
      this.log(
        `Ignored stale insertion capture for '${snapshot.snippetName}' because its target document does not exactly match.`,
      );
      return false;
    }
    if (!isValidSelectionCardinality(editor.selections.length, snapshot.instanceCount)) {
      this.log(
        `Ignored insertion capture for '${snapshot.snippetName}' because its selection cardinality is unsafe.`,
      );
      void this.refreshContext();
      return false;
    }
    const initialSelection_sid = selectionRanges(document, editor.selections);
    const advanceIdentity = this.createAdvanceIdentity(editor);
    const pad_pid = snapshot.pad_pid.map((pad): TrackedPad => ({
      snippetName: snapshot.snippetName,
      driverTabstop: pad.driverTabstop,
      config: { fill: pad.fill, targetWidth: pad.targetWidth },
      generated: { ...pad.generated },
      previousGeneratedText: "",
      state: "pending",
    }));
    const session: EditorSession = {
      editor,
      document,
      snippetName: snapshot.snippetName,
      instanceCount: snapshot.instanceCount,
      tabstop_tid: [...snapshot.tabstop_tid],
      pad_pid,
      selectionByTabstop: new Map([
        [snapshot.tabstop_tid[0]!, initialSelection_sid],
      ]),
      advanceIdentity,
      terminal_rid: snapshot.terminal_rid.map((terminal) => ({ ...terminal })),
      currentTabstopIndex: 0,
      terminating: false,
    };
    session.expirationTimer = setTimeout(() => {
      if (this.sessionByEditor.get(editor) === session) {
        this.log(`Discarded expired padding state for '${snapshot.snippetName}'.`);
        this.discardSession(session);
        void this.refreshContext();
      }
    }, SESSION_EXPIRATION_MS);
    this.sessionByEditor.set(editor, session);
    void this.refreshContext();
    return true;
  }

  public advanceToNextPlaceholder(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (editor === undefined) {
      return this.advanceToNextPlaceholderForEditor(undefined);
    }
    const sessionIdentity = this.getCurrentSession(editor);
    const advanceIdentity = sessionIdentity?.advanceIdentity ?? this.getOrCreateAdvanceIdentity(editor);
    const document = editor.document;
    return enqueueSerialTaskForIdentity(
      this.advanceTaskByEditor,
      editor,
      advanceIdentity,
      async () => {
        if (this.disposed
          || vscode.window.activeTextEditor !== editor
          || editor.document !== document
          || (advanceIdentity.lifecycle === "completed"
            && !this.advanceIdentityMatchesEditor(advanceIdentity, editor))) {
          return;
        }
        const completedAtStart = advanceIdentity.lifecycle === "completed";
        const forwardingStartVersion = document.version;
        const forwardingStartSelection_sid = selectionRanges(document, editor.selections);
        const completedNavigationState = advanceIdentity.completedNavigationState;
        await this.advanceToNextPlaceholderForEditor(editor, advanceIdentity);
        if (completedAtStart
          && advanceIdentity.lifecycle !== "invalidated"
          && advanceIdentity.lifecycle !== "retired") {
          const currentSelection_sid = selectionRanges(document, editor.selections);
          const selectionChanged = !isExpectedCompletedNavigationEvent(
            { kind: "selection", selection_sid: currentSelection_sid },
            forwardingStartSelection_sid,
          );
          const transition = completedNavigationState === undefined
            ? { kind: "unsafe" as const }
            : resolveCompletedNavigationTransition(completedNavigationState, currentSelection_sid);
          if (document.version !== forwardingStartVersion
            || (selectionChanged && transition.kind === "unsafe")
            || (!selectionChanged && completedNavigationState !== undefined)) {
            this.invalidateAdvanceIdentities(editor);
          } else if (transition.kind === "next") {
            advanceIdentity.completedNavigationState = transition.state;
          } else if (transition.kind === "terminal") {
            advanceIdentity.completedNavigationState = undefined;
          }
        }
        if (advanceIdentity.lifecycle !== "invalidated"
          && advanceIdentity.lifecycle !== "retired"
          && editor.document === document) {
          advanceIdentity.documentVersion = document.version;
          advanceIdentity.selection_sid = selectionRanges(document, editor.selections);
        }
      },
      () => { this.removeRetiredAdvanceIdentity(editor, advanceIdentity); },
    );
  }

  private async advanceToNextPlaceholderForEditor(
    editor: vscode.TextEditor | undefined,
    advanceIdentity?: AdvanceQueueIdentity,
  ): Promise<void> {
    if (this.disposed) {
      return;
    }
    let session: EditorSession | undefined;
    let pendingPad_pid: readonly TrackedPad[] = [];
    try {
      session = editor === undefined ? undefined : this.getCurrentSession(editor);
      if (session !== undefined
        && (!this.exactInterceptionEnabled() || !this.sessionOwnsCurrentSelections(session))) {
        this.log(`Discarded stale padding state for '${session.snippetName}' before forwarding Tab.`);
        this.discardSession(session);
        session = undefined;
      }
      pendingPad_pid = session === undefined ? [] : this.getPadsForCurrentTabstop(session);

      if (editor !== undefined) {
        this.incrementAdvancingCount(editor);
      }
    } catch (error: unknown) {
      this.log(`Failed to prepare Smart Snippets padding before Tab: ${String(error)}`);
      if (session !== undefined) {
        this.discardSession(session);
        session = undefined;
      }
      pendingPad_pid = [];
    }

    try {
      let forwarded = false;
      if (advanceIdentity !== undefined) {
        advanceIdentity.forwardingNative = true;
      }
      try {
        if (this.commandAvailable) {
          await vscode.commands.executeCommand(JUMP_TO_NEXT_PLACEHOLDER);
          forwarded = true;
        } else {
          this.log(`Cannot forward Tab because '${JUMP_TO_NEXT_PLACEHOLDER}' is unavailable.`);
        }
      } catch (error: unknown) {
        this.log(`Failed to forward Tab to VS Code's next snippet placeholder: ${String(error)}`);
        this.commandAvailable = false;
      }
      if (!forwarded) {
        try {
          await vscode.commands.executeCommand("tab");
        } catch (error: unknown) {
          this.log(`Failed to run the native Tab fallback: ${String(error)}`);
        }
      }
      if (advanceIdentity !== undefined) {
        advanceIdentity.forwardingNative = false;
      }

      // Move first so VS Code makes the driving placeholder inactive. Inserting at
      // the edge of an active placeholder would otherwise make native tracking
      // absorb the generated padding into that placeholder on Shift+Tab.
      if (forwarded && session !== undefined && this.sessionByEditor.get(session.editor) === session) {
        const currentTabstop = session.tabstop_tid[session.currentTabstopIndex];
        const nextTabstop = session.tabstop_tid[session.currentTabstopIndex + 1];
        const currentGroup_sid = currentTabstop === undefined
          ? undefined
          : session.selectionByTabstop.get(currentTabstop);
        const currentSelection_sid = selectionRanges(session.document, session.editor.selections);
        const selectionCardinalityValid = isValidSelectionCardinality(
          currentSelection_sid.length,
          session.instanceCount,
        );
        if (currentGroup_sid === undefined
          || !isValidSelectionCardinality(currentGroup_sid.length, session.instanceCount)
          || (nextTabstop !== undefined
            && !selectionCardinalityValid)) {
          this.log(`Discarded padding state for '${session.snippetName}' after an unsafe native selection transition.`);
          this.discardSession(session);
          session = undefined;
        } else {
          const expectedNextGroup_sid = nextTabstop === undefined
            ? undefined
            : session.selectionByTabstop.get(nextTabstop);
          const transition = resolveForwardSelectionTransition(
            currentSelection_sid,
            currentGroup_sid,
            expectedNextGroup_sid,
            nextTabstop === undefined,
            session.terminal_rid,
            selectionCardinalityValid,
          );
          if (transition.kind === "unsafe") {
            this.log(
              `Discarded padding state for '${session.snippetName}' because VS Code did not produce a complete observable forward transition.`,
            );
            this.discardSession(session);
            session = undefined;
          } else if (transition.kind === "terminal") {
            session.currentTabstopIndex = session.tabstop_tid.length;
            session.terminating = true;
            void this.refreshContext();
          } else {
            session.currentTabstopIndex += 1;
            if (!this.rememberCurrentTabstopSelections(session, currentSelection_sid)) {
              session = undefined;
            }
          }
        }

        if (session !== undefined && pendingPad_pid.length > 0) {
          try {
            await this.queueEvaluation(session, pendingPad_pid);
          } catch (error: unknown) {
            this.log(`Failed to evaluate padding while advancing from the tab stop: ${String(error)}`);
          }
        }
        if (session !== undefined
          && session.terminating
          && this.sessionByEditor.get(session.editor) === session) {
          this.discardSession(session);
        }
      }
    } finally {
      if (advanceIdentity !== undefined) {
        advanceIdentity.forwardingNative = false;
      }
      if (editor !== undefined) {
        this.decrementAdvancingCount(editor);
      }
      void this.refreshContext();
    }
  }

  public refreshContext(): Promise<void> {
    const generation = ++this.contextGeneration;
    const pending = !this.disposed && this.exactInterceptionEnabled() && this.activeEditorHasPendingPads();
    this.contextTask = this.contextTask
      .catch((error: unknown) => {
        this.log(`Previous pending-context update failed: ${String(error)}`);
      })
      .then(async () => {
        if (generation !== this.contextGeneration) {
          return;
        }
        try {
          await vscode.commands.executeCommand("setContext", PAD_PENDING_CONTEXT, pending);
        } catch (error: unknown) {
          this.log(`Failed to update '${PAD_PENDING_CONTEXT}': ${String(error)}`);
        }
      });
    return this.contextTask;
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const session of this.sessionByEditor.values()) {
      if (session.expirationTimer !== undefined) {
        clearTimeout(session.expirationTimer);
      }
    }
    this.sessionByEditor.clear();
    this.advancingCountByEditor.clear();
    this.advanceTaskByEditor.clear();
    for (const identitySet of this.advanceIdentitySetByEditor.values()) {
      for (const identity of identitySet) {
        finishSerialTaskIdentity(identity, "invalidated");
      }
    }
    this.advanceIdentityByEditor.clear();
    this.advanceIdentitySetByEditor.clear();
    this.pendingManagedEdit = undefined;
    for (const listener of this.listener_did.splice(0)) {
      listener.dispose();
    }
    void this.refreshContext();
  }

  private exactInterceptionEnabled(): boolean {
    return this.commandAvailable
      && vscode.workspace.getConfiguration("smartSnippets").get<boolean>("enableTabInterception", true) === true;
  }

  private incrementAdvancingCount(editor: vscode.TextEditor): void {
    this.advancingCountByEditor.set(editor, (this.advancingCountByEditor.get(editor) ?? 0) + 1);
  }

  private decrementAdvancingCount(editor: vscode.TextEditor): void {
    const remaining = (this.advancingCountByEditor.get(editor) ?? 1) - 1;
    if (remaining <= 0) {
      this.advancingCountByEditor.delete(editor);
    } else {
      this.advancingCountByEditor.set(editor, remaining);
    }
  }

  private createAdvanceIdentity(editor: vscode.TextEditor): AdvanceQueueIdentity {
    const identity: AdvanceQueueIdentity = {
      lifecycle: "active",
      acceptedTaskCount: 0,
      document: editor.document,
      documentVersion: editor.document.version,
      selection_sid: selectionRanges(editor.document, editor.selections),
      forwardingNative: false,
      completedNavigationState: undefined,
    };
    this.advanceIdentityByEditor.set(editor, identity);
    const identitySet = this.advanceIdentitySetByEditor.get(editor) ?? new Set();
    identitySet.add(identity);
    this.advanceIdentitySetByEditor.set(editor, identitySet);
    return identity;
  }

  private getOrCreateAdvanceIdentity(editor: vscode.TextEditor): AdvanceQueueIdentity {
    const currentIdentity = this.advanceIdentityByEditor.get(editor);
    return currentIdentity === undefined || currentIdentity.lifecycle !== "active"
      ? this.createAdvanceIdentity(editor)
      : currentIdentity;
  }

  private removeRetiredAdvanceIdentity(
    editor: vscode.TextEditor,
    identity: AdvanceQueueIdentity,
  ): void {
    if (identity.lifecycle !== "retired") {
      return;
    }
    const identitySet = this.advanceIdentitySetByEditor.get(editor);
    identitySet?.delete(identity);
    if (identitySet?.size === 0) {
      this.advanceIdentitySetByEditor.delete(editor);
    }
    if (this.advanceIdentityByEditor.get(editor) === identity) {
      this.advanceIdentityByEditor.delete(editor);
    }
  }

  private finishAdvanceIdentity(
    editor: vscode.TextEditor,
    identity: AdvanceQueueIdentity,
    reason: "completed" | "invalidated",
  ): void {
    finishSerialTaskIdentity(identity, reason);
    this.removeRetiredAdvanceIdentity(editor, identity);
  }

  private invalidateAdvanceIdentities(editor: vscode.TextEditor): void {
    for (const identity of this.advanceIdentitySetByEditor.get(editor) ?? []) {
      finishSerialTaskIdentity(identity, "invalidated");
      this.removeRetiredAdvanceIdentity(editor, identity);
    }
    this.advanceIdentityByEditor.delete(editor);
  }

  private advanceIdentityMatchesEditor(
    identity: AdvanceQueueIdentity,
    editor: vscode.TextEditor,
  ): boolean {
    if (identity.document !== editor.document
      || identity.documentVersion !== editor.document.version) {
      return false;
    }
    const selection_sid = selectionRanges(editor.document, editor.selections);
    return selection_sid.length === identity.selection_sid.length
      && selection_sid.every((selection, index) => {
        const expected = identity.selection_sid[index];
        return expected !== undefined
          && selection.start === expected.start
          && selection.end === expected.end;
      });
  }

  private forwardingAdvanceIdentity(editor: vscode.TextEditor): AdvanceQueueIdentity | undefined {
    for (const identity of this.advanceIdentitySetByEditor.get(editor) ?? []) {
      if (identity.forwardingNative) {
        return identity;
      }
    }
    return undefined;
  }

  private activeEditorHasPendingPads(): boolean {
    const editor = vscode.window.activeTextEditor;
    if (editor === undefined) {
      return false;
    }
    const session = this.getCurrentSession(editor);
    return session !== undefined
      && !session.terminating
      && session.pad_pid.some((pad) => pad.state === "pending")
      && this.sessionOwnsCurrentSelections(session);
  }

  private getCurrentSession(editor: vscode.TextEditor): EditorSession | undefined {
    const session = this.sessionByEditor.get(editor);
    return session?.document === editor.document ? session : undefined;
  }

  private selectionGroups(session: EditorSession): readonly TabstopSelectionGroup[] {
    return [...session.selectionByTabstop].map(([tabstop, selection_sid]) => ({
      tabstop,
      selection_sid,
    }));
  }

  private sessionOwnsCurrentSelections(session: EditorSession): boolean {
    if (session.terminating || session.document !== session.editor.document) {
      return false;
    }
    const currentTabstop = session.tabstop_tid[session.currentTabstopIndex];
    if (currentTabstop === undefined) {
      return false;
    }
    try {
      const currentSelection_sid = selectionRanges(session.document, session.editor.selections);
      return isValidSelectionCardinality(currentSelection_sid.length, session.instanceCount)
        && selectionsOwnTabstop(currentSelection_sid, currentTabstop, this.selectionGroups(session));
    } catch {
      return false;
    }
  }

  private getPadsForCurrentTabstop(session: EditorSession): readonly TrackedPad[] {
    if (session.document !== session.editor.document) {
      return [];
    }
    const currentTabstop = session.tabstop_tid[session.currentTabstopIndex];
    return currentTabstop === undefined
      ? []
      : pendingPadsForDriver(session.pad_pid, currentTabstop);
  }

  private onDocumentChanged(event: vscode.TextDocumentChangeEvent): void {
    const change_cid: readonly ContentChange[] = event.contentChanges.map((change) => ({
      rangeOffset: change.rangeOffset,
      rangeLength: change.rangeLength,
      text: change.text,
    }));
    const managedEdit = this.pendingManagedEdit;
    const sessionForDocument = [...this.sessionByEditor.values()].some(
      (session) => session.document === event.document,
    );
    if (!sessionForDocument
      && (managedEdit === undefined || managedEdit.session.document !== event.document)) {
      for (const editor of this.advanceIdentitySetByEditor.keys()) {
        if (editor.document === event.document) {
          this.invalidateAdvanceIdentities(editor);
        }
      }
    }
    let preparedChanges: PreparedContentChanges;
    try {
      preparedChanges = prepareContentChanges(change_cid);
    } catch (error: unknown) {
      if (managedEdit !== undefined && managedEdit.session.document === event.document) {
        managedEdit.unexpected = true;
      }
      for (const session of [...this.sessionByEditor.values()]) {
        if (session.document === event.document) {
          this.log(`Discarded padding state after an unsafe document change: ${String(error)}`);
          this.discardSession(session);
        }
      }
      void this.refreshContext();
      return;
    }
    const expectedManagedChange = managedEdit !== undefined
      && managedEdit.session.document === event.document
      && preparedChangesEqual(preparedChanges, managedEdit.preparedChanges);
    if (managedEdit !== undefined && managedEdit.session.document === event.document) {
      if (expectedManagedChange && !managedEdit.observed) {
        managedEdit.observed = true;
      } else {
        managedEdit.unexpected = true;
        this.log("A concurrent document change invalidated the complete padding session.");
        this.discardSession(managedEdit.session);
      }
    }

    for (const session of [...this.sessionByEditor.values()]) {
      if (session.document !== event.document
        || managedEdit?.session === session) {
        continue;
      }
      this.rebaseForExternalChanges(session, preparedChanges);
    }
    void this.refreshContext();
  }

  private rebaseForExternalChanges(
    session: EditorSession,
    preparedChanges: PreparedContentChanges,
  ): void {
    const trackedRangeCount = countTrackedSessionRanges(
      session.pad_pid.length,
      this.selectionGroups(session),
      session.terminal_rid,
    );
    if (trackedRangeCount === undefined
      || !isOffsetTrackingWorkWithinLimit(trackedRangeCount, preparedChanges)) {
      this.log(`Discarded padding state for '${session.snippetName}' because offset tracking work is too large.`);
      this.discardSession(session);
      return;
    }
    const documentLength = documentUtf16Length(session.document);
    for (const pad of session.pad_pid) {
      if (pad.state === "invalid") {
        continue;
      }
      const rebasedGenerated = rebaseProtectedRangeWithPreparedChanges(pad.generated, preparedChanges);
      if (!rebasedGenerated.valid) {
        this.invalidatePad(pad, rebasedGenerated.message);
        continue;
      }
      if (rebasedGenerated.range.end > documentLength) {
        this.invalidatePad(pad, "The rebased generated padding range is outside the document.");
        continue;
      }
      pad.generated = rebasedGenerated.range;
    }

    try {
      this.rebaseRememberedSelections(session, preparedChanges);
      if (!this.rebaseTerminalEndpoints(session, preparedChanges, documentLength)) {
        throw new RangeError("A predicted terminal endpoint exceeded the safe document range.");
      }
    } catch (error: unknown) {
      this.log(`Discarded ambiguous tracked endpoints for '${session.snippetName}': ${String(error)}`);
      this.discardSession(session);
      return;
    }
    this.discardSettledSession(session);
  }

  private onSelectionChanged(event: vscode.TextEditorSelectionChangeEvent): void {
    const session = this.getCurrentSession(event.textEditor);
    if (session === undefined) {
      const forwardingIdentity = this.forwardingAdvanceIdentity(event.textEditor);
      const expectedCompletedSelection = forwardingIdentity?.lifecycle === "completed"
        && forwardingIdentity.completedNavigationState !== undefined
        && resolveCompletedNavigationTransition(
          forwardingIdentity.completedNavigationState,
          selectionRanges(event.textEditor.document, event.selections),
        ).kind !== "unsafe";
      if (forwardingIdentity === undefined
        || (forwardingIdentity.lifecycle === "completed" && !expectedCompletedSelection)) {
        this.invalidateAdvanceIdentities(event.textEditor);
      }
      return;
    }
    if (session.terminating) {
      return;
    }
    if (this.advancingCountByEditor.has(event.textEditor)) {
      return;
    }
    const currentSelection_sid = selectionRanges(session.document, event.selections);
    const currentTabstop = session.tabstop_tid[session.currentTabstopIndex];
    const currentGroup_sid = currentTabstop === undefined
      ? undefined
      : session.selectionByTabstop.get(currentTabstop);
    if (currentTabstop === undefined
      || currentGroup_sid === undefined) {
      this.log(`Discarded padding state for '${session.snippetName}' after its current selection group became unavailable.`);
      this.discardSession(session);
      void this.refreshContext();
      return;
    }

    const group_gid = this.selectionGroups(session);
    const transition = resolveFallbackSelectionTransition(
      currentSelection_sid,
      currentTabstop,
      currentGroup_sid,
      group_gid,
      session.instanceCount,
      session.currentTabstopIndex === session.tabstop_tid.length - 1,
      session.terminal_rid,
    );
    if (transition.kind === "stay") {
      return;
    }
    if (transition.kind === "discard") {
      this.log(`Discarded padding state for '${session.snippetName}' after an incomplete or unsafe selection transition.`);
      this.discardSession(session);
      void this.refreshContext();
      return;
    }
    if (transition.kind === "observed") {
      const matchedIndex = session.tabstop_tid.indexOf(transition.tabstop);
      if (matchedIndex < 0) {
        this.log(`Discarded padding state for '${session.snippetName}' after an unknown selection transition.`);
        this.discardSession(session);
        void this.refreshContext();
        return;
      }
      session.currentTabstopIndex = matchedIndex;
    } else {
      session.terminating = true;
      void this.refreshContext();
    }

    const exitedPad_pid = pendingPadsForDriver(session.pad_pid, currentTabstop);
    if (exitedPad_pid.length > 0) {
      void this.queueEvaluation(session, exitedPad_pid)
        .catch((error: unknown) => {
          this.log(`Best-effort padding evaluation failed: ${String(error)}`);
        })
        .finally(() => {
          if (session.terminating && this.sessionByEditor.get(session.editor) === session) {
            this.discardSession(session);
            void this.refreshContext();
          }
        });
    } else if (session.terminating) {
      this.discardSession(session);
    }
    void this.refreshContext();
  }

  private onDocumentClosed(document: vscode.TextDocument): void {
    for (const session of this.sessionByEditor.values()) {
      if (session.document === document) {
        this.discardSession(session);
      }
    }
    for (const [editor, identitySet] of this.advanceIdentitySetByEditor) {
      if (editor.document === document) {
        for (const identity of identitySet) {
          finishSerialTaskIdentity(identity, "invalidated");
        }
        this.advanceIdentitySetByEditor.delete(editor);
        this.advanceIdentityByEditor.delete(editor);
      }
    }
    void this.refreshContext();
  }

  private onActiveEditorChanged(editor: vscode.TextEditor | undefined): void {
    for (const session of this.sessionByEditor.values()) {
      if (session.editor !== editor) {
        this.discardSession(session);
      }
    }
    if (this.lastActiveEditor !== undefined && this.lastActiveEditor !== editor) {
      this.invalidateAdvanceIdentities(this.lastActiveEditor);
    }
    this.lastActiveEditor = editor;
    void this.refreshContext();
  }

  private queueEvaluation(session: EditorSession, pad_pid: readonly TrackedPad[]): Promise<void> {
    this.evaluationTask = this.evaluationTask
      .catch((error: unknown) => {
        this.log(`Previous padding evaluation failed: ${String(error)}`);
      })
      .then(async () => {
        if (this.disposed || this.sessionByEditor.get(session.editor) !== session) {
          return;
        }
        await this.evaluatePads(session, pad_pid);
      });
    return this.evaluationTask;
  }

  private rememberCurrentTabstopSelections(
    session: EditorSession,
    selection_sid: readonly OffsetRange[] = selectionRanges(session.document, session.editor.selections),
  ): boolean {
    const currentTabstop = session.tabstop_tid[session.currentTabstopIndex];
    if (currentTabstop === undefined) {
      return false;
    }
    const group_gid = this.selectionGroups(session);
    if (!canRememberTabstopSelections(
      session.instanceCount,
      group_gid,
      currentTabstop,
      selection_sid,
    )) {
      this.log(`Discarded padding state for '${session.snippetName}' because tracked selections are unsafe.`);
      this.discardSession(session);
      void this.refreshContext();
      return false;
    }
    session.selectionByTabstop.set(currentTabstop, selection_sid);
    return true;
  }

  private rebaseRememberedSelections(
    session: EditorSession,
    preparedChanges: PreparedContentChanges,
  ): void {
    for (const [tabstop, selection_sid] of session.selectionByTabstop) {
      session.selectionByTabstop.set(tabstop, selection_sid.map((selection) => {
        const start = rebaseOffsetWithPreparedChanges(selection.start, preparedChanges, "left");
        const end = rebaseOffsetWithPreparedChanges(selection.end, preparedChanges, "right");
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start) {
          throw new RangeError("A remembered tabstop selection exceeded the safe offset range.");
        }
        return { start, end };
      }));
    }
  }

  private async evaluatePads(session: EditorSession, requestedPad_pid: readonly TrackedPad[]): Promise<void> {
    const pendingPadSet = new Set(
      requestedPad_pid.filter((pad) => pad.state === "pending"),
    );
    const currentTrackedRangeCount = countTrackedSessionRanges(
      session.pad_pid.length,
      this.selectionGroups(session),
      session.terminal_rid,
    );
    if (currentTrackedRangeCount === undefined
      || (pendingPadSet.size > 0
        && currentTrackedRangeCount > Math.floor(MAX_OFFSET_TRACKING_WORK / pendingPadSet.size))) {
      this.log(`Discarded padding state for '${session.snippetName}' because requested tracking work is too large.`);
      this.discardSession(session);
      void this.refreshContext();
      return;
    }

    const document = session.document;
    const documentLength = documentUtf16Length(document);
    const replacement_rid: EvaluatedReplacement[] = [];

    const padByLine = new Map<number, TrackedPad[]>();
    for (const pad of session.pad_pid) {
      if (pad.state === "invalid"
        || pad.generated.start < 0
        || pad.generated.end < pad.generated.start
        || pad.generated.end > documentLength) {
        continue;
      }
      const start = document.positionAt(pad.generated.start);
      const end = document.positionAt(pad.generated.end);
      if (start.line !== end.line) {
        continue;
      }
      const pad_pid = padByLine.get(start.line) ?? [];
      pad_pid.push(pad);
      padByLine.set(start.line, pad_pid);
    }
    for (const pad_pid of padByLine.values()) {
      if (pad_pid.length > 1) {
        for (const pad of pad_pid) {
          this.invalidatePad(pad, "Multiple generated pads on one line are not supported.");
        }
      }
    }

    for (const pad of pendingPadSet) {
      if (pad.state !== "pending") {
        continue;
      }
      if (pad.generated.start < 0
        || pad.generated.end < pad.generated.start
        || pad.generated.end > documentLength) {
        this.invalidatePad(pad, "The generated padding range is outside the document.");
        continue;
      }
      const start = document.positionAt(pad.generated.start);
      const end = document.positionAt(pad.generated.end);
      if (start.line !== end.line) {
        this.invalidatePad(pad, "Generated padding must remain on one line.");
        continue;
      }

      const lineText = document.lineAt(start.line).text;
      const result = evaluatePad({
        lineText,
        generatedStart: start.character,
        generatedEnd: end.character,
        previousGeneratedText: pad.previousGeneratedText,
        config: pad.config,
      });
      if (!result.ok) {
        this.invalidatePad(pad, result.message);
        continue;
      }
      replacement_rid.push({ pad, range: { ...pad.generated }, text: result.replacement });
    }

    const validReplacement_rid = replacement_rid.filter((replacement) => replacement.pad.state === "pending");
    const changedReplacement_rid = validReplacement_rid.filter(
      (replacement) => replacement.text !== replacement.pad.previousGeneratedText,
    );
    for (const replacement of validReplacement_rid) {
      if (replacement.text === replacement.pad.previousGeneratedText) {
        replacement.pad.state = finishPendingPad(replacement.pad.state, "settled");
      }
    }
    if (changedReplacement_rid.length === 0) {
      this.discardSettledSession(session);
      void this.refreshContext();
      return;
    }

    const change_cid: readonly ContentChange[] = changedReplacement_rid.map((replacement) => ({
      rangeOffset: replacement.range.start,
      rangeLength: replacement.range.end - replacement.range.start,
      text: replacement.text,
    }));
    let preparedChanges: PreparedContentChanges;
    try {
      preparedChanges = prepareContentChanges(change_cid);
    } catch (error: unknown) {
      this.log(`Discarded padding state because its generated edit was unsafe: ${String(error)}`);
      this.discardSession(session);
      void this.refreshContext();
      return;
    }
    const trackedRangeCount = countTrackedSessionRanges(
      session.pad_pid.length,
      this.selectionGroups(session),
      session.terminal_rid,
    );
    if (trackedRangeCount === undefined
      || !isOffsetTrackingWorkWithinLimit(trackedRangeCount, preparedChanges)) {
      this.log(`Discarded padding state for '${session.snippetName}' because generated tracking work is too large.`);
      this.discardSession(session);
      void this.refreshContext();
      return;
    }
    const managedEdit: PendingManagedEdit = {
      session,
      preparedChanges,
      observed: false,
      unexpected: false,
    };
    this.pendingManagedEdit = managedEdit;

    let applied = false;
    let editError: unknown;
    this.incrementAdvancingCount(session.editor);
    try {
      applied = await session.editor.edit((builder) => {
        for (const replacement of changedReplacement_rid) {
          builder.replace(
            new vscode.Range(
              document.positionAt(replacement.range.start),
              document.positionAt(replacement.range.end),
            ),
            replacement.text,
          );
        }
      }, { undoStopBefore: false, undoStopAfter: false });
    } catch (error: unknown) {
      editError = error;
    } finally {
      if (this.pendingManagedEdit === managedEdit) {
        this.pendingManagedEdit = undefined;
      }
      this.decrementAdvancingCount(session.editor);
    }

    if (this.disposed || this.sessionByEditor.get(session.editor) !== session) {
      return;
    }
    if (!applied || !managedEdit.observed || managedEdit.unexpected) {
      this.log(editError === undefined
        ? (!applied
          ? "VS Code rejected the Smart Snippets padding edit."
          : "The Smart Snippets padding edit was not observed exactly once without concurrent changes.")
        : `VS Code failed to apply the Smart Snippets padding edit: ${String(editError)}`);
      this.discardSession(session);
    } else {
      this.applyManagedChanges(session, changedReplacement_rid, preparedChanges);
    }
    this.discardSettledSession(session);
    void this.refreshContext();
  }

  private applyManagedChanges(
    session: EditorSession,
    replacement_rid: readonly EvaluatedReplacement[],
    preparedChanges: PreparedContentChanges,
  ): void {
    const replacementByPad = new Map(replacement_rid.map((replacement) => [replacement.pad, replacement]));
    const documentLength = documentUtf16Length(session.document);
    for (const pad of session.pad_pid) {
      if (pad.state === "invalid") {
        continue;
      }
      const ownReplacement = replacementByPad.get(pad);
      try {
        if (ownReplacement !== undefined) {
          const generatedStart = rebaseOffsetWithPreparedChanges(
            ownReplacement.range.start,
            preparedChanges,
            "left",
          );
          const generatedEnd = generatedStart + ownReplacement.text.length;
          if (!Number.isSafeInteger(generatedStart)
            || !Number.isSafeInteger(generatedEnd)
            || generatedEnd > documentLength) {
            this.invalidatePad(pad, "The generated padding edit exceeded the safe document range.");
            continue;
          }
          pad.generated = {
            start: generatedStart,
            end: generatedEnd,
          };
          pad.previousGeneratedText = ownReplacement.text;
          pad.state = finishPendingPad(pad.state, "settled");
        } else {
          const generated = rebaseProtectedRangeWithPreparedChanges(pad.generated, preparedChanges);
          if (!generated.valid) {
            this.invalidatePad(pad, generated.message);
            continue;
          }
          if (generated.range.end > documentLength) {
            this.invalidatePad(pad, "The rebased generated padding range is outside the document.");
            continue;
          }
          pad.generated = generated.range;
        }
      } catch (error: unknown) {
        this.invalidatePad(pad, `Could not track the generated edit: ${String(error)}`);
      }
    }
    try {
      this.rebaseRememberedSelections(session, preparedChanges);
      if (!this.rebaseTerminalEndpoints(session, preparedChanges, documentLength)) {
        throw new RangeError("A predicted terminal endpoint exceeded the safe document range.");
      }
    } catch (error: unknown) {
      this.log(`Discarded ambiguous tracked endpoints for '${session.snippetName}': ${String(error)}`);
      this.discardSession(session);
    }
  }

  private rebaseTerminalEndpoints(
    session: EditorSession,
    preparedChanges: PreparedContentChanges,
    documentLength: number,
  ): boolean {
    const terminal_rid = rebaseTerminalEndpoints(
      session.terminal_rid,
      preparedChanges,
      documentLength,
    );
    if (terminal_rid === undefined) {
      return false;
    }
    session.terminal_rid = terminal_rid;
    return true;
  }

  private invalidatePad(pad: TrackedPad, reason: string): void {
    if (pad.state === "invalid") {
      return;
    }
    pad.state = "invalid";
    this.log(`Invalidated padding for '${pad.snippetName}': ${reason}`);
  }

  private discardSettledSession(session: EditorSession): void {
    if (session.pad_pid.every((pad) => pad.state !== "pending")) {
      this.discardSession(
        session,
        session.pad_pid.every((pad) => pad.state === "settled") ? "completed" : "invalidated",
      );
    }
  }

  private discardSession(
    session: EditorSession,
    reason: "completed" | "invalidated" = "invalidated",
  ): void {
    if (reason === "completed") {
      const currentTabstop = session.tabstop_tid[session.currentTabstopIndex];
      const currentGroup_sid = currentTabstop === undefined
        ? undefined
        : session.selectionByTabstop.get(currentTabstop);
      session.advanceIdentity.completedNavigationState = currentGroup_sid === undefined
        ? undefined
        : {
            instanceCount: session.instanceCount,
            currentGroup_sid: currentGroup_sid.map((selection) => ({ ...selection })),
            remainingGroup_gid: session.tabstop_tid
              .slice(session.currentTabstopIndex + 1)
              .map((tabstop) => ({
                tabstop,
                selection_sid: session.selectionByTabstop.get(tabstop)
                  ?.map((selection) => ({ ...selection })),
              })),
            nextGroupIndex: 0,
            terminal_rid: session.terminal_rid.map((terminal) => ({ ...terminal })),
          };
    }
    this.finishAdvanceIdentity(session.editor, session.advanceIdentity, reason);
    if (session.expirationTimer !== undefined) {
      clearTimeout(session.expirationTimer);
      delete session.expirationTimer;
    }
    if (this.sessionByEditor.get(session.editor) === session) {
      this.sessionByEditor.delete(session.editor);
    }
  }

  private log(message: string): void {
    try {
      this.output.appendLine(`[session] ${message}`);
    } catch {
      // Logging must not interfere with forwarding Tab.
    }
  }
}
