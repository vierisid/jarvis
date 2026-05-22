/**
 * `match` action: test whether a string matches a JavaScript regex.
 *
 * Returns `{ matched: boolean, groups: string[] }` where `groups`
 * holds the capture groups from the FIRST match (empty when the regex
 * doesn't capture or doesn't match). For multi-match across the
 * input, use `extract` instead -- it returns every match.
 */

import { createAction, Property } from "@activepieces/pieces-framework";

export const matchAction = createAction({
  name: "match",
  displayName: "Match",
  description: "Test whether a string matches a regex pattern. Returns matched + first-match groups.",
  outputSample: {
    matched: true,
    groups: ["123", "Alice"],
  },
  props: {
    text: Property.LongText({
      displayName: "Text",
      description: "The input string. Often a step output template like {{step.body}}.",
      required: true,
    }),
    pattern: Property.ShortText({
      displayName: "Pattern",
      description:
        "JavaScript regex. Use parentheses to capture groups. Anchors / flags are inline (e.g. (?i) for case-insensitive).",
      required: true,
    }),
    flags: Property.ShortText({
      displayName: "Flags",
      description: "Optional regex flags string (i / m / s / u). Leave empty for default.",
      required: false,
    }),
  },
  async run(context) {
    const text = context.propsValue["text"];
    const pattern = context.propsValue["pattern"];
    const flags = context.propsValue["flags"] ?? "";
    if (typeof text !== "string") throw new Error("regex.match: text must be a string");
    if (typeof pattern !== "string" || pattern.length === 0) {
      throw new Error("regex.match: pattern is required and must be a non-empty string");
    }
    let re: RegExp;
    try {
      re = new RegExp(pattern, typeof flags === "string" ? flags : "");
    } catch (e) {
      throw new Error(`regex.match: invalid pattern -- ${(e as Error).message}`);
    }
    const m = re.exec(text);
    if (!m) return { matched: false, groups: [] };
    // m[0] is the full match; m[1..] are the capture groups. We
    // surface only the groups so downstream wiring `{{step.groups[0]}}`
    // points at the first captured value, not the whole match.
    return { matched: true, groups: m.slice(1) };
  },
});
