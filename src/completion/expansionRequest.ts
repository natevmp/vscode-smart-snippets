export interface RequestedExactExpansion {
  readonly snippetName: string;
  readonly sourceUri: string;
  readonly prefix: string;
  readonly targetDocumentUri: string;
}

export interface ExpandAtPrefixCommandOptions {
  readonly requestValid: boolean;
  readonly requestedSnippet?: RequestedExactExpansion;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function hasOwnDataProperty(value: Record<string, unknown>, property: string): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(value, property);
  return descriptor !== undefined && "value" in descriptor;
}

export function parseExpandAtPrefixOptions(value: unknown): ExpandAtPrefixCommandOptions {
  try {
    if (value === undefined) {
      return { requestValid: true };
    }
    if (!isPlainRecord(value)) {
      return { requestValid: false };
    }
    const requestedDescriptor = Object.getOwnPropertyDescriptor(value, "requestedSnippet");
    if (requestedDescriptor !== undefined && !("value" in requestedDescriptor)) {
      return { requestValid: false };
    }
    const requested = requestedDescriptor?.value as unknown;
    const requestedSnippet = isPlainRecord(requested)
      && ["snippetName", "sourceUri", "prefix", "targetDocumentUri"]
        .every((property) => hasOwnDataProperty(requested, property))
      && typeof requested.snippetName === "string"
      && requested.snippetName.length > 0
      && typeof requested.sourceUri === "string"
      && requested.sourceUri.length > 0
      && typeof requested.prefix === "string"
      && requested.prefix.length > 0
      && typeof requested.targetDocumentUri === "string"
      && requested.targetDocumentUri.length > 0
        ? {
            snippetName: requested.snippetName,
            sourceUri: requested.sourceUri,
            prefix: requested.prefix,
            targetDocumentUri: requested.targetDocumentUri,
          }
        : undefined;
    const requestValid = requested === undefined || requestedSnippet !== undefined;
    return {
      requestValid,
      ...(requestedSnippet === undefined ? {} : { requestedSnippet }),
    };
  } catch {
    return { requestValid: false };
  }
}
