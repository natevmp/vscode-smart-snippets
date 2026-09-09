import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";

import {
  findNodeAtLocation,
  getNodeValue,
  parseTree,
  printParseErrorCode,
  type Node as JsonNode,
  type ParseError,
} from "jsonc-parser";
import * as vscode from "vscode";

import {
  compileSnippetDefinitions,
  limitSemanticIssues,
  type CompiledSnippet,
  type SnippetIssue,
} from "../core/index.js";
import {
  indexDuplicatePrefixConflicts,
  MAX_DUPLICATE_PREFIX_WORK_UNITS,
  MAX_DUPLICATE_PREFIX_WARNINGS,
} from "./conflicts.js";
import {
  isLanguageInScope,
  normalizeCompiledSnippet,
} from "./helpers.js";
import {
  countConfiguredPrefixes,
  DEFAULT_MAX_PREFIXES_PER_SOURCE,
  exceedsJsonNestingDepth,
  MAX_JSON_NESTING_DEPTH,
  MAX_SCOPE_IDS_PER_SOURCE,
  MAX_SCOPE_TEXT_LENGTH_PER_SOURCE,
  measureSourceScopeMetrics,
} from "./limits.js";

const CONFIGURATION_SECTION = "smartSnippets";
const USER_FILE_SETTING = "userSnippetFile";
const WORKSPACE_FILE_SEGMENTS = [".vscode", "smart-snippets.jsonc"] as const;
const DEFAULT_MAX_FILE_BYTES = 1024 * 1024;
const DEFAULT_MAX_SNIPPETS_PER_SOURCE = 2_000;
const DEFAULT_RELOAD_DEBOUNCE_MS = 100;
const MAX_PARSE_ERROR_DIAGNOSTICS = 100;
const DIAGNOSTIC_SOURCE = "Smart Snippets";
const INITIAL_FILE_CONTENT = `{
  "Heading Level 1": {
    "scope": ["julia"],
    "prefix": "#h1",
    "body": ["## @h1 $1\${pad}", "$0"],
    "pad": {
      "fill": "-",
      "targetWidth": 80
    },
    "description": "Create a level 1 heading"
  }
}
`;

export type SnippetSourceKind = "user" | "workspace";

export interface SnippetSource {
  readonly kind: SnippetSourceKind;
  readonly uri: vscode.Uri;
  /** User is 0; workspace sources follow workspace-folder order starting at 1. */
  readonly priority: number;
}

export interface RegisteredSnippet {
  readonly name: string;
  readonly compiled: CompiledSnippet;
  readonly prefix_pid: readonly string[];
  /** Empty means that the snippet applies to every language. */
  readonly scope_lid: readonly string[];
  readonly source: SnippetSource;
}

export interface SnippetRegistryOptions {
  readonly maxFileBytes?: number;
  readonly maxSnippetsPerSource?: number;
  readonly maxPrefixesPerSource?: number;
  readonly reloadDebounceMs?: number;
  readonly diagnosticCollection?: vscode.DiagnosticCollection;
}

interface SourceSnapshot {
  readonly source: SnippetSource;
  readonly snippet_sid: readonly RegisteredSnippet[];
}

interface LoadedSource {
  readonly snapshot?: SourceSnapshot;
  readonly diagnostic_did: readonly vscode.Diagnostic[];
  readonly keepLastKnownGood: boolean;
}

interface BoundedParseErrors {
  readonly error_eid: readonly ParseError[];
  readonly sink: ParseError[];
  readonly totalCount: number;
}

function createBoundedParseErrors(limit: number): BoundedParseErrors {
  const error_eid: ParseError[] = [];
  let totalCount = 0;
  const sink = {
    push: (...nextError_eid: ParseError[]): number => {
      totalCount += nextError_eid.length;
      const remaining = Math.max(0, limit - error_eid.length);
      error_eid.push(...nextError_eid.slice(0, remaining));
      return totalCount;
    },
  } as unknown as ParseError[];
  return {
    error_eid,
    sink,
    get totalCount(): number {
      return totalCount;
    },
  };
}

