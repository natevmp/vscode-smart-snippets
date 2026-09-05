import { MAX_PAD_TARGET_WIDTH, type PadConfiguration } from "./types.js";

export interface PadEvaluationInput {
  readonly lineText: string;
  readonly generatedStart: number;
  readonly generatedEnd: number;
  readonly previousGeneratedText: string;
  readonly config: PadConfiguration;
}

export interface PadEvaluationSuccess {
  readonly ok: true;
  readonly replacement: string;
  readonly resultingLineLength: number;
  readonly overflow: boolean;
}

export type PadEvaluationFailureReason =
  | "invalid-config"
  | "invalid-range"
  | "generated-text-mismatch";

export interface PadEvaluationFailure {
  readonly ok: false;
  readonly reason: PadEvaluationFailureReason;
  readonly message: string;
}

export type PadEvaluationResult = PadEvaluationSuccess | PadEvaluationFailure;

function validConfig(config: PadConfiguration): boolean {
  return config.fill.length === 1
    && !/[\r\n\t]/u.test(config.fill)
    && Number.isInteger(config.targetWidth)
    && config.targetWidth > 0
    && config.targetWidth <= MAX_PAD_TARGET_WIDTH;
}

export function evaluatePad(input: PadEvaluationInput): PadEvaluationResult {
  if (!validConfig(input.config)) {
    return { ok: false, reason: "invalid-config", message: "Pad configuration is invalid." };
  }
  if (!Number.isInteger(input.generatedStart)
    || !Number.isInteger(input.generatedEnd)
    || input.generatedStart < 0
    || input.generatedEnd < input.generatedStart
    || input.generatedEnd > input.lineText.length) {
    return { ok: false, reason: "invalid-range", message: "Generated range is outside the line." };
  }

  const currentGeneratedText = input.lineText.slice(input.generatedStart, input.generatedEnd);
  if (currentGeneratedText !== input.previousGeneratedText) {
    return {
      ok: false,
      reason: "generated-text-mismatch",
      message: "Generated range no longer contains the previously generated text.",
    };
  }

  const baseLength = input.lineText.length - currentGeneratedText.length;
  const requiredLength = input.config.targetWidth - baseLength;
  const overflow = requiredLength < 0;
  const replacement = overflow ? "" : input.config.fill.repeat(requiredLength);
  return {
    ok: true,
    replacement,
    resultingLineLength: baseLength + replacement.length,
    overflow,
  };
}
