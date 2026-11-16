import type { AppConnectionType } from "../db/repos/app-connection";

/**
 * What a new connection's name, id, type and piece may be, checked when one is
 * added through the API. Rows saved before these rules keep loading and
 * showing as they are; only a new row is held to them.
 */
export const CONNECTION_NAME_MAX_CHARS = 200;
export const CONNECTION_EXTERNAL_ID_MAX_CHARS = 200;

export const CONNECTION_TYPES: readonly AppConnectionType[] = [
  "OAUTH2",
  "PLATFORM_OAUTH2",
  "CLOUD_OAUTH2",
  "SECRET_TEXT",
  "BASIC_AUTH",
  "CUSTOM_AUTH",
  "NO_AUTH",
];

/**
 * Control characters, line and paragraph separators, the characters that
 * reorder how text reads (bidi marks, embeddings, overrides, isolates), and the
 * invisible ones that make two ids look the same (zero-width space, word
 * joiner, BOM). Zero-width joiner and non-joiner stay allowed: emoji and some
 * scripts need them. Written as escapes so the source stays plain ASCII.
 */
const CONTROL_OR_BIDI = /[\p{Cc}\p{Zl}\p{Zp}\u061C\u200B\u200E\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/u;
const RESERVED_IDS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

function textProblem(value: string, label: string, max: number): string | null {
  if (value.trim().length === 0) return `${label} cannot be blank`;
  if (value.length > max) return `${label} must be at most ${max} characters`;
  if (CONTROL_OR_BIDI.test(value)) return `${label} cannot contain control, line-separator, text-direction or invisible characters`;
  return null;
}

/** A plain refusal sentence for a new connection's fields, or null when they are fine. */
export function refuseConnectionFields(input: {
  externalId: string;
  displayName: string;
  type: unknown;
  pieceName: string;
  isKnownPiece?: (pieceName: string) => boolean;
}): string | null {
  const problem =
    textProblem(input.displayName, "The connection name", CONNECTION_NAME_MAX_CHARS) ??
    textProblem(input.externalId, "The external id", CONNECTION_EXTERNAL_ID_MAX_CHARS);
  if (problem) return problem;
  if (RESERVED_IDS.has(input.externalId)) return `"${input.externalId}" cannot be used as an external id. Choose another.`;
  if (!CONNECTION_TYPES.includes(input.type as AppConnectionType)) {
    return `type must be one of ${CONNECTION_TYPES.join(", ")}`;
  }
  if (CONTROL_OR_BIDI.test(input.pieceName)) return "pieceName is not a piece Jarvis knows";
  if (input.isKnownPiece && !input.isKnownPiece(input.pieceName)) {
    return `"${input.pieceName.slice(0, 80)}" is not a piece Jarvis knows. Pick one from the Library.`;
  }
  return null;
}