function uriKey(uri: vscode.Uri): string {
  return uri.toString(true);
}

function isFileNotFound(error: unknown): boolean {
  return error instanceof vscode.FileSystemError
    ? error.code === "FileNotFound"
    : typeof error === "object"
      && error !== null
      && "code" in error
      && (error as { readonly code?: unknown }).code === "FileNotFound";
}

class TextPositionIndex {
  private readonly lineStart_lid: number[] = [0];

  public constructor(private readonly text: string) {
    for (let offset = 0; offset < text.length; offset += 1) {
      if (text.charCodeAt(offset) === 10) {
        this.lineStart_lid.push(offset + 1);
      }
    }
  }

  public positionAt(requestedOffset: number): vscode.Position {
    const offset = Math.max(0, Math.min(requestedOffset, this.text.length));
    let lower = 0;
    let upper = this.lineStart_lid.length;
    while (lower + 1 < upper) {
      const middle = lower + Math.floor((upper - lower) / 2);
      const lineStart = this.lineStart_lid[middle];
      if (lineStart !== undefined && lineStart <= offset) {
        lower = middle;
      } else {
        upper = middle;
      }
    }
    return new vscode.Position(lower, offset - (this.lineStart_lid[lower] ?? 0));
  }

  public rangeAt(offset: number, length: number): vscode.Range {
    const start = this.positionAt(offset);
    const end = this.positionAt(offset + Math.max(length, 1));
    return new vscode.Range(start, end);
  }

  public wholeDocumentRange(): vscode.Range {
    return new vscode.Range(new vscode.Position(0, 0), this.positionAt(this.text.length));
  }
}

function issueRange(
  positions: TextPositionIndex,
  root: JsonNode | undefined,
  issue: SnippetIssue,
): vscode.Range {
  if (root !== undefined && issue.snippetName !== undefined) {
    const node = findNodeAtLocation(root, [issue.snippetName]);
    if (node !== undefined) {
      return positions.rangeAt(node.offset, node.length);
    }
  }
  return positions.wholeDocumentRange();
}

function sourceLabel(source: SnippetSource): string {
  return source.kind === "user" ? "user" : `workspace (${source.uri.toString(true)})`;
}

function isTopLevelObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** VS Code-facing registry for user and multi-root workspace Smart Snippets files. */
export class SnippetRegistry implements vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  private readonly diagnosticCollection: vscode.DiagnosticCollection;
  private readonly ownsDiagnosticCollection: boolean;
  private readonly maxFileBytes: number;
  private readonly maxSnippetsPerSource: number;
  private readonly maxPrefixesPerSource: number;
  private readonly reloadDebounceMs: number;
  private readonly disposable_did: vscode.Disposable[] = [];
  private readonly watcher_did: vscode.Disposable[] = [];
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });

  private userUri: vscode.Uri;
  private userSnapshot: SourceSnapshot;
  private workspaceSnapshotByFolder = new Map<string, SourceSnapshot>();
  private reloadTimer: ReturnType<typeof setTimeout> | undefined;
  private reloadChain: Promise<void> = Promise.resolve();
  private initialized = false;
  private disposed = false;

  public readonly onDidChange = this.changeEmitter.event;

  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel,
    options: SnippetRegistryOptions = {},
  ) {
    this.maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    this.maxSnippetsPerSource = options.maxSnippetsPerSource ?? DEFAULT_MAX_SNIPPETS_PER_SOURCE;
    this.maxPrefixesPerSource = options.maxPrefixesPerSource ?? DEFAULT_MAX_PREFIXES_PER_SOURCE;
    this.reloadDebounceMs = options.reloadDebounceMs ?? DEFAULT_RELOAD_DEBOUNCE_MS;
    this.diagnosticCollection = options.diagnosticCollection
      ?? vscode.languages.createDiagnosticCollection("smartSnippets");
    this.ownsDiagnosticCollection = options.diagnosticCollection === undefined;
    this.userUri = this.resolveUserUri();
    this.userSnapshot = {
      source: { kind: "user", uri: this.userUri, priority: 0 },
      snippet_sid: [],
    };
  }

  public async initialize(): Promise<void> {
    if (this.disposed) {
      throw new Error("Cannot initialize a disposed SnippetRegistry.");
    }
    if (this.initialized) {
      return;
    }
    this.initialized = true;

    this.disposable_did.push(
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        this.rebuildWatchers();
        this.fireDidChange();
        this.scheduleReload();
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (!event.affectsConfiguration(`${CONFIGURATION_SECTION}.${USER_FILE_SETTING}`)) {
          return;
        }
        const nextUserUri = this.resolveUserUri();
        if (uriKey(nextUserUri) !== uriKey(this.userUri)) {
          this.diagnosticCollection.delete(this.userUri);
          this.userUri = nextUserUri;
          this.userSnapshot = {
            source: { kind: "user", uri: nextUserUri, priority: 0 },
            snippet_sid: [],
          };
          this.rebuildWatchers();
          this.fireDidChange();
        }
        this.scheduleReload();
      }),
      vscode.workspace.onDidSaveTextDocument((document) => {
        if (this.isManagedUri(document.uri)) {
          this.scheduleReload();
        }
      }),
    );
    this.rebuildWatchers();
    await this.reload();
  }

  public reload(): Promise<void> {
    if (this.disposed) {
      return Promise.resolve();
    }
    if (this.reloadTimer !== undefined) {
      clearTimeout(this.reloadTimer);
      this.reloadTimer = undefined;
    }
    this.reloadChain = this.reloadChain
      .catch((error: unknown) => {
        this.log(`[registry] Previous reload failed: ${String(error)}`);
      })
      .then(async () => {
        if (this.disposed) {
          return;
        }
        await this.performReload();
      });
    return this.reloadChain;
  }

  public getUserUri(): vscode.Uri {
    return this.userUri;
  }

  public getWorkspaceUri(folder: vscode.WorkspaceFolder): vscode.Uri {
    return vscode.Uri.joinPath(folder.uri, ...WORKSPACE_FILE_SEGMENTS);
  }

  /** Returns effective, language-filtered snippets. Workspace names override user names. */
  public getSnippetsForDocument(document: vscode.TextDocument): readonly RegisteredSnippet[] {
    const snippetByName = new Map<string, RegisteredSnippet>();
    for (const snippet of this.userSnapshot.snippet_sid) {
      snippetByName.set(snippet.name, snippet);
    }

    const folder = vscode.workspace.getWorkspaceFolder(document.uri);
    if (folder !== undefined) {
      const workspaceSnapshot = this.workspaceSnapshotByFolder.get(uriKey(folder.uri));
      for (const snippet of workspaceSnapshot?.snippet_sid ?? []) {
        snippetByName.set(snippet.name, snippet);
      }
    }

    return [...snippetByName.values()]
      .filter((snippet) => isLanguageInScope(document.languageId, snippet.scope_lid))
      .sort((left, right) => left.source.priority - right.source.priority
        || left.name.localeCompare(right.name)
        || uriKey(left.source.uri).localeCompare(uriKey(right.source.uri)));
  }

  public async createUserSnippetFile(): Promise<vscode.Uri> {
    await this.createFileIfAbsent(this.userUri);
    return this.userUri;
  }

  public async openUserSnippetFile(): Promise<vscode.Uri> {
    const uri = await this.createUserSnippetFile();
    await this.showFile(uri);
    return uri;
  }

  public async createWorkspaceSnippetFile(
    folder?: vscode.WorkspaceFolder,
  ): Promise<vscode.Uri | undefined> {
    const selectedFolder = folder ?? await this.selectWorkspaceFolder();
    if (selectedFolder === undefined) {
      return undefined;
    }
    const uri = this.getWorkspaceUri(selectedFolder);
    await this.createFileIfAbsent(uri);
    return uri;
  }

  public async openWorkspaceSnippetFile(
    folder?: vscode.WorkspaceFolder,
  ): Promise<vscode.Uri | undefined> {
    const uri = await this.createWorkspaceSnippetFile(folder);
    if (uri !== undefined) {
      await this.showFile(uri);
    }
    return uri;
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    if (this.reloadTimer !== undefined) {
      clearTimeout(this.reloadTimer);
      this.reloadTimer = undefined;
    }
    for (const disposable of this.watcher_did.splice(0)) {
      disposable.dispose();
    }
    for (const disposable of this.disposable_did.splice(0)) {
      disposable.dispose();
    }
    if (this.ownsDiagnosticCollection) {
      this.diagnosticCollection.dispose();
    } else {
      this.diagnosticCollection.clear();
    }
    this.changeEmitter.dispose();
  }

  private resolveUserUri(): vscode.Uri {
    const inspected = vscode.workspace
      .getConfiguration(CONFIGURATION_SECTION)
      .inspect<unknown>(USER_FILE_SETTING);
    const configured = typeof inspected?.globalValue === "string"
      ? inspected.globalValue.trim()
      : "";
    if (configured.length > 0) {
      const expanded = configured === "~"
        ? homedir()
        : configured.startsWith("~/") || configured.startsWith("~\\")
          ? path.join(homedir(), configured.slice(2))
          : configured;
      if (path.isAbsolute(expanded)) {
        return vscode.Uri.file(expanded);
      }
      this.log(
        `[registry] Ignoring non-absolute global ${CONFIGURATION_SECTION}.${USER_FILE_SETTING}: ${configured}`,
      );
    }
    return vscode.Uri.joinPath(this.context.globalStorageUri, "smart-snippets.jsonc");
  }

  private rebuildWatchers(): void {
    for (const disposable of this.watcher_did.splice(0)) {
      disposable.dispose();
    }

    this.addWatcher(this.userUri);
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const uri = this.getWorkspaceUri(folder);
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(folder, WORKSPACE_FILE_SEGMENTS.join("/")),
      );
      this.watchFileEvents(watcher, uri);
      this.watcher_did.push(watcher);
    }
  }

  private addWatcher(uri: vscode.Uri): void {
    const parent = vscode.Uri.joinPath(uri, "..");
    const watcher = vscode.workspace.createFileSystemWatcher(
      // A one-segment pattern also handles configured file names containing glob metacharacters.
      new vscode.RelativePattern(parent, "*"),
    );
    this.watchFileEvents(watcher, uri);
    this.watcher_did.push(watcher);
  }

  private watchFileEvents(watcher: vscode.FileSystemWatcher, expectedUri: vscode.Uri): void {
    const handle = (changedUri: vscode.Uri): void => {
      if (uriKey(changedUri) === uriKey(expectedUri)) {
        this.scheduleReload();
      }
    };
    this.watcher_did.push(
      watcher.onDidCreate(handle),
      watcher.onDidChange(handle),
      watcher.onDidDelete(handle),
    );
  }

  private scheduleReload(): void {
    if (this.disposed) {
      return;
    }
    if (this.reloadTimer !== undefined) {
      clearTimeout(this.reloadTimer);
    }
    this.reloadTimer = setTimeout(() => {
      this.reloadTimer = undefined;
      void this.reload().catch((error: unknown) => {
        this.log(`[registry] Scheduled reload failed: ${String(error)}`);
      });
    }, this.reloadDebounceMs);
  }

  private isManagedUri(uri: vscode.Uri): boolean {
    if (uriKey(uri) === uriKey(this.userUri)) {
      return true;
    }
    return (vscode.workspace.workspaceFolders ?? [])
      .some((folder) => uriKey(uri) === uriKey(this.getWorkspaceUri(folder)));
  }

  private async performReload(): Promise<void> {
    const workspaceFolder_fid = vscode.workspace.workspaceFolders ?? [];
    const source_sid: SnippetSource[] = [
      { kind: "user", uri: this.userUri, priority: 0 },
      ...workspaceFolder_fid.map((folder, index) => ({
        kind: "workspace" as const,
        uri: this.getWorkspaceUri(folder),
        priority: index + 1,
      })),
    ];
    const loaded_sid = await Promise.all(source_sid.map(async (source) => ({
      source,
      loaded: await this.loadSource(source),
    })));
    if (this.disposed) {
      return;
    }

    const nextWorkspaceSnapshotByFolder = new Map<string, SourceSnapshot>();
    const activeUri = new Set(source_sid.map((source) => uriKey(source.uri)));
    for (const [uri] of this.diagnosticCollection) {
      if (!activeUri.has(uriKey(uri))) {
        this.diagnosticCollection.delete(uri);
      }
    }

    for (const entry of loaded_sid) {
      const previous = entry.source.kind === "user"
        ? this.userSnapshot
        : this.findWorkspaceSnapshotByUri(entry.source.uri);
      const snapshot = entry.loaded.keepLastKnownGood
        ? previous ?? { source: entry.source, snippet_sid: [] }
        : entry.loaded.snapshot ?? { source: entry.source, snippet_sid: [] };

      this.diagnosticCollection.set(entry.source.uri, entry.loaded.diagnostic_did);
      if (entry.source.kind === "user") {
        this.userSnapshot = snapshot;
      } else {
        const folder = workspaceFolder_fid.find(
          (candidate) => uriKey(this.getWorkspaceUri(candidate)) === uriKey(entry.source.uri),
        );
        if (folder !== undefined) {
          nextWorkspaceSnapshotByFolder.set(uriKey(folder.uri), snapshot);
        }
      }
    }
    this.workspaceSnapshotByFolder = nextWorkspaceSnapshotByFolder;

    const loadedCount = this.userSnapshot.snippet_sid.length
      + [...this.workspaceSnapshotByFolder.values()]
        .reduce((count, snapshot) => count + snapshot.snippet_sid.length, 0);
    this.log(`[registry] Reload complete: ${loadedCount} compiled snippet(s).`);
    this.fireDidChange();
  }

  private findWorkspaceSnapshotByUri(uri: vscode.Uri): SourceSnapshot | undefined {
    return [...this.workspaceSnapshotByFolder.values()]
      .find((snapshot) => uriKey(snapshot.source.uri) === uriKey(uri));
  }

  private async loadSource(source: SnippetSource): Promise<LoadedSource> {
    let bytes: Uint8Array;
    try {
      const stat = await vscode.workspace.fs.stat(source.uri);
      if (stat.size > this.maxFileBytes) {
        const diagnostic = new vscode.Diagnostic(
          new vscode.Range(0, 0, 0, 0),
          `Snippet file is ${stat.size} bytes; the limit is ${this.maxFileBytes} bytes.`,
          vscode.DiagnosticSeverity.Error,
        );
        diagnostic.source = DIAGNOSTIC_SOURCE;
        this.log(`[registry] ${source.uri.toString(true)} exceeds the file-size limit.`);
        return { diagnostic_did: [diagnostic], keepLastKnownGood: true };
      }
      bytes = await vscode.workspace.fs.readFile(source.uri);
      if (bytes.byteLength > this.maxFileBytes) {
        const diagnostic = new vscode.Diagnostic(
          new vscode.Range(0, 0, 0, 0),
          `Snippet file exceeds the ${this.maxFileBytes}-byte limit.`,
          vscode.DiagnosticSeverity.Error,
        );
        diagnostic.source = DIAGNOSTIC_SOURCE;
        return { diagnostic_did: [diagnostic], keepLastKnownGood: true };
      }
    } catch (error: unknown) {
      if (isFileNotFound(error)) {
        return {
          snapshot: { source, snippet_sid: [] },
          diagnostic_did: [],
          keepLastKnownGood: false,
        };
      }
      const diagnostic = new vscode.Diagnostic(
        new vscode.Range(0, 0, 0, 0),
        `Unable to read snippet file: ${String(error)}`,
        vscode.DiagnosticSeverity.Error,
      );
      diagnostic.source = DIAGNOSTIC_SOURCE;
      this.log(`[registry] Failed to read ${source.uri.toString(true)}: ${String(error)}`);
      return { diagnostic_did: [diagnostic], keepLastKnownGood: true };
    }

    let text: string;
    try {
      text = this.decoder.decode(bytes);
    } catch (error: unknown) {
      const diagnostic = new vscode.Diagnostic(
        new vscode.Range(0, 0, 0, 0),
        `Snippet file is not valid UTF-8: ${String(error)}`,
        vscode.DiagnosticSeverity.Error,
      );
      diagnostic.source = DIAGNOSTIC_SOURCE;
      return { diagnostic_did: [diagnostic], keepLastKnownGood: true };
    }
    const positions = new TextPositionIndex(text);

    if (exceedsJsonNestingDepth(text)) {
      const diagnostic = new vscode.Diagnostic(
        positions.wholeDocumentRange(),
        `Snippet file nesting exceeds the limit of ${MAX_JSON_NESTING_DEPTH} levels.`,
        vscode.DiagnosticSeverity.Error,
      );
      diagnostic.source = DIAGNOSTIC_SOURCE;
      return { diagnostic_did: [diagnostic], keepLastKnownGood: true };
    }

    const parseOptions = { allowTrailingComma: true, disallowComments: false } as const;
    const parseErrors = createBoundedParseErrors(MAX_PARSE_ERROR_DIAGNOSTICS);
    let root: JsonNode | undefined;
    try {
      root = parseTree(text, parseErrors.sink, parseOptions);
    } catch (error: unknown) {
      const diagnostic = new vscode.Diagnostic(
        positions.wholeDocumentRange(),
        `Unable to parse snippet JSONC safely: ${String(error)}`,
        vscode.DiagnosticSeverity.Error,
      );
      diagnostic.source = DIAGNOSTIC_SOURCE;
      return { diagnostic_did: [diagnostic], keepLastKnownGood: true };
    }
    if (parseErrors.totalCount > 0) {
      const diagnostic_did = parseErrors.error_eid.map((error) => {
        const diagnostic = new vscode.Diagnostic(
          positions.rangeAt(error.offset, error.length),
          `Invalid JSONC: ${printParseErrorCode(error.error)}`,
          vscode.DiagnosticSeverity.Error,
        );
        diagnostic.source = DIAGNOSTIC_SOURCE;
        return diagnostic;
      });
      const omittedCount = parseErrors.totalCount - parseErrors.error_eid.length;
      if (omittedCount > 0) {
        const diagnostic = new vscode.Diagnostic(
          positions.wholeDocumentRange(),
          `${omittedCount} additional JSONC parse error(s) omitted after the limit of ${MAX_PARSE_ERROR_DIAGNOSTICS}.`,
          vscode.DiagnosticSeverity.Error,
        );
        diagnostic.source = DIAGNOSTIC_SOURCE;
        diagnostic_did.push(diagnostic);
      }
      this.log(
        `[registry] ${source.uri.toString(true)} has ${parseErrors.totalCount} JSONC parse error(s); keeping last-known-good snippets.`,
      );
      return { diagnostic_did, keepLastKnownGood: true };
    }
    const value: unknown = root === undefined ? undefined : getNodeValue(root);

    if (isTopLevelObject(value)) {
      const snippetCount = Object.keys(value).length;
      if (snippetCount > this.maxSnippetsPerSource) {
        const diagnostic = new vscode.Diagnostic(
          positions.wholeDocumentRange(),
          `Snippet file defines ${snippetCount} snippets; the limit is ${this.maxSnippetsPerSource} snippets per source.`,
          vscode.DiagnosticSeverity.Error,
        );
        diagnostic.source = DIAGNOSTIC_SOURCE;
        diagnostic.code = "$";
        this.log(
          `[registry] ${source.uri.toString(true)} exceeds the per-source snippet limit; keeping last-known-good snippets.`,
        );
        return { diagnostic_did: [diagnostic], keepLastKnownGood: true };
      }
      const prefixCount = countConfiguredPrefixes(value, this.maxPrefixesPerSource);
      if (prefixCount > this.maxPrefixesPerSource) {
        const diagnostic = new vscode.Diagnostic(
          positions.wholeDocumentRange(),
          `Snippet file defines more than ${this.maxPrefixesPerSource} prefixes; reduce the number of prefixes in this source.`,
          vscode.DiagnosticSeverity.Error,
        );
        diagnostic.source = DIAGNOSTIC_SOURCE;
        diagnostic.code = "$";
        return { diagnostic_did: [diagnostic], keepLastKnownGood: true };
      }
    }

    const compiled = compileSnippetDefinitions(value);
    // Reapply the core limiter before any VS Code or log emission as a defensive boundary.
    const semanticIssue_iid = limitSemanticIssues(compiled.issue_iid);
    const diagnostic_did = semanticIssue_iid.map((issue) => {
      const diagnostic = new vscode.Diagnostic(
        issueRange(positions, root, issue),
        issue.message,
        issue.severity === "error"
          ? vscode.DiagnosticSeverity.Error
          : vscode.DiagnosticSeverity.Warning,
      );
      diagnostic.source = DIAGNOSTIC_SOURCE;
      diagnostic.code = issue.path;
      this.log(
        `[registry] ${source.uri.toString(true)} ${issue.severity}: ${issue.path}: ${issue.message}`,
      );
      return diagnostic;
    });
    if (semanticIssue_iid.some((issue) => issue.severity === "error")) {
      this.log(
        `[registry] ${source.uri.toString(true)} has semantic errors; keeping last-known-good snippets.`,
      );
      return { diagnostic_did, keepLastKnownGood: true };
    }

    const sourceScopeMetrics = measureSourceScopeMetrics(compiled.snippet_sid);
    if (sourceScopeMetrics.status !== "ok") {
      const message = sourceScopeMetrics.status === "scopeIdLimitExceeded"
        ? `Snippet file defines more than ${MAX_SCOPE_IDS_PER_SOURCE} non-empty comma-separated scope IDs, counted before deduplication; reduce scopes in this source.`
        : sourceScopeMetrics.status === "scopeTextLimitExceeded"
          ? `Snippet file scope strings exceed ${MAX_SCOPE_TEXT_LENGTH_PER_SOURCE} aggregate UTF-16 code units; reduce scopes in this source.`
          : "Snippet file scopes could not be measured safely; reduce or correct scopes in this source.";
      const diagnostic = new vscode.Diagnostic(
        positions.wholeDocumentRange(),
        message,
        vscode.DiagnosticSeverity.Error,
      );
      diagnostic.source = DIAGNOSTIC_SOURCE;
      diagnostic.code = "$";
      this.log(
        `[registry] ${source.uri.toString(true)} exceeds source scope limits; keeping last-known-good snippets.`,
      );
      return { diagnostic_did: [diagnostic], keepLastKnownGood: true };
    }

    const snippet_sid: RegisteredSnippet[] = compiled.snippet_sid.map((snippet) => {
      const normalized = normalizeCompiledSnippet(snippet);
      return {
        name: snippet.name,
        compiled: snippet,
        prefix_pid: normalized.prefix_pid,
        scope_lid: normalized.scope_lid,
        source,
      };
    });
    const conflictExhaustionDiagnostic = this.addDuplicatePrefixDiagnostics(
      positions,
      root,
      snippet_sid,
      diagnostic_did,
    );
    if (conflictExhaustionDiagnostic !== undefined) {
      this.log(
        `[registry] ${source.uri.toString(true)} exceeds duplicate-prefix indexing limits; keeping last-known-good snippets.`,
      );
      return { diagnostic_did: [conflictExhaustionDiagnostic], keepLastKnownGood: true };
    }
    this.log(
      `[registry] Loaded ${snippet_sid.length} snippet(s) from ${sourceLabel(source)} source ${source.uri.toString(true)}.`,
    );
    return {
      snapshot: { source, snippet_sid },
      diagnostic_did,
      keepLastKnownGood: false,
    };
  }

  private addDuplicatePrefixDiagnostics(
    positions: TextPositionIndex,
    root: JsonNode | undefined,
    snippet_sid: readonly RegisteredSnippet[],
    diagnostic_did: vscode.Diagnostic[],
  ): vscode.Diagnostic | undefined {
    const result = indexDuplicatePrefixConflicts(
      snippet_sid,
      MAX_DUPLICATE_PREFIX_WARNINGS,
    );
    if (result.status === "exhausted") {
      const message = result.reason === "workLimit"
        ? `Duplicate-prefix indexing exceeds the limit of ${MAX_DUPLICATE_PREFIX_WORK_UNITS} work units; reduce prefixes or scopes in this source.`
        : "Duplicate-prefix indexing received invalid or oversized normalized scopes; correct scopes in this source.";
      const diagnostic = new vscode.Diagnostic(
        positions.wholeDocumentRange(),
        message,
        vscode.DiagnosticSeverity.Error,
      );
      diagnostic.source = DIAGNOSTIC_SOURCE;
      diagnostic.code = "$";
      return diagnostic;
    }
    for (const conflict of result.conflict_cid) {
      const snippet = snippet_sid[conflict.snippetIndex];
      const node = snippet === undefined || root === undefined
        ? undefined
        : findNodeAtLocation(root, [snippet.name]);
      const diagnostic = new vscode.Diagnostic(
        node === undefined
          ? positions.wholeDocumentRange()
          : positions.rangeAt(node.offset, node.length),
        `Prefix ${JSON.stringify(conflict.prefix)} is also provided by snippet ${JSON.stringify(conflict.conflictingSnippetName)} in an overlapping scope.`,
        vscode.DiagnosticSeverity.Warning,
      );
      diagnostic.source = DIAGNOSTIC_SOURCE;
      diagnostic_did.push(diagnostic);
    }
    if (result.omittedCount > 0) {
      const diagnostic = new vscode.Diagnostic(
        positions.wholeDocumentRange(),
        `${result.omittedCount} additional duplicate-prefix warning(s) omitted after the limit of ${MAX_DUPLICATE_PREFIX_WARNINGS}.`,
        vscode.DiagnosticSeverity.Warning,
      );
      diagnostic.source = DIAGNOSTIC_SOURCE;
      diagnostic_did.push(diagnostic);
    }
    return undefined;
  }

  private async createFileIfAbsent(uri: vscode.Uri): Promise<void> {
    try {
      await vscode.workspace.fs.stat(uri);
      return;
    } catch (error: unknown) {
      if (!isFileNotFound(error)) {
        throw error;
      }
    }

    const parent = vscode.Uri.joinPath(uri, "..");
    await vscode.workspace.fs.createDirectory(parent);
    const temporaryUri = vscode.Uri.joinPath(
      parent,
      `.${path.posix.basename(uri.path)}.${randomUUID()}.tmp`,
    );
    let temporaryFileMayExist = true;
    try {
      await vscode.workspace.fs.writeFile(
        temporaryUri,
        new TextEncoder().encode(INITIAL_FILE_CONTENT),
      );
      try {
        await vscode.workspace.fs.rename(temporaryUri, uri, { overwrite: false });
        temporaryFileMayExist = false;
      } catch (renameError: unknown) {
        // Another creator may have won the atomic rename; preserve its file.
        try {
          await vscode.workspace.fs.stat(uri);
        } catch {
          throw renameError;
        }
      }
    } finally {
      if (temporaryFileMayExist) {
        try {
          await vscode.workspace.fs.delete(temporaryUri);
        } catch {
          // Best-effort cleanup must not hide the create/rename result.
        }
      }
    }
    this.scheduleReload();
  }

  private log(message: string): void {
    if (!this.disposed) {
      this.output.appendLine(message);
    }
  }

  private fireDidChange(): void {
    if (!this.disposed) {
      this.changeEmitter.fire();
    }
  }

  private async showFile(uri: vscode.Uri): Promise<void> {
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document);
  }

  private async selectWorkspaceFolder(): Promise<vscode.WorkspaceFolder | undefined> {
    const folder_fid = vscode.workspace.workspaceFolders ?? [];
    if (folder_fid.length === 0) {
      return undefined;
    }
    if (folder_fid.length === 1) {
      return folder_fid[0];
    }
    const picked = await vscode.window.showQuickPick(
      folder_fid.map((folder) => ({
        label: folder.name,
        description: folder.uri.toString(true),
        folder,
      })),
      { placeHolder: "Select the workspace folder for Smart Snippets" },
    );
    return picked?.folder;
  }
}
