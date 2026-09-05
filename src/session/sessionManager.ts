import * as vscode from "vscode";

import {
  evaluatePad,
  rebaseOffset,
  rebaseProtectedRange,
  type ContentChange,
  type OffsetRange,
  type PadConfiguration,
} from "../core/index.js";
import {
  getDriverSelectionTransitions,
  isPadInsertionSnapshot,
  matchSelectionRangesToDriverRanges,
  type PadInsertionSnapshotInput,
} from "./helpers.js";

const JUMP_TO_NEXT_PLACEHOLDER = "jumpToNextSnippetPlaceholder";
const PAD_PENDING_CONTEXT = "smartSnippets.padPending";
const TAB_INTERCEPTION_SETTING = "smartSnippets.enableTabInterception";
const SESSION_EXPIRATION_MS = 5 * 60 * 1_000;

interface TrackedPad {
  readonly snapshot: PadInsertionSnapshotInput;
  readonly config: PadConfiguration;
  driver: OffsetRange;
  generated: OffsetRange;
  previousGeneratedText: string;
  valid: boolean;
  needsEvaluation: boolean;
}

interface EditorSession {
  readonly editor: vscode.TextEditor;
  readonly document: vscode.TextDocument;
  readonly pad_pid: TrackedPad[];
  lastSelection_sid: readonly OffsetRange[];
  expirationTimer?: ReturnType<typeof setTimeout>;
}

interface EvaluatedReplacement {
  readonly pad: TrackedPad;
  readonly range: OffsetRange;
  readonly text: string;
}

interface PendingManagedEdit {
  readonly session: EditorSession;
  readonly change_cid: readonly ContentChange[];
  observed: boolean;
  unexpected: boolean;
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

function changesEqual(
  left_cid: readonly ContentChange[],
  right_cid: readonly ContentChange[],
): boolean {
  if (left_cid.length !== right_cid.length) {
    return false;
  }
  const order = (left: ContentChange, right: ContentChange): number => left.rangeOffset - right.rangeOffset
    || left.rangeLength - right.rangeLength
    || left.text.localeCompare(right.text);
  const orderedLeft_cid = [...left_cid].sort(order);
  const orderedRight_cid = [...right_cid].sort(order);
  return orderedLeft_cid.every((left, index) => {
    const right = orderedRight_cid[index];
    return right !== undefined
      && left.rangeOffset === right.rangeOffset
      && left.rangeLength === right.rangeLength
      && left.text === right.text;
  });
}

function changeTouchesRange(change: ContentChange, range: OffsetRange): boolean {
  if (change.rangeLength === 0) {
    return change.rangeOffset >= range.start && change.rangeOffset <= range.end;
  }
  const changeEnd = change.rangeOffset + change.rangeLength;
  if (range.start === range.end) {
    return change.rangeOffset <= range.start && changeEnd >= range.end;
  }
  return change.rangeOffset < range.end && changeEnd > range.start;
}

/** Owns the public-API-only state needed to evaluate Smart Snippet padding on Tab. */
export class SmartSnippetSessionManager implements vscode.Disposable {
  private readonly sessionByEditor = new Map<vscode.TextEditor, EditorSession>();
  private readonly listener_did: vscode.Disposable[] = [];
  private readonly advancingCountByEditor = new Map<vscode.TextEditor, number>();
  private commandAvailable = false;
  private initialized = false;
  private disposed = false;
  private contextGeneration = 0;
  private contextTask: Promise<void> = Promise.resolve();
  private evaluationTask: Promise<void> = Promise.resolve();
  private pendingManagedEdit: PendingManagedEdit | undefined;

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
    if (!isPadInsertionSnapshot(snapshotValue)) {
      this.log("Ignored an invalid Smart Snippets padding insertion snapshot.");
      return false;
    }

