import * as vscode from "vscode";

import type { RegisteredSnippet, SnippetRegistry } from "../config/index.js";
import type { ExpandAtPrefixCommandOptions } from "./expansionRequest.js";
import {
  getPrefixBoundaryStarts,
  matchSnippetPrefixes,
  type PrefixMatch,
} from "./matching.js";

const MAX_COMPLETION_ITEMS = 500;

export interface PadInsertionSnapshot {
  readonly snippetName: string;
  readonly sourceUri: string;
  readonly targetDocumentUri: string;
  readonly targetDocumentVersion: number;
  readonly driverTabstop: number;
  readonly fill: string;
  readonly targetWidth: number;
}

/** Creates a fresh, serialization-safe snapshot for dynamic insertion capture. */
export function createPadInsertionSnapshot(
  snippet: RegisteredSnippet,
  targetDocument: Pick<vscode.TextDocument, "uri" | "version">,
): PadInsertionSnapshot | undefined {
  const pad = snippet.compiled.pad;
  return pad === undefined
    ? undefined
    : {
        snippetName: snippet.name,
        sourceUri: snippet.source.uri.toString(),
        targetDocumentUri: targetDocument.uri.toString(true),
        targetDocumentVersion: targetDocument.version,
        driverTabstop: pad.driverTabstop,
        fill: pad.fill,
        targetWidth: pad.targetWidth,
      };
}

function itemKey(snippet: RegisteredSnippet, match: PrefixMatch): string {
  return [
    snippet.name,
    match.prefix,
    snippet.compiled.body,
    snippet.source.kind,
    snippet.source.uri.toString(true),
  ].join("\u0000");
}

function sourceDetail(snippet: RegisteredSnippet): string {
  return snippet.source.kind === "user"
    ? "User Smart Snippets"
    : `Workspace Smart Snippets — ${snippet.source.uri.toString(true)}`;
}

/** Cheap, document-read-only completion provider backed by a SnippetRegistry. */
export class SmartSnippetCompletionProvider implements vscode.CompletionItemProvider {
  public constructor(
    private readonly registry: Pick<SnippetRegistry, "getSnippetsForDocument">,
    private readonly expandAtPrefixCommandId?: string,
  ) {}

  public provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    _token: vscode.CancellationToken,
    context: vscode.CompletionContext,
  ): vscode.CompletionList {
    const lineBeforeCursor = document.lineAt(position.line).text.slice(0, position.character);
    const allowEmpty = context.triggerKind === vscode.CompletionTriggerKind.Invoke;
    const snippet_sid = this.registry.getSnippetsForDocument(document);
    let maxPrefixLength = 0;
    for (const snippet of snippet_sid) {
      for (const prefix of snippet.prefix_pid) {
        maxPrefixLength = Math.max(maxPrefixLength, prefix.length);
      }
    }
    const boundary_bid = getPrefixBoundaryStarts(lineBeforeCursor, maxPrefixLength);
    const item_cid: vscode.CompletionItem[] = [];
    const seen = new Set<string>();
    let incomplete = false;

    completionLoop:
    for (const snippet of snippet_sid) {
      const match_mid = matchSnippetPrefixes(
        lineBeforeCursor,
        snippet.prefix_pid,
        allowEmpty,
        boundary_bid,
      );
      for (const match of match_mid) {
        if (item_cid.length >= MAX_COMPLETION_ITEMS) {
          incomplete = true;
          break completionLoop;
        }
        const key = itemKey(snippet, match);
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);

        const item = new vscode.CompletionItem(
          {
            label: match.prefix,
            detail: snippet.name,
            ...(snippet.compiled.description === undefined
              ? {}
              : { description: snippet.compiled.description }),
          },
          vscode.CompletionItemKind.Snippet,
        );
        item.insertText = snippet.compiled.pad === undefined
          ? new vscode.SnippetString(snippet.compiled.body)
          : match.prefix;
        item.range = new vscode.Range(
          new vscode.Position(position.line, match.startCharacter),
          position,
        );
        item.filterText = match.prefix;
        item.detail = `${snippet.name} — ${sourceDetail(snippet)}`;
        if (snippet.compiled.description !== undefined) {
          item.documentation = snippet.compiled.description;
        }
        item.sortText = [
          snippet.source.priority.toString().padStart(6, "0"),
          snippet.name,
          match.prefix,
        ].join(":");

        if (snippet.compiled.pad !== undefined && this.expandAtPrefixCommandId !== undefined) {
          const options: ExpandAtPrefixCommandOptions = {
            requestValid: true,
            requestedSnippet: {
              snippetName: snippet.name,
              sourceUri: snippet.source.uri.toString(true),
              prefix: match.prefix,
              targetDocumentUri: document.uri.toString(true),
            },
          };
          item.command = {
            command: this.expandAtPrefixCommandId,
            title: "Expand Smart Snippet",
            arguments: [options],
          };
        }
        item_cid.push(item);
      }
    }
    return new vscode.CompletionList(item_cid, incomplete);
  }
}
