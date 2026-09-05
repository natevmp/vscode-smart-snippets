export const MAX_PAD_TARGET_WIDTH = 10_000;
export const MAX_PREFIXES_PER_SNIPPET = 32;
export const MAX_SNIPPET_PREFIX_LENGTH = 256;
export const MAX_SNIPPET_BODY_LENGTH = 100_000;
export const MAX_SNIPPET_BODY_LINES = 1_000;

export interface PadConfiguration {
  readonly fill: string;
  readonly targetWidth: number;
}

export interface SnippetDefinition {
  readonly prefix: string | readonly string[];
  readonly body: string | readonly string[];
  readonly description?: string;
  readonly scope?: string | readonly string[];
  readonly pad?: PadConfiguration;
}

export interface NamedSnippetDefinition {
  readonly name: string;
  readonly definition: SnippetDefinition;
}

export type IssueSeverity = "error" | "warning";

export interface SnippetIssue {
  readonly severity: IssueSeverity;
  readonly snippetName?: string;
  readonly path: string;
  readonly message: string;
}

export interface ParsedSnippets {
  readonly snippet_sid: readonly NamedSnippetDefinition[];
  readonly issue_iid: readonly SnippetIssue[];
}

export interface CompiledPadMetadata extends PadConfiguration {
  readonly kind: "pad";
  /** UTF-16 offset in the compiled body at which generated text is inserted. */
  readonly offset: number;
  readonly driverTabstop: number;
}

export interface CompiledSnippet {
  readonly name: string;
  readonly prefix: string | readonly string[];
  readonly body: string;
  readonly description?: string;
  readonly scope?: string | readonly string[];
  readonly pad?: CompiledPadMetadata;
}

export interface CompiledSnippets {
  readonly snippet_sid: readonly CompiledSnippet[];
  readonly issue_iid: readonly SnippetIssue[];
}
