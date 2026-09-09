import {
  MAX_ISSUE_MESSAGE_LENGTH,
  MAX_ISSUE_PATH_LENGTH,
  MAX_ISSUE_PATH_SEGMENT_LENGTH,
  MAX_SEMANTIC_ISSUES_PER_SOURCE,
  MAX_SEMANTIC_ISSUE_TEXT_LENGTH,
  type SnippetIssue,
} from "./types.js";

const ELLIPSIS = "…";
// Reserving the maximum possible message leaves room regardless of the omitted count.
const OMISSION_SUMMARY_RESERVE = MAX_ISSUE_MESSAGE_LENGTH + 1;

function boundedText(value: string, maximumLength: number): string {
  if (value.length <= maximumLength) {
    return value;
  }
  if (maximumLength <= ELLIPSIS.length) {
    return ELLIPSIS.slice(0, maximumLength);
  }
  return `${value.slice(0, maximumLength - ELLIPSIS.length)}${ELLIPSIS}`;
}

export function boundIssuePathSegment(segment: string): string {
  return boundedText(segment, MAX_ISSUE_PATH_SEGMENT_LENGTH);
}

export function quoteIssuePathSegment(segment: string): string {
  return JSON.stringify(boundIssuePathSegment(segment));
}

export function boundIssuePath(path: string): string {
  return boundedText(path, MAX_ISSUE_PATH_LENGTH);
}

export function boundIssueMessage(message: string): string {
  return boundedText(message, MAX_ISSUE_MESSAGE_LENGTH);
}

export function createBoundedSnippetIssue(issue: SnippetIssue): SnippetIssue {
  return {
    severity: issue.severity,
    ...(issue.snippetName === undefined ? {} : { snippetName: issue.snippetName }),
    path: boundIssuePath(issue.path),
    message: boundIssueMessage(issue.message),
  };
}

function incrementCount(count: number): number {
  return count >= Number.MAX_SAFE_INTEGER ? Number.MAX_SAFE_INTEGER : count + 1;
}

/** Retains a bounded prefix of semantic issues and fails closed for omitted errors. */
export class SemanticIssueCollector {
  private readonly detail_iid: SnippetIssue[] = [];
  private retainedTextLength = 0;
  private omittedCount = 0;
  private omittedError = false;
  private acceptingDetails = true;
  private anyError = false;

  public add(issue: SnippetIssue): void {
    if (issue.severity === "error") {
      this.anyError = true;
    }
    if (!this.acceptingDetails) {
      this.omit(issue);
      return;
    }

    const boundedIssue = createBoundedSnippetIssue(issue);
    const textLength = boundedIssue.path.length + boundedIssue.message.length;
    const detailLimit = MAX_SEMANTIC_ISSUES_PER_SOURCE - 1;
    const textLimit = MAX_SEMANTIC_ISSUE_TEXT_LENGTH - OMISSION_SUMMARY_RESERVE;
    if (this.detail_iid.length >= detailLimit
      || this.retainedTextLength + textLength > textLimit) {
      this.acceptingDetails = false;
      this.omit(boundedIssue);
      return;
    }

    this.detail_iid.push(boundedIssue);
    this.retainedTextLength += textLength;
  }

  public addAll(issue_iid: readonly SnippetIssue[]): void {
    for (const issue of issue_iid) {
      this.add(issue);
    }
  }

  public hasErrors(): boolean {
    return this.anyError;
  }

  public toArray(): readonly SnippetIssue[] {
    if (this.omittedCount === 0) {
      return [...this.detail_iid];
    }
    const summary = createBoundedSnippetIssue({
      severity: this.omittedError ? "error" : "warning",
      path: "$",
      message: `${this.omittedCount} additional semantic issue(s) omitted because the source diagnostic budget was reached.`,
    });
    return [...this.detail_iid, summary];
  }

  private omit(issue: SnippetIssue): void {
    this.omittedCount = incrementCount(this.omittedCount);
    if (issue.severity === "error") {
      this.omittedError = true;
    }
  }
}

/** Applies the semantic issue budget to an arbitrary issue list. */
export function limitSemanticIssues(issue_iid: readonly SnippetIssue[]): readonly SnippetIssue[] {
  if (issue_iid.length <= MAX_SEMANTIC_ISSUES_PER_SOURCE) {
    const boundedIssue_iid = issue_iid.map(createBoundedSnippetIssue);
    const textLength = boundedIssue_iid.reduce(
      (length, issue) => length + issue.path.length + issue.message.length,
      0,
    );
    if (textLength <= MAX_SEMANTIC_ISSUE_TEXT_LENGTH) {
      return boundedIssue_iid;
    }
  }
  const collector = new SemanticIssueCollector();
  collector.addAll(issue_iid);
  return collector.toArray();
}
