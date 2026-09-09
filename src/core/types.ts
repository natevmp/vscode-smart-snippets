export const MAX_PAD_TARGET_WIDTH = 10_000;
export const MAX_PADS_PER_SNIPPET = 128;
export const MAX_NAMED_PAD_CONFIGURATIONS = 128;
export const MAX_SNIPPET_NAME_LENGTH = 256;
export const MAX_SNIPPET_DEFINITION_PROPERTIES = 16;
export const MAX_PAD_CONFIGURATION_PROPERTIES = 8;
export const MAX_PREFIXES_PER_SNIPPET = 32;
export const MAX_SNIPPET_PREFIX_LENGTH = 256;
export const MAX_SNIPPET_BODY_LENGTH = 100_000;
export const MAX_SNIPPET_BODY_LINES = 1_000;
export const MAX_SCOPE_IDS_PER_SNIPPET = 256;
export const MAX_SCOPE_TEXT_LENGTH_PER_SNIPPET = 4_096;
export const MAX_SEMANTIC_ISSUES_PER_SOURCE = 100;
export const MAX_SEMANTIC_ISSUE_TEXT_LENGTH = 65_536;
export const MAX_ISSUE_PATH_LENGTH = 512;
export const MAX_ISSUE_MESSAGE_LENGTH = 1_024;
export const MAX_ISSUE_PATH_SEGMENT_LENGTH = 256;

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
  readonly pads?: Readonly<Record<string, PadConfiguration>>;
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
  readonly configurationName?: string;
}

export interface CompiledSnippet {
  readonly name: string;
  readonly prefix: string | readonly string[];
  readonly body: string;
  readonly description?: string;
  readonly scope?: string | readonly string[];
  readonly pad_pid?: readonly CompiledPadMetadata[];
}

export interface CompiledSnippets {
  readonly snippet_sid: readonly CompiledSnippet[];
  readonly issue_iid: readonly SnippetIssue[];
}
