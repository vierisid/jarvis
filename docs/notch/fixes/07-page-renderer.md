# Point 7: the page as a renderer

Review reports 08 (the page) and 01 (the core), 26 November 2026. This file is
working notes for the fix and is removed before the feature is merged.

## Original issue

The page is meant to decide nothing: the brain says what the notch shows, the
page draws it and reports what the person did. In practice the page owned
time and rules of its own, and trusted whatever it was sent. What the owner
would see:

1. Dead page. A line that cannot be drawn (a sheet with no blocks) is told to
   a page that comes up in the middle of it. The notch draws nothing and hears
   nothing more until the desktop app is started again.
2. A line that could not be drawn in place of another left that other one on
   screen with its timers cancelled: a result never left, an offer never folded.
3. Fuse and redraw. After a yes the fuse burns. If the page is drawn again in
   the middle (it reloads, says hello again, or the keys of the machine
   change) the fuse starts again from full. The brain waits only for the
   original time plus 1.5 s, so the fuse vanishes and the yes is dropped
   without a word.
4. Second desktop. A no on one desktop leaves the line on the other for ever;
   a yes there is dropped as late.
5. Dimmed for ever. A yes whose answer is lost on the way leaves the line
   dimmed, and nothing brings it back.
6. Typed values are changed in the page, in English: `Tell R&D "x < 5"` is
   sent as `Tell RD x 5`, "month" is read as Monday.
7. A lost fold leaves the brain waiting on a line no page shows. Bumps on the
   edge are lost when the desktop app restarts during a call.

## Impact

1 is rare and severe (no notch at all). 3 is uncommon and costs an approval.
4 is certain for anyone with two desktops. 5 and 7 are rare. 6 is likely for
long typed values and changes the person's words silently. Behind all of them:
every deadline and every "does this answer end the line" rule is written
twice, once in the page and once in the brain, and nothing keeps them equal.

## Possible solutions

- Everything in the brain, the page reports raw keys. Rejected: a round trip
  cannot tell a key that was already on its way when the line was drawn, and
  every Esc would wait for the brain.
- Keep protocol v1 and patch each defect. Rejected as the whole answer: it
  leaves two copies of the rules. Accepted for the three safety fixes below,
  which are small, additive and needed whatever comes after.
- The page owns the fold and is told the time left. Rejected: two desktops
  would fold each other's line under a hand.
- Acks in the desktop app. Rejected: the desktop app carries messages and
  reads none, and it would not cover the link to the brain.

## Chosen solution

Six steps, each shipping alone.

1. A validating reader at the page (`readNotchToPage`). A message is read
   whole before anything changes. One that is wrong is dropped, logged, and
   the page says hello again: at most 20 times per episode, 3 s apart; an
   episode ends when a `state` is read whole. A `state` with a wrong line
   keeps the rest, so a page that comes up rests and is not dead. A message
   of a kind the page does not know (a newer brain) is passed over quietly.
2. Time left. A result and a fuse in a `state` carry `left`. The page burns
   what is left. With less than 2 s left (`NOTCH_FUSE_SEEN_MS`) a page that
   did not show the fuse before burns nothing and sends no `done`: the brain
   counts it lost. A `state` for the line already on screen changes nothing,
   so an answered line stays answered.
3. Rest broadcast. When an answer ends the line, the other desktops are told
   to rest.
4. Protocol v2: `state` / `patch` / `effect` with a sequence number, answers
   with an ack and a retry (this is what fixes "dimmed for ever" and the lost
   fold), behaviour flags written by the brain (`after`, `away`, `asking`,
   `gate`), a fold owned by the brain, a refusal on a version mismatch.
5. The page as a reducer: `core.ts` with no DOM and no timers, `render.ts`,
   `input.ts` with one "too soon" guard. The tests stop sleeping.
6. Typed values read by the brain; the page sends the raw text.

## What steps 1 to 3 proved wrong in the design

- "Esc stays taken" on a dimmed line is not so: an answered line gives Esc
  back at once (the page tests already pinned it). The line still stays
  dimmed for ever; that waits for the ack in step 4.
- Step 1 did not draw into a detached view. A line that stays after a failed
  draw is drawn again instead, and only when its schedule was really lost, so
  a field being typed in is not emptied.
- `left` is only put in the `state`, not in every `show`: left out means all
  of it, and every existing message stays byte for byte the same.
- A dropped message makes the page ask again, and each hello has an effect in
  the brain (things that were missed may speak). Hence the limits in step 1.

## Left for step 4, and why

- A lost answer on one desktop still leaves the line dimmed for ever. The
  page cannot tell a lost yes from a brain that is slow to act on it. To
  undim or resend on a timer risks a second yes for the same line, which the
  script can take as a new answer. It needs the numbered answer, the ack and
  the brain's dedupe of step 4. Same for a lost fold.
- The brain does not know when a page was not on screen (a reload is not a
  disconnect), so it cannot leave that time out of `left`. The 2 s floor in
  the page covers it instead.

## Only a real webview can show

- The fuse resumes through a negative `animation-delay` (`--fuse-from`), also
  under `.notch-still`. The tests check the value, not the painted fuse.
- Timers in a window that is never the active one may be throttled. A page
  that says `done` late meets the brain's `ms + 1500`, and the yes is lost.
- Messages keep their order through the desktop app: `rest` to the other
  desktop is sent before the next `show`, and must arrive before it.

## Owner decisions

Open, none of them needed for steps 1 to 3:

1. Fold owned by the brain with `hand` reports, or by the page with `left`.
2. A yes whose reported timing fails the gate: refuse, or only log.
3. A lost fuse says one line ("That did not go out. It waits."), or stays silent.
4. Version mismatch: refuse and reload once, or keep logging.
5. Second desktop: mirror `held` too, in step 4.
6. Typed values read by the brain in English now, a shared locale module later.
7. Reword invariant 12: the page decides nothing; it measures what only it
   can see (paint, hover, the end of a sheet) and reports it.
8. `NOTCH_FUSE_SEEN_MS`, 2 s today: the least of a fuse a page that comes up
   in the middle must be told is left to vouch for it. The owner's to tune.

## Status

- Step 1: done in "notch page: a message it cannot read is dropped whole, and it asks the brain again"
- Step 2: done in "notch: a fuse or a result drawn again goes on from where it was"
- Step 3: done in "notch: an answer that ends the line takes it off the other desktop too"
- Review of steps 1 to 3: done in "notch: review of point 7: a fuse nobody could read is not vouched for, an answered line stays answered, and the hello has a real cap"
- Step 4 (protocol v2): pending
- Step 5 (reducer): pending
- Step 6 (typed values): pending
