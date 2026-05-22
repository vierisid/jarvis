/**
 * `replace` action: substitute matches of a regex with a replacement
 * string. The replacement honors JavaScript's standard `$1`, `$2`,
 * ... capture-group references and `$&` for the full match.
 *
 * Returns `{ result: string, count: number }`. `count` is the number
 * of substitutions performed (useful for downstream routing on
 * "did anything change?").
 */

import { createAction, Property } from "@activepieces/pieces-framework";

export const replaceAction = createAction({
  name: "replace",
  displayName: "Replace",
  description: "Substitute regex matches in a string with a replacement (supports $1 / $& back-references).",
  outputSample: {
    result: "Hello, ALICE -- welcome.",
    count: 1,
  },
  props: {
    text: Property.LongText({
      displayName: "Text",
      description: "The input string.",
      required: true,
    }),
    pattern: Property.ShortText({
      displayName: "Pattern",
      description:
        "JavaScript regex. With `g` flag (added automatically), every match is replaced; without, only the first.",
      required: true,
    }),
    replacement: Property.LongText({
      displayName: "Replacement",
      description:
        "Replacement string. Use $1 / $2 to reference capture groups, $& for the full match. Empty string deletes the matches.",
      required: false,
    }),
    flags: Property.ShortText({
      displayName: "Flags",
      description:
        "Optional regex flags (i / m / s / u). The `g` flag is added automatically -- pass an empty value to disable global replace by setting just the modifiers you want.",
      required: false,
    }),
    onlyFirst: Property.Checkbox({
      displayName: "Replace only the first match",
      description: "When ON, drop the `g` flag so only the first match is replaced.",
      required: false,
      defaultValue: false,
    }),
  },
  async run(context) {
    const text = context.propsValue["text"];
    const pattern = context.propsValue["pattern"];
    const replacement = (context.propsValue["replacement"] ?? "") as string;
    const userFlags = (context.propsValue["flags"] ?? "") as string;
    const onlyFirst = context.propsValue["onlyFirst"] === true;
    if (typeof text !== "string") throw new Error("regex.replace: text must be a string");
    if (typeof pattern !== "string" || pattern.length === 0) {
      throw new Error("regex.replace: pattern is required and must be a non-empty string");
    }
    // Default to global replace; `onlyFirst` drops the `g` flag.
    let flags = userFlags;
    if (!onlyFirst && !flags.includes("g")) flags += "g";
    if (onlyFirst) flags = flags.replace(/g/g, "");
    let re: RegExp;
    try {
      re = new RegExp(pattern, flags);
    } catch (e) {
      throw new Error(`regex.replace: invalid pattern -- ${(e as Error).message}`);
    }
    // Count substitutions by iterating matchAll before performing the
    // replace -- String.replace doesn't surface a count directly. The
    // double pass is O(text length); negligible for typical input.
    const countRe = new RegExp(pattern, flags.includes("g") ? flags : flags + "g");
    let count = 0;
    for (const _m of text.matchAll(countRe)) {
      void _m;
      count++;
      if (onlyFirst) break;
    }
    const result = text.replace(re, replacement);
    return { result, count };
  },
});