    const document = editor.document;
    if (document.uri.toString(true) !== snapshotValue.targetDocumentUri
      || document.version !== snapshotValue.targetDocumentVersion + 1) {
      this.log(
        `Ignored stale insertion capture for '${snapshotValue.snippetName}' because its target document was not updated.`,
      );
      return false;
    }
    const pad_pid = editor.selections.map((selection): TrackedPad => {
      const driver: OffsetRange = {
        start: document.offsetAt(selection.start),
        end: document.offsetAt(selection.end),
      };
      const anchor = document.offsetAt(selection.end);
      return {
        snapshot: { ...snapshotValue },
        config: { fill: snapshotValue.fill, targetWidth: snapshotValue.targetWidth },
        driver,
        generated: { start: anchor, end: anchor },
        previousGeneratedText: "",
        valid: true,
        needsEvaluation: true,
      };
    });
    const previousSession = this.sessionByEditor.get(editor);
    if (previousSession !== undefined) {
      this.discardSession(previousSession);
    }
    const session: EditorSession = {
      editor,
      document,
      pad_pid,
      lastSelection_sid: selectionRanges(document, editor.selections),
    };
    session.expirationTimer = setTimeout(() => {
      if (this.sessionByEditor.get(editor) === session) {
        this.log(`Discarded expired padding state for '${snapshotValue.snippetName}'.`);
        this.discardSession(session);
        void this.refreshContext();
      }
    }, SESSION_EXPIRATION_MS);
    this.sessionByEditor.set(editor, session);
    void this.refreshContext();
    return true;
  }

