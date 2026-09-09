import * as vscode from "vscode";

import type { RegisteredSnippet, SnippetRegistry } from "../config/index.js";
import {
  findAgreedExactPrefixMatch,
  isExactPrefixAtBoundary,
} from "./exactMatching.js";
import type { RequestedExactExpansion } from "./expansionRequest.js";
import {
  MAX_INSERTION_INDENT_CODE_UNITS,
  MAX_PLANNED_RENDERED_CODE_UNITS,
  MAX_RETAINED_OBSERVED_CHANGE_TEXT_CODE_UNITS,
  MAX_RENDERING_INDENT_SIZE,
  createInsertionCapturePlan,
  finalizeInsertionCapture,
  type InsertionContentChange,
  type InsertionDocumentEvent,
  type InsertionReplacementContext,
} from "./insertionCapture.js";

export const EXACT_PREFIX_AVAILABLE_CONTEXT = "smartSnippets.exactPrefixAvailable";
const PREFIX_TAB_EXPANSION_SETTING = "enablePrefixTabExpansion";

type ExpansionRegistry = Pick<
  SnippetRegistry,
  "getSnippetsForDocument" | "onDidChange"
>;

interface ExactPrefixExpansion {
  readonly editor: vscode.TextEditor;
  readonly snippet: RegisteredSnippet;
  readonly prefix: string;
  readonly replacement_rid: readonly vscode.Range[];
}

function resolveReplacementContexts(
  editor: vscode.TextEditor,
  replacement_rid: readonly vscode.Range[],
): readonly InsertionReplacementContext[] | undefined {
  const { document } = editor;
  const indentSize = editor.options.indentSize;
  const insertSpaces = editor.options.insertSpaces;
  if (typeof indentSize !== "number"
    || !Number.isSafeInteger(indentSize)
    || indentSize <= 0
    || indentSize > MAX_RENDERING_INDENT_SIZE
    || typeof insertSpaces !== "boolean") {
    return undefined;
  }
  const targetEolWidth = document.eol === vscode.EndOfLine.LF
    ? 1
    : document.eol === vscode.EndOfLine.CRLF ? 2 : undefined;
  if (targetEolWidth === undefined) {
    return undefined;
  }

  const context_rid: InsertionReplacementContext[] = [];
  let retainedIndentCodeUnits = 0;
  for (const range of replacement_rid) {
    const indentScanEnd = new vscode.Position(
      range.start.line,
      Math.min(range.start.character, MAX_INSERTION_INDENT_CODE_UNITS + 1),
    );
    const linePrefix = document.getText(new vscode.Range(
      new vscode.Position(range.start.line, 0),
      indentScanEnd,
    ));
    const insertionIndent = /^[ \t]*/u.exec(linePrefix)?.[0];
    if (insertionIndent === undefined
      || insertionIndent.length > MAX_INSERTION_INDENT_CODE_UNITS) {
      return undefined;
    }
    if (insertionIndent.length
      > MAX_PLANNED_RENDERED_CODE_UNITS - retainedIndentCodeUnits) {
      return undefined;
    }
    retainedIndentCodeUnits += insertionIndent.length;
    const rangeOffset = document.offsetAt(range.start);
    context_rid.push({
      rangeOffset,
      rangeLength: document.offsetAt(range.end) - rangeOffset,
      targetEolWidth,
      indentSize,
      insertSpaces,
      insertionIndent,
    });
  }
  return context_rid;
}

/** Resolves complete configured prefixes and inserts them through native snippet mode. */
export class ExactPrefixExpansionController implements vscode.Disposable {
  private readonly listener_did: vscode.Disposable[] = [];
  private contextGeneration = 0;
  private contextTask: Promise<void> = Promise.resolve();
  private initialized = false;
  private disposed = false;

  public constructor(
    private readonly registry: ExpansionRegistry,
    private readonly captureInsertion: (
      snapshot: unknown,
      editor: vscode.TextEditor,
    ) => boolean,
    private readonly output: Pick<vscode.OutputChannel, "appendLine">,
  ) {}

