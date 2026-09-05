import { findDynamicPadTokens, findNumericTabstops } from "./syntax.js";
import type {
  CompiledSnippet,
  CompiledSnippets,
  NamedSnippetDefinition,
  SnippetIssue,
} from "./types.js";
import { parseSnippetDefinitions } from "./validation.js";

export interface CompileSnippetResult {
  readonly snippet?: CompiledSnippet;
  readonly issue_iid: readonly SnippetIssue[];
}

function compilerIssue(snippet: NamedSnippetDefinition, message: string): SnippetIssue {
  return {
    severity: "error",
    snippetName: snippet.name,
    path: `$[${JSON.stringify(snippet.name)}].body`,
    message,
  };
}

function compileNativeOnly(snippet: NamedSnippetDefinition, body: string): CompiledSnippet {
  const { definition } = snippet;
  return {
    name: snippet.name,
    prefix: definition.prefix,
    body,
    ...(definition.description === undefined ? {} : { description: definition.description }),
    ...(definition.scope === undefined ? {} : { scope: definition.scope }),
  };
}

export function compileSnippet(snippet: NamedSnippetDefinition): CompileSnippetResult {
  const { definition } = snippet;
  const body = typeof definition.body === "string" ? definition.body : definition.body.join("\n");
  const pad_tid = findDynamicPadTokens(body);

  if (pad_tid.length === 0) {
    return { snippet: compileNativeOnly(snippet, body), issue_iid: [] };
  }
  if (pad_tid.length > 1) {
    return {
      issue_iid: [compilerIssue(snippet, "MVP snippets may contain at most one unescaped ${pad} token.")],
    };
  }
  if (definition.pad === undefined) {
    return {
      issue_iid: [compilerIssue(snippet, "${pad} requires a valid pad configuration.")],
    };
  }

  const padToken = pad_tid[0];
  if (padToken === undefined) {
    throw new Error("Expected one pad token.");
  }
  const tabstop_tid = findNumericTabstops(body);
  const driver = tabstop_tid.find((tabstop) => tabstop.end === padToken.start);
  if (driver === undefined || driver.number === 0) {
    return {
      issue_iid: [compilerIssue(
        snippet,
        "${pad} must immediately follow a positive numeric tab stop such as $1, ${1}, ${1:default}, or ${1|choice|}.",
      )],
    };
  }

  const editable_tid = tabstop_tid.filter((tabstop) => tabstop.number > 0);
  const firstNumber = editable_tid.reduce(
    (minimum, tabstop) => Math.min(minimum, tabstop.number),
    Number.POSITIVE_INFINITY,
  );
  if (driver.number !== firstNumber) {
    return {
      issue_iid: [compilerIssue(snippet, "${pad} must follow the first editable numeric tab stop.")],
    };
  }
  if (editable_tid.filter((tabstop) => tabstop.number === driver.number).length !== 1) {
    return {
      issue_iid: [compilerIssue(snippet, "The tab stop driving ${pad} must occur exactly once.")],
    };
  }

  const compiled: CompiledSnippet = {
    ...compileNativeOnly(snippet, body.slice(0, padToken.start) + body.slice(padToken.end)),
    pad: {
      kind: "pad",
      offset: padToken.start,
      driverTabstop: driver.number,
      fill: definition.pad.fill,
      targetWidth: definition.pad.targetWidth,
    },
  };
  return { snippet: compiled, issue_iid: [] };
}

/** Validates and compiles all usable snippets, retaining issues for rejected entries. */
export function compileSnippetDefinitions(value: unknown): CompiledSnippets {
  const parsed = parseSnippetDefinitions(value);
  const snippet_sid: CompiledSnippet[] = [];
  const issue_iid: SnippetIssue[] = [...parsed.issue_iid];

  for (const snippet of parsed.snippet_sid) {
    const result = compileSnippet(snippet);
    issue_iid.push(...result.issue_iid);
    if (result.snippet !== undefined) {
      snippet_sid.push(result.snippet);
    }
  }
  return { snippet_sid, issue_iid };
}