  public async advanceToNextPlaceholder(): Promise<void> {
    let editor: vscode.TextEditor | undefined;
    let session: EditorSession | undefined;
    let pendingPad_pid: readonly TrackedPad[] = [];
    try {
      editor = vscode.window.activeTextEditor;
      session = editor === undefined ? undefined : this.getCurrentSession(editor);
      pendingPad_pid = session === undefined ? [] : this.getPendingPads(session);

      if (editor !== undefined) {
        this.advancingCountByEditor.set(editor, (this.advancingCountByEditor.get(editor) ?? 0) + 1);
      }
    } catch (error: unknown) {
      this.log(`Failed to prepare Smart Snippets padding before Tab: ${String(error)}`);
    }

    try {
      let forwarded = false;
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

      // Move first so VS Code makes the driving placeholder inactive. Inserting at
      // the edge of an active placeholder would otherwise make native tracking
      // absorb the generated padding into that placeholder on Shift+Tab.
      if (forwarded && session !== undefined && pendingPad_pid.length > 0) {
        try {
          await this.queueEvaluation(session, pendingPad_pid);
        } catch (error: unknown) {
          this.log(`Failed to evaluate padding while advancing from the tab stop: ${String(error)}`);
        }
      }
    } finally {
      if (editor !== undefined) {
        const remaining = (this.advancingCountByEditor.get(editor) ?? 1) - 1;
        if (remaining === 0) {
          this.advancingCountByEditor.delete(editor);
        } else {
          this.advancingCountByEditor.set(editor, remaining);
        }
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

  private activeEditorHasPendingPads(): boolean {
    const editor = vscode.window.activeTextEditor;
    if (editor === undefined) {
      return false;
    }
    const session = this.getCurrentSession(editor);
    return session !== undefined && this.getPendingPads(session).length > 0;
  }

  private getCurrentSession(editor: vscode.TextEditor): EditorSession | undefined {
    const session = this.sessionByEditor.get(editor);
    return session?.document === editor.document ? session : undefined;
  }

  private getPendingPads(session: EditorSession): readonly TrackedPad[] {
    if (session.document !== session.editor.document) {
      return [];
    }
    const validPad_pid = session.pad_pid.filter((pad) => pad.valid);
    if (validPad_pid.length === 0) {
      return [];
    }
    const matchedDriverIndex_did = matchSelectionRangesToDriverRanges(
      selectionRanges(session.document, session.editor.selections),
      validPad_pid.map((pad) => pad.driver),
    );
    if (matchedDriverIndex_did === undefined) {
      return [];
    }
    return matchedDriverIndex_did
      .map((index) => validPad_pid[index])
      .filter((pad): pad is TrackedPad => pad !== undefined && pad.needsEvaluation);
  }

  private onDocumentChanged(event: vscode.TextDocumentChangeEvent): void {
    const change_cid: readonly ContentChange[] = event.contentChanges.map((change) => ({
      rangeOffset: change.rangeOffset,
      rangeLength: change.rangeLength,
      text: change.text,
    }));
    const managedEdit = this.pendingManagedEdit;
    const expectedManagedChange = managedEdit !== undefined
      && managedEdit.session.document === event.document
      && changesEqual(change_cid, managedEdit.change_cid);
    if (managedEdit !== undefined && managedEdit.session.document === event.document) {
      if (expectedManagedChange) {
        managedEdit.observed = true;
      } else {
        managedEdit.unexpected = true;
      }
    }

    for (const session of this.sessionByEditor.values()) {
      if (session.document !== event.document
        || (expectedManagedChange && managedEdit?.session === session)) {
        continue;
      }
      this.rebaseForExternalChanges(session, change_cid);
    }
    void this.refreshContext();
  }

  private rebaseForExternalChanges(session: EditorSession, change_cid: readonly ContentChange[]): void {
    for (const pad of session.pad_pid) {
      if (!pad.valid) {
        continue;
      }
      const touchedDriver = change_cid.some((change) => changeTouchesRange(change, pad.driver));
      const rebasedGenerated = rebaseProtectedRange(pad.generated, change_cid);
      if (!rebasedGenerated.valid) {
        this.invalidatePad(pad, rebasedGenerated.message);
        continue;
      }
      try {
        pad.driver = {
          start: rebaseOffset(pad.driver.start, change_cid, "left"),
          end: rebaseOffset(pad.driver.end, change_cid, "right"),
        };
        pad.generated = rebasedGenerated.range;
        if (touchedDriver) {
          pad.needsEvaluation = true;
        }
      } catch (error: unknown) {
        this.invalidatePad(pad, `Could not rebase tracked ranges: ${String(error)}`);
      }
    }

    try {
      session.lastSelection_sid = session.lastSelection_sid.map((selection) => ({
        start: rebaseOffset(selection.start, change_cid, "right"),
        end: rebaseOffset(selection.end, change_cid, "right"),
      }));
    } catch {
      session.lastSelection_sid = selectionRanges(session.document, session.editor.selections);
    }
    this.discardSettledSession(session);
  }

  private onSelectionChanged(event: vscode.TextEditorSelectionChangeEvent): void {
    const session = this.getCurrentSession(event.textEditor);
    if (session === undefined) {
      return;
    }
    const currentSelection_sid = selectionRanges(session.document, event.selections);
    const validPad_pid = session.pad_pid.filter((pad) => pad.valid);
    const transitions = getDriverSelectionTransitions(
      session.lastSelection_sid,
      currentSelection_sid,
      validPad_pid.map((pad) => pad.driver),
      validPad_pid.map((pad) => pad.needsEvaluation),
    );
    for (const index of transitions.enteredDriverIndex_did) {
      const pad = validPad_pid[index];
      if (pad !== undefined) {
        pad.needsEvaluation = true;
      }
    }
    const exitedPad_pid = transitions.exitedPendingDriverIndex_did
      .map((index) => validPad_pid[index])
      .filter((pad): pad is TrackedPad => pad !== undefined && pad.valid && pad.needsEvaluation);
    session.lastSelection_sid = currentSelection_sid;

    if (exitedPad_pid.length > 0 && !this.advancingCountByEditor.has(event.textEditor)) {
      void this.queueEvaluation(session, exitedPad_pid).catch((error: unknown) => {
        this.log(`Best-effort padding evaluation failed: ${String(error)}`);
      });
    }
    void this.refreshContext();
  }

  private onDocumentClosed(document: vscode.TextDocument): void {
    for (const session of this.sessionByEditor.values()) {
      if (session.document === document) {
        this.discardSession(session);
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

  private async evaluatePads(session: EditorSession, requestedPad_pid: readonly TrackedPad[]): Promise<void> {
    const document = session.document;
    const documentLength = document.getText().length;
    const replacement_rid: EvaluatedReplacement[] = [];

    const padByLine = new Map<number, TrackedPad[]>();
    for (const pad of session.pad_pid) {
      if (!pad.valid
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

    for (const pad of new Set(requestedPad_pid)) {
      if (!pad.valid || !pad.needsEvaluation) {
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

    const validReplacement_rid = replacement_rid.filter((replacement) => replacement.pad.valid);
    const changedReplacement_rid = validReplacement_rid.filter(
      (replacement) => replacement.text !== replacement.pad.previousGeneratedText,
    );
    for (const replacement of validReplacement_rid) {
      if (replacement.text === replacement.pad.previousGeneratedText) {
        replacement.pad.needsEvaluation = false;
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
    const managedEdit: PendingManagedEdit = {
      session,
      change_cid,
      observed: false,
      unexpected: false,
    };
    this.pendingManagedEdit = managedEdit;

    let applied = false;
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
    } finally {
      if (this.pendingManagedEdit === managedEdit) {
        this.pendingManagedEdit = undefined;
      }
    }

    if (this.disposed || this.sessionByEditor.get(session.editor) !== session) {
      return;
    }
    if (!applied) {
      this.log("VS Code rejected the Smart Snippets padding edit.");
    } else if (managedEdit.unexpected) {
      this.log("A concurrent document change prevented safe padding range tracking.");
      for (const replacement of changedReplacement_rid) {
        this.invalidatePad(
          replacement.pad,
          "A concurrent edit made the generated padding position ambiguous.",
        );
      }
    } else {
      this.applyManagedChanges(session, changedReplacement_rid, change_cid);
    }
    session.lastSelection_sid = selectionRanges(document, session.editor.selections);
    this.discardSettledSession(session);
    void this.refreshContext();
  }

  private applyManagedChanges(
    session: EditorSession,
    replacement_rid: readonly EvaluatedReplacement[],
    change_cid: readonly ContentChange[],
  ): void {
    const replacementByPad = new Map(replacement_rid.map((replacement) => [replacement.pad, replacement]));
    for (const pad of session.pad_pid) {
      if (!pad.valid) {
        continue;
      }
      const ownReplacement = replacementByPad.get(pad);
      try {
        const driverEndAffinity = ownReplacement !== undefined
          && ownReplacement.range.start === pad.driver.end
          ? "left"
          : "right";
        const driver: OffsetRange = {
          start: rebaseOffset(pad.driver.start, change_cid, "left"),
          end: rebaseOffset(pad.driver.end, change_cid, driverEndAffinity),
        };
        if (ownReplacement !== undefined) {
          const generatedStart = rebaseOffset(ownReplacement.range.start, change_cid, "left");
          pad.driver = driver;
          pad.generated = {
            start: generatedStart,
            end: generatedStart + ownReplacement.text.length,
          };
          pad.previousGeneratedText = ownReplacement.text;
          pad.needsEvaluation = false;
        } else {
          const generated = rebaseProtectedRange(pad.generated, change_cid);
          if (!generated.valid) {
            this.invalidatePad(pad, generated.message);
            continue;
          }
          pad.driver = driver;
          pad.generated = generated.range;
        }
      } catch (error: unknown) {
        this.invalidatePad(pad, `Could not track the generated edit: ${String(error)}`);
      }
    }
  }

  private invalidatePad(pad: TrackedPad, reason: string): void {
    if (!pad.valid) {
      return;
    }
    pad.valid = false;
    pad.needsEvaluation = false;
    this.log(`Invalidated padding for '${pad.snapshot.snippetName}': ${reason}`);
  }

  private discardSettledSession(session: EditorSession): void {
    if (session.pad_pid.every((pad) => !pad.valid || !pad.needsEvaluation)) {
      this.discardSession(session);
    }
  }

  private discardSession(session: EditorSession): void {
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