  public async initialize(): Promise<void> {
    if (this.initialized || this.disposed) {
      return;
    }
    this.initialized = true;
    this.listener_did.push(
      vscode.window.onDidChangeActiveTextEditor(() => { void this.refreshAvailability(); }),
      vscode.window.onDidChangeTextEditorSelection((event) => {
        if (event.textEditor === vscode.window.activeTextEditor) {
          void this.refreshAvailability();
        }
      }),
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (event.contentChanges.length > 0
          && event.document === vscode.window.activeTextEditor?.document) {
          void this.refreshAvailability();
        }
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration(`smartSnippets.${PREFIX_TAB_EXPANSION_SETTING}`)) {
          void this.refreshAvailability();
        }
      }),
      this.registry.onDidChange(() => { void this.refreshAvailability(); }),
    );
    await this.refreshAvailability();
  }

  /** Revalidates current cursors and expands without relying on editor.tabCompletion. */
  public async expandAtExactPrefix(request?: RequestedExactExpansion): Promise<boolean> {
    const expansion = this.resolveActiveExpansionSafely(request);
    if (expansion === undefined) {
      return false;
    }

    const targetDocument = expansion.editor.document;
    const targetDocumentUri = targetDocument.uri.toString(true);
    const dynamic = expansion.snippet.compiled.pad_pid !== undefined;
    let planResult: ReturnType<typeof createInsertionCapturePlan> | undefined;
    if (dynamic) {
      const replacement_rid = resolveReplacementContexts(
        expansion.editor,
        expansion.replacement_rid,
      );
      if (replacement_rid === undefined) {
        this.log(`Could not determine safe rendering context for '${expansion.snippet.name}'.`);
        return false;
      }
      planResult = createInsertionCapturePlan({
        snippetName: expansion.snippet.name,
        sourceUri: expansion.snippet.source.uri.toString(true),
        targetDocumentUri,
        targetDocumentVersion: targetDocument.version,
        targetDocumentLength: targetDocument.offsetAt(
          new vscode.Position(targetDocument.lineCount, 0),
        ),
        compiled: expansion.snippet.compiled,
        replacement_rid,
      });
    }
    if (planResult !== undefined && !planResult.success) {
      this.log(`Could not plan dynamic insertion for '${expansion.snippet.name}': ${planResult.reason}`);
      return false;
    }
    let observedEvent: InsertionDocumentEvent | undefined;
    let eventAmbiguousOrOverflow = false;
    const captureListener = planResult?.success === true
      ? vscode.workspace.onDidChangeTextDocument((event) => {
          if (event.document === targetDocument) {
            if (observedEvent !== undefined || eventAmbiguousOrOverflow
              || event.contentChanges.length !== planResult.value.replacement_rid.length) {
              eventAmbiguousOrOverflow = true;
              return;
            }
            const change_cid: InsertionContentChange[] = [];
            let retainedObservedCodeUnits = 0;
            for (const change of event.contentChanges) {
              if (change.text.length
                > MAX_RETAINED_OBSERVED_CHANGE_TEXT_CODE_UNITS - retainedObservedCodeUnits) {
                eventAmbiguousOrOverflow = true;
                return;
              }
              retainedObservedCodeUnits += change.text.length;
              change_cid.push({
                rangeOffset: change.rangeOffset,
                rangeLength: change.rangeLength,
                text: change.text,
              });
            }
            observedEvent = {
              targetDocumentVersion: event.document.version,
              change_cid,
            };
          }
        })
      : undefined;
    let inserted: boolean;
    try {
      inserted = await expansion.editor.insertSnippet(
        new vscode.SnippetString(expansion.snippet.compiled.body),
        expansion.replacement_rid,
      );
    } catch (error: unknown) {
      this.log(`Failed to insert exact prefix '${expansion.prefix}': ${String(error)}`);
      return false;
    } finally {
      captureListener?.dispose();
    }
    if (!inserted) {
      this.log(`VS Code rejected exact-prefix insertion for '${expansion.snippet.name}'.`);
      return false;
    }

    if (planResult?.success === true) {
      const finalized = finalizeInsertionCapture(planResult.value, {
        insertionSucceeded: true,
        targetDocumentUri: expansion.editor.document.uri.toString(true),
        targetDocumentVersion: expansion.editor.document.version,
        event: observedEvent,
        eventAmbiguousOrOverflow,
      });
      if (!finalized.success) {
        this.log(`Could not capture dynamic insertion for '${expansion.snippet.name}': ${finalized.reason}`);
        return true;
      }
      try {
        if (!this.captureInsertion(finalized.value, expansion.editor)) {
          this.log(`Could not capture dynamic insertion for '${expansion.snippet.name}'.`);
        }
      } catch (error: unknown) {
        this.log(`Dynamic insertion capture failed for '${expansion.snippet.name}': ${String(error)}`);
      }
    }
    return true;
  }

  public refreshAvailability(): Promise<void> {
    const generation = ++this.contextGeneration;
    const available = !this.disposed
      && vscode.workspace.getConfiguration("smartSnippets")
        .get<boolean>(PREFIX_TAB_EXPANSION_SETTING, true) === true
      && this.resolveActiveExpansionSafely() !== undefined;
    this.contextTask = this.contextTask
      .catch((error: unknown) => {
        this.log(`Previous exact-prefix context update failed: ${String(error)}`);
      })
      .then(async () => {
        if (generation !== this.contextGeneration) {
          return;
        }
        try {
          await vscode.commands.executeCommand(
            "setContext",
            EXACT_PREFIX_AVAILABLE_CONTEXT,
            available,
          );
        } catch (error: unknown) {
          this.log(`Failed to update '${EXACT_PREFIX_AVAILABLE_CONTEXT}': ${String(error)}`);
        }
      });
    return this.contextTask;
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const listener of this.listener_did.splice(0)) {
      listener.dispose();
    }
    void this.refreshAvailability();
  }

  private resolveActiveExpansionSafely(
    request?: RequestedExactExpansion,
  ): ExactPrefixExpansion | undefined {
    if (this.disposed) {
      return undefined;
    }
    try {
      return this.resolveActiveExpansion(request);
    } catch (error: unknown) {
      this.log(`Failed to resolve exact-prefix availability: ${String(error)}`);
      return undefined;
    }
  }

  private resolveActiveExpansion(request?: RequestedExactExpansion): ExactPrefixExpansion | undefined {
    const editor = vscode.window.activeTextEditor;
    if (editor === undefined
      || editor.document.isClosed
      || vscode.workspace.fs.isWritableFileSystem(editor.document.uri.scheme) === false
      || editor.selections.length === 0
      || editor.selections.some((selection) => !selection.isEmpty)) {
      return undefined;
    }

    const snippet_sid = this.registry.getSnippetsForDocument(editor.document);
    const lineBeforeCursor_sid = editor.selections.map((selection) => (
      editor.document.lineAt(selection.active.line).text.slice(0, selection.active.character)
    ));
    const requestedSnippet = request === undefined
      ? undefined
      : snippet_sid.find((snippet) => snippet.name === request.snippetName
        && snippet.source.uri.toString(true) === request.sourceUri
        && snippet.prefix_pid.includes(request.prefix));
    if (request !== undefined
      && (request.targetDocumentUri !== editor.document.uri.toString(true)
        || requestedSnippet === undefined
        || lineBeforeCursor_sid.some(
          (lineBeforeCursor) => !isExactPrefixAtBoundary(lineBeforeCursor, request.prefix),
        ))) {
      return undefined;
    }
    const match = requestedSnippet === undefined || request === undefined
      ? findAgreedExactPrefixMatch(lineBeforeCursor_sid, snippet_sid)
      : {
          snippet: requestedSnippet,
          prefix: request.prefix,
          startCharacter: (lineBeforeCursor_sid[0]?.length ?? 0) - request.prefix.length,
        };
    if (match === undefined) {
      return undefined;
    }
    const replacement_rid = editor.selections.map((selection, index) => {
      const lineBeforeCursor = lineBeforeCursor_sid[index];
      if (lineBeforeCursor === undefined) {
        throw new Error("Missing exact-prefix cursor text.");
      }
      return new vscode.Range(
        new vscode.Position(
          selection.active.line,
          lineBeforeCursor.length - match.prefix.length,
        ),
        selection.active,
      );
    });
    return {
      editor,
      snippet: match.snippet,
      prefix: match.prefix,
      replacement_rid,
    };
  }

  private log(message: string): void {
    try {
      this.output.appendLine(`[expansion] ${message}`);
    } catch {
      // Logging must not interfere with direct expansion or Tab fallback.
    }
  }
}
