import {
  analyzeSnippetSyntax,
  hasAdjacentDistinctNumericTabstopGroups,
  hasLoneCarriageReturn,
  numericTabstopsContainLineBreak,
  type DynamicPadToken,
  type NumericTabstop,
} from "./syntax.js";
import {
  MAX_PADS_PER_SNIPPET,
  type CompiledPadMetadata,
  type PadConfiguration,
  type CompiledSnippet,
  type CompiledSnippets,
  type NamedSnippetDefinition,
  type SnippetIssue,
} from "./types.js";
import {
  createBoundedSnippetIssue,
  quoteIssuePathSegment,
  SemanticIssueCollector,
} from "./issueBudget.js";
import { parseSnippetDefinitions } from "./validation.js";

export interface CompileSnippetResult {
  readonly snippet?: CompiledSnippet;
  readonly issue_iid: readonly SnippetIssue[];
}

function compilerIssue(snippet: NamedSnippetDefinition, message: string): SnippetIssue {
  return createBoundedSnippetIssue({
    severity: "error",
    snippetName: snippet.name,
    path: `$[${quoteIssuePathSegment(snippet.name)}].body`,
    message,
  });
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
  const syntax = analyzeSnippetSyntax(body);
  const { pad_tid } = syntax;
  const hasPadConfiguration = definition.pad !== undefined || definition.pads !== undefined;

  if (pad_tid.length > 0 && hasLoneCarriageReturn(body)) {
    return {
      issue_iid: [compilerIssue(
        snippet,
        "Lone CR line breaks are not supported in dynamic snippets; use LF or CRLF instead.",
      )],
    };
  }
  if (hasPadConfiguration && syntax.numericPad_tid.length > 0) {
    return {
      issue_iid: [compilerIssue(
        snippet,
        "Numeric ${pad:...} forms are reserved; named pad tokens must use a name matching [A-Za-z_][A-Za-z0-9_-]{0,63}.",
      )],
    };
  }
  if (pad_tid.length === 0) {
    return { snippet: compileNativeOnly(snippet, body), issue_iid: [] };
  }
  if (syntax.choice_tid.length > 0) {
    return {
      issue_iid: [compilerIssue(
        snippet,
        "Numeric choices are not supported in dynamic snippets because choice UI navigation cannot be safely observed.",
      )],
    };
  }
  if (syntax.malformed) {
    return {
      issue_iid: [compilerIssue(
        snippet,
        "Dynamic snippets must use well-formed VS Code placeholder, variable, choice, and transform syntax.",
      )],
    };
  }
  if (pad_tid.length > MAX_PADS_PER_SNIPPET) {
    return {
      issue_iid: [compilerIssue(
        snippet,
        `A snippet may contain at most ${MAX_PADS_PER_SNIPPET} active pad tokens.`,
      )],
    };
  }
  if (syntax.variable_vid.length > 0) {
    return {
      issue_iid: [compilerIssue(
        snippet,
        "Native variables are not supported in dynamic snippets; use numeric placeholders or numeric transforms instead.",
      )],
    };
  }
  const { tabstop_tid } = syntax;
  if (tabstop_tid.some((tabstop) => !Number.isSafeInteger(tabstop.number))) {
    return {
      issue_iid: [compilerIssue(snippet, "Numeric tab stop identifiers must be safe positive integers.")],
    };
  }
  if (numericTabstopsContainLineBreak(body, tabstop_tid)) {
    return {
      issue_iid: [compilerIssue(
        snippet,
        "Actual CR or LF characters inside numeric tab stop spans are not supported in dynamic snippets because rendered pad lines cannot be mapped safely.",
      )],
    };
  }
  if (hasAdjacentDistinctNumericTabstopGroups(tabstop_tid)) {
    return {
      issue_iid: [compilerIssue(
        snippet,
        "Source-adjacent top-level positive numeric tab stops with different identifiers are not supported in dynamic snippets because coincident group transitions cannot be observed safely.",
      )],
    };
  }
  if (tabstop_tid.some((tabstop) => tabstop.number > 0 && tabstop.nestingDepth > 0)) {
    return {
      issue_iid: [compilerIssue(
        snippet,
        "Positive numeric tab stops nested inside placeholder or variable defaults are not supported by dynamic snippets.",
      )],
    };
  }
  const pad_pid: CompiledPadMetadata[] = [];
  let strippedBody = "";
  let sourceOffset = 0;
  for (const padToken of pad_tid) {
    const configuration = resolvePadConfiguration(snippet, padToken);
    if (configuration === undefined) {
      const tokenText = body.slice(padToken.start, padToken.end);
      return {
        issue_iid: [compilerIssue(snippet, `${tokenText} requires a valid ${padToken.configurationName === undefined
          ? "pad"
          : `pads.${padToken.configurationName}`} configuration.`)],
      };
    }
    if (!isAtLineEnd(body, padToken.end)) {
      return {
        issue_iid: [compilerIssue(
          snippet,
          `${body.slice(padToken.start, padToken.end)} must be immediately followed by EOF, \\n, or \\r\\n.`,
        )],
      };
    }
    const driver = findDriver(tabstop_tid, body, padToken);
    if (driver === undefined) {
      return {
        issue_iid: [compilerIssue(
          snippet,
          `${body.slice(padToken.start, padToken.end)} requires a preceding positive numeric tab stop on the same source line.`,
        )],
      };
    }

    strippedBody += body.slice(sourceOffset, padToken.start);
    pad_pid.push({
      kind: "pad",
      offset: strippedBody.length,
      driverTabstop: driver.number,
      fill: configuration.fill,
      targetWidth: configuration.targetWidth,
      ...(padToken.configurationName === undefined
        ? {}
        : { configurationName: padToken.configurationName }),
    });
    sourceOffset = padToken.end;
  }
  strippedBody += body.slice(sourceOffset);

  const compiled: CompiledSnippet = {
    ...compileNativeOnly(snippet, strippedBody),
    pad_pid,
  };
  return { snippet: compiled, issue_iid: [] };
}

