/**
 * The model-facing contract for `[POINT:x,y:label]`, the regex that enforces
 * it, and the one name for the space it lands in (#604).
 *
 * THIS TEXT IS A CONTRACT, which is why it is a module and not a string
 * literal buried in `buildPanelContext`. #604's core defect was one sentence
 * that told the model its coordinates were "virtual-screen pixels". That was
 * wrong twice over:
 *
 *   - wrong SPACE on two of three platforms. The value reaches the pebble in
 *     whatever `platformGetCursorPos()` returns, which is Cocoa points on
 *     macOS and GDK logical pixels on Linux. "Virtual-screen pixels" is
 *     Windows vocabulary;
 *   - wrong BOUNDARY everywhere, and this is the larger error. That sentence
 *     described the value the DAEMON dispatches while instructing the model
 *     what to EMIT. The model emits in the attached screenshot's pixel grid --
 *     the next paragraph said so, and the mistake list below it named emitting
 *     screen coordinates as the first thing to avoid. One section told the
 *     model to do a thing and, four lines earlier, that it was doing the
 *     opposite.
 *
 * Nothing downstream could detect either. A description that states a space
 * incorrectly makes the model's arithmetic wrong and produces a confident
 * pointer somewhere the user did not ask about, which is the single outcome
 * #585, #590 and #591 all exist to prevent.
 *
 * EXTRACTED SO IT CAN BE TESTED AT ALL. While this lived inside
 * `buildPanelContext` it was covered by nothing: `tool-description-budget.test.ts`
 * iterates the six REGISTERED tools, so neither its byte count, its ASCII, nor
 * its self-consistency was checked.
 *
 * NO IMPORTS, matching its sibling `src/daemon/pebble-narration.ts`. Not
 * load-bearing the way it is there, but a prompt fragment that needs a module
 * graph stood up to assert a sentence about it is a fragment nobody will test.
 * The OS arrives as an already-normalised argument for that reason.
 */

/**
 * The space `pebble.point_at` consumes. Named here because four producers feed
 * it and the tree had a name for exactly one of them (#604).
 *
 * NOT A WIRE TOKEN, unlike the `screen_dip` it sits beside. `screen_dip` is
 * sent in a `space` field and `readSidecarElementPoint` refuses any value it
 * does not know (src/actions/tools/sidecar-route.ts); this string is never
 * serialised and must not be put in that field, where it would be rejected. It
 * exists so that code and log lines can say which space they mean instead of
 * each inventing a phrase.
 *
 * DEFINITION: whatever `platformGetCursorPos()` returns on the sidecar drawing
 * the pebble. That is not one unit -- it is a different unit per platform -- and
 * writing it down is the point, because `pebbleCore.PointAt` stores the pair and
 * `advanceFrame` eases toward it without converting anything
 * (sidecar/pebble_runtime.go).
 *
 *   macOS    Cocoa POINTS, origin top-left. `panels_darwin.go` flips y using
 *            `[[NSScreen screens] firstObject].frame.size.height` -- note
 *            screens[0], NOT mainScreen, so on a multi-display Mac with
 *            unequal heights the origin is the first screen's corner. Points
 *            are the 1x logical space, so this equals #591's `screen_dip`.
 *   Linux    GDK LOGICAL pixels, screen-root, origin top-left, no flip
 *            (`panels_linux.go`, gdk_device_get_position).
 *   Windows  GetCursorPos under the PerMonitorV2 manifest: PHYSICAL
 *            virtual-screen pixels. The primary display's top-left is (0, 0)
 *            and a display left of or above it occupies NEGATIVE coordinates.
 *            Equals `screen_dip` at 100% DPI, off by the monitor's scale above.
 *
 * The per-platform table above is deliberately a second copy of the one at
 * sidecar/browser_element_point.go, because that one documents `screen_dip`'s
 * relationship to the pebble and this one documents the pebble's own space.
 * They agree today; if one is edited the other is wrong.
 *
 * The four producers, and what each is actually in:
 *
 *   1. This prompt's `[POINT:x,y]`, multiplied by the capture scale in
 *      `index.ts`. Lands in CAPTURE-NATIVE pixels -- not this space on macOS
 *      (backing pixels) nor on Windows above 100% DPI. Named at that multiply.
 *   2. `remoteBrowserNarration` -- `screen_dip`, named on the wire by #591 and
 *      refused brain-side if the sidecar ever renames it.
 *   3. `browserElementNarration`'s local branch -- the same `screen_dip`
 *      geometry read from this process's own browser.
 *   4. `getCachedElementBounds` for `desktop_click` -- the local platform
 *      controller's UIA/AX/xdotool rects.
 *
 * Producer 2 named itself before #604. Producers 1, 3 and 4 now cite this
 * constant at their own boundary instead of describing a space of their own.
 */
