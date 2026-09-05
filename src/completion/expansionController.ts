import * as vscode from "vscode";

import type { RegisteredSnippet, SnippetRegistry } from "../config/index.js";
import {
  findAgreedExactPrefixMatch,
  isExactPrefixAtBoundary,
} from "./exactMatching.js";
import type { RequestedExactExpansion } from "./expansionRequest.js";
import { createPadInsertionSnapshot } from "./provider.js";

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

    const snapshot = createPadInsertionSnapshot(
      expansion.snippet,
      expansion.editor.document,
    );
    let inserted: boolean;
    try {
      inserted = await expansion.editor.insertSnippet(
        new vscode.SnippetString(expansion.snippet.compiled.body),
        expansion.replacement_rid,
      );
    } catch (error: unknown) {
      this.log(`Failed to insert exact prefix '${expansion.prefix}': ${String(error)}`);
      return false;
    }
    if (!inserted) {
      this.log(`VS Code rejected exact-prefix insertion for '${expansion.snippet.name}'.`);
      return false;
    }

    if (snapshot !== undefined) {
      try {
        if (!this.captureInsertion(snapshot, expansion.editor)) {
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