function resolvePadConfiguration(
  snippet: NamedSnippetDefinition,
  token: DynamicPadToken,
): PadConfiguration | undefined {
  if (token.configurationName === undefined) {
    return snippet.definition.pad;
  }
  const { pads } = snippet.definition;
  return pads !== undefined && Object.hasOwn(pads, token.configurationName)
    ? pads[token.configurationName]
    : undefined;
}

function isAtLineEnd(body: string, tokenEnd: number): boolean {
  return tokenEnd === body.length
    || body[tokenEnd] === "\n"
    || (body[tokenEnd] === "\r" && body[tokenEnd + 1] === "\n");
}

function findDriver(
  tabstop_tid: readonly NumericTabstop[],
  body: string,
  padToken: DynamicPadToken,
): NumericTabstop | undefined {
  const lineStart = body.lastIndexOf("\n", padToken.start - 1) + 1;
  let driver: NumericTabstop | undefined;
  for (const tabstop of tabstop_tid) {
    if (tabstop.number <= 0
      || tabstop.nestingDepth !== 0
      || tabstop.start < lineStart
      || tabstop.end > padToken.start) {
      continue;
    }
    if (driver === undefined
      || tabstop.end > driver.end
      || (tabstop.end === driver.end && tabstop.start > driver.start)) {
      driver = tabstop;
    }
  }
  return driver;
}

/** Validates and compiles all usable snippets, retaining issues for rejected entries. */
export function compileSnippetDefinitions(value: unknown): CompiledSnippets {
  const issueCollector = new SemanticIssueCollector();
  const parsed = parseSnippetDefinitions(value, issueCollector);
  const snippet_sid: CompiledSnippet[] = [];

  for (const snippet of parsed.snippet_sid) {
    const result = compileSnippet(snippet);
    issueCollector.addAll(result.issue_iid);
    if (result.snippet !== undefined) {
      snippet_sid.push(result.snippet);
    }
  }
  return { snippet_sid, issue_iid: issueCollector.toArray() };
}