export const PEBBLE_SCREEN_SPACE = 'pebble_screen';

/**
 * The tag shape, as a pattern source rather than a regex object.
 *
 * It lives beside the text that teaches it so the two cannot drift: a reword
 * that taught a different shape would strip nothing, and the tag would leak
 * into the bubble and the spoken reply. `pebble-point-prompt.test.ts` runs this
 * pattern over the literal tags in `POINTING_GUIDANCE` for that reason.
 *
 * Source, not a shared `RegExp`: a `/g` regex object carries `lastIndex`, so
 * one shared instance across the stream loop and a test would be stateful.
 * Each caller builds its own.
 */
export const POINT_TAG_PATTERN = '\\[POINT:(-?\\d+),(-?\\d+):([^\\]\\n]{1,120})\\]';

/** A fresh global matcher for the tag. One per caller; see POINT_TAG_PATTERN. */
export function pointTagRegex(): RegExp {
  return new RegExp(POINT_TAG_PATTERN, 'g');
}

/**
 * Widest absolute coordinate the daemon will hand `pebble.point_at`.
 *
 * A MATCHED PAIR with `maxElementPointCoord` in
 * sidecar/browser_element_point.go and `MAX_ELEMENT_POINT_COORD` in
 * src/actions/tools/sidecar-route.ts, deliberately the same number. Those two
 * bound the SIDECAR-measured coordinate; this bounds the MODEL-authored one,
 * which is the less trustworthy of the two and was the only one unbounded.
 *
 * The bound is not about screen size -- nothing here can read one -- it is
 * about the sink. `pebbleCore` stores the point in an `atomic.Int32`
 * (sidecar/pebble_runtime.go), so a value that does not fit TRUNCATES, and a
 * truncated coordinate is strictly worse than a rejected one: it wraps into
 * range and the pebble settles somewhere arbitrary with the label still
 * asserting that spot is the answer. An out-of-range value would at least park
 * harmlessly off-screen.
 *
 * WHY THE DIGITS IN THE PATTERN STAY UNBOUNDED while this exists. Narrowing
 * the pattern to a few digits would make an absurd tag fail to MATCH -- and a
 * tag that does not match is not stripped, so it leaks verbatim into the
 * bubble and the spoken reply. Matching greedily and refusing at dispatch
 * keeps the text clean and the pebble still. The label is the opposite case:
 * it is bounded in the pattern (no newlines, 120 chars) because an unbounded
 * `[^\]]+` spans newlines and would swallow a paragraph of real reply text out
 * of display and TTS on an unclosed-looking tag.
 */
export const MAX_POINT_COORD = 1 << 20;

/**
 * A model-authored label, made safe to put in one line of a log.
 *
 * The dispatch log line is the audit record for a misplaced pebble -- it is
 * there so that a wrong pointer can be told apart from a model that guessed
 * badly. A label that can carry a control character can forge a second line of
 * that record, which defeats the only thing the line is for.
 *
 * The tag pattern already excludes newlines from the label, so this is defence
 * in depth for that case rather than the primary control. It is NOT redundant
 * for the rest: `[^\]\n]` still admits a carriage return, which rewrites the
 * current terminal line, and the other C0 controls.
 */
