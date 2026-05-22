/**
 * `extract` action: return EVERY match of a regex in a string,
 * including capture groups per match.
 *
 * Output is a bare array so a downstream LOOP_ON_ITEMS can iterate
 * one match at a time -- the picker labels this as "(N items)" and
 * the loop body can reference `{{loop.item.full}}` /
 * `{{loop.item.groups[0]}}` per element.
 *
 * For a single-match boolean test use `match`. For substitution use
 * `replace`.
 */

import { createAction, Property } from "@activepieces/pieces-framework";

export const extractAction = createAction({
  name: "extract",
  displayName: "Extract",
  description:
    "Return every match of a regex in a string, with capture groups per match. Suitable as a LOOP_ON_ITEMS source.",
  outputSample: [
    { full: "Order #123", groups: ["123"] },
    { full: "Order #456", groups: ["456"] },
  ],
  props: {
    text: Property.LongText({
      displayName: "Text",
      description: "The input string to scan.",
      required: true,
    }),
    pattern: Property.ShortText({
      displayName: "Pattern",
      description:
        "JavaScript regex. The `g` flag is enforced -- every match is returned, not just the first one.",
      required: true,
    }),
    flags: Property.ShortText({
      displayName: "Flags",
      description: "Optional regex flags (i / m / s / u). The `g` flag is added automatically.",
      required: false,
    }),
  },
  async run(context) {
    const text = context.propsValue["text"];
    const pattern = context.propsValue["pattern"];
    const userFlags = (context.propsValue["flags"] ?? "") as string;
    if (typeof text !== "string") throw new Error("regex.extract: text must be a string");
    if (typeof pattern !== "string" || pattern.length === 0) {
      throw new Error("regex.extract: pattern is required and must be a non-empty string");
    }
    // Force the `g` flag so `matchAll` returns every match. The user's
    // own flags are merged with `g` deduplicated.
    const flags = userFlags.includes("g") ? userFlags : userFlags + "g";
    let re: RegExp;
    try {
      re = new RegExp(pattern, flags);
    } catch (e) {
      throw new Error(`regex.extract: invalid pattern -- ${(e as Error).message}`);
    }
    const out: Array<{ full: string; groups: string[] }> = [];
    for (const m of text.matchAll(re)) {
      out.push({ full: m[0], groups: m.slice(1) });
    }
    // Return the bare array (matching the outputSample shape). The
    // editor's variable picker reads array outputs as iterable for
    // LOOP_ON_ITEMS, which is the intended downstream pattern here.
    return out;
  },
});