export function logSafeLabel(label: string): string {
  // eslint-disable-next-line no-control-regex
  const flattened = label.replace(/[\u0000-\u001F\u007F]+/g, ' ').trim();
  return flattened.length > 60 ? `${flattened.slice(0, 57)}...` : flattened;
}

/**
 * The OS of the machine the pebble is drawn on, already normalised.
 *
 * Normalised by the caller (`osFamily` in src/util/execution-environment.ts)
 * so this module keeps its zero imports. `null` when the sidecar reported no
 * OS or an unrecognised one, which is a real case for an offline or older
 * sidecar -- and the branch the guidance has to stay correct in.
 */
export type PointerOs = 'windows' | 'macos' | 'linux' | null;

/**
 * What the OS calls a unit of its cursor space, for the no-screenshot branch.
 *
 * This is the only branch where the model's number is dispatched UNSCALED, so
 * it is the branch where the unit matters most. With no OS known, all three
 * are named rather than one guessed -- a wrong unit here is a pointer off by
 * the display's scale factor.
 */
function cursorUnits(os: PointerOs): string {
  switch (os) {
    case 'macos': return 'logical points (NOT backing pixels - a Retina display is still about 1440 points wide, not 2880)';
    case 'linux': return 'logical pixels';
    case 'windows': return 'physical pixels';
    default: return 'the OS\'s own units (logical points on macOS, logical pixels on Linux, physical pixels on Windows)';
  }
}

/**
 * The `[POINT:..]` section of the pebble system prompt.
 *
 * One string per line, to be spread into the prompt's section list. Plain
 * ASCII throughout: this is model-facing text, and the file it came out of is
 * not ASCII-clean, so the property is pinned by the test rather than assumed.
 *
 * THE SPACE RULE IS THREE CASES, not two, and they are keyed on something the
 * model can actually see. The daemon rescales a `[POINT:..]` by
 * `orig_width / sent_width` only when `capture_screen` shrank the image
 * (sidecar/handlers.go), and `grid := compact` in that same handler means the
 * labelled grid is drawn exactly when that shrink happens. So "does the image
 * carry the grid" and "did the daemon rescale" are the same question, which is
 * what makes case 1 safe to key on the grid.
 *
 * Case 3 is the one #604 review caught and it is a REFUSAL. A T19 region
 * capture attaches a crop, and nothing records where that crop sat: the
 * Windows path BitBlts from a possibly-negative virtual-screen origin and then
 * crops at an arbitrary offset that `onCapture([]byte, int, int)` has no room
 * to carry, and `region.captured` sends only a selection id and a size. Both
 * the offset and the scale are unreported, so no frame the model could pick is
 * right. Telling it to point anyway is the confident-wrong-pointer outcome;
 * telling it to use words instead is the same fail-closed trade #585 made.
 */
export function pointingGuidance(os: PointerOs): readonly string[] {
  return [
    '# Pointing at things on the user\'s screen - REQUIRED for "where" / "show me" requests',
    '',
    'Emit a tag of the form `[POINT:<x>,<y>:<short label>]` anywhere in your reply to fly the pebble to that place on the user\'s screen. The daemon strips these tags before display + TTS, dispatches a pebble.point_at RPC, and the pebble eases to the position with the label shown in its bubble for ~3.5 seconds.',
    '',
    '**Which space to write coordinates in.** Three cases, and you can tell them apart by what you were given:',
    '',
    '  1. **A screenshot WITH the labelled coordinate grid** described below: write coordinates in that image\'s pixel grid. The daemon rescales them for you.',
    `  2. **No image at all**: write them in the user's screen space - origin (0, 0) at the top-left of their primary display, in ${cursorUnits(os)}. Nothing rescales these, so they go through exactly as you write them.`,
    '  3. **An image WITHOUT that grid** (for example a crop of a region the user selected): you CANNOT place a pointer from it. Nothing records where that crop sat on the screen, so no coordinate you pick can be converted. Say where the thing is in words and do NOT emit a [POINT:..] tag.',
    '',
    'Never mix the three.',
    '',
    // BOTH of these are gated on case 1 explicitly. Left unconditioned they
    // read as the operative instruction whenever ANY image is attached -- they
    // are longer, more concrete and positioned after the rule -- and on the
    // region-crop path an image IS attached as the first content block. That
    // would have been the old defect's shape moved rather than removed: "do
    // NOT emit a tag for an ungridded image" four lines above "when an image
    // is there, use its pixels".
    '**In case 1 only** - a screenshot WITH the labelled grid, attached as the FIRST content block of the user message - use the actual pixels in that image to pick coordinates: read button labels, identify positions, find the exact target the user is asking about. Do NOT fall back to remembered coordinates from prior turns; ground every estimate in the image in front of you.',
    '',
    '**Read it off the grid (case 1).** The grid overlay is light vermilion hairlines every 100 px with labelled major lines every 200 px ("x=200", "y=400" and so on). Pick coordinates in the *image* coordinate space using the grid as your reference frame. Do NOT eyeball pixel positions - find the gridlines that bracket the target element, then interpolate. For a button sitting just left of the "x=1500" gridline at roughly half the distance to "x=1400", you write `x=1450`. Use the same approach for y. In case 1 the daemon converts your image-space coordinates into the user\'s screen space before dispatching the pebble, so if you see the close button just left of the "x=1580, y=10" intersection, emit `[POINT:1578,12:close]`. In case 3 it does not and cannot, which is why case 3 forbids the tag.',
    '',
    '**Common coordinate mistakes to avoid:**',
    '- Outputting screen coordinates (e.g. (3792, 29) for a 4K screen) when a gridded screenshot is attached - you see the SHRUNK image, so coordinates must be in shrunk-image space. The daemon does the upscale.',
    '- Putting coordinates near the centre of the image when the user asked about a corner element. Read the grid: top-right means high x AND low y.',
    '- Reusing example coordinates from these instructions verbatim instead of measuring from the actual screenshot.',
    '',
    '**Required for any request matching:** "where is X", "where do I click for X", "show me X", "point to X", "guide me to X". A reply without the tag for these is wrong - describing the location verbally is not enough; the pebble must actually move. The one exception is case 3 above, where words are the honest answer.',
    '',
    '**Emit ONE point per request, not a multi-step walkthrough** - unless the user explicitly asks for steps ("walk me through", "show me each step"). If the user asks "how to open a terminal" you point at ONE primary control (the Terminal menu), not three sequential ones.',
    '',
    '**Each request is independent.** Do NOT carry over coordinates or labels from earlier turns; pick fresh ones based on what the user is asking about RIGHT NOW.',
    '',
    // The no-screenshot branch, now labelled as such. Unlabelled it was a
    // worked example in screen space sitting inside the section whose mistake
    // list calls screen space the first thing to avoid -- a third contradictory
    // claim. The hedges ("typically", "about") are kept deliberately: this is
    // text whose entire failure mode is confident wrongness, so an
    // approximation must not read as an assertion.
    'Estimating coordinates WITH NO IMAGE ATTACHED (case 2): use the foreground-app context above and your knowledge of typical UIs. Origin (0, 0) is the top-left of the user\'s primary display. On a screen about 1920 units wide a maximized window\'s close button typically sits near (1895, 8); a browser tab\'s close button is usually at the right edge of the active tab; editors typically keep their main menu bar around y=10 to y=30. When in doubt, your best guess is fine - the user can re-ask.',
    '',
    'Examples (do not reuse these coordinates verbatim - they are illustrative):',
    '  user: "where do I click to publish?" -> "Top-right of the workflows panel. [POINT:<x>,<y>:publish]"',
    '  user: "show me where to close this window" -> "Top-right of the title bar. [POINT:<x>,<y>:close]"',
    '',
    'Replace `<x>,<y>` with your actual estimate. The text is spoken; the [POINT:..] tag is consumed by the daemon and never shown.',
  ];
}
