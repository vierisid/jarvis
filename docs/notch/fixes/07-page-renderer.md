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

## Left for step 4, and why (the first two are done in step 4)

- A lost answer on one desktop still leaves the line dimmed for ever. The
  page cannot tell a lost yes from a brain that is slow to act on it. To
  undim or resend on a timer risks a second yes for the same line, which the
  script can take as a new answer. It needs the numbered answer, the ack and
  the brain's dedupe of step 4. Same for a lost fold.
- The brain does not know when a page was not on screen (a reload is not a
  disconnect), so it cannot leave that time out of `left`. The 2 s floor in
  the page covers it instead.

## What step 4 proved wrong in the design, or left out

- Retry numbers: 1 s apart, 4 sends (not 1.5 s and 3 resends), 16 kept on
  the page, 128 numbers remembered per desktop app and loading of the page.
  A copy is told the same `ack` again; a number older than all kept counts
  as taken.
- A lost message with nothing after it leaves no gap. The page says `at
  {seq}` every 5 s while a line is up, once a minute at rest, and on a late
  answer; the brain sends the whole if it sent more. That finds a lost rest
  and a lost fold within 5 s, and a lost line or a brain started again
  under a resting page within a minute (a resting page used to say it every
  5 s all night).
- Review of step 4 (27 November 2026), what it changed:
  - The first answer that holds a line stands (`held`). A second one that
    would settle it (another choice, another desktop's no after a yes, an
    undo after the fuse was done) is acknowledged as late, and that page is
    told the line as the brain holds it. A line in a `state` or `patch`
    says `held: true`: the page draws it answered, and a fuse on it burns
    nothing and shows no undo. A letter's `done` that does not vouch holds
    nothing (another page may still vouch).
  - A page never reopens a fuse it said ran out, ack or no ack, and clears
    its undo hint when the fuse runs out.
  - The page's `once` numbers key on the whole answer: a different pick or
    text is a new answer, and loses to the first if the first arrives.
  - Every answer carries `brain`, the run named by its `state`. The brain
    refuses any other (line names repeat across runs); an answer without it
    is taken as before. The page drops what it was still sending to the
    run before.
  - Fold grace (`NOTCH_FOLD_GRACE_MS`, 1.5 s): at the fold every page rests
    at once, but the fold is heard 1.5 s later; a settling answer given
    while the offer was up (`since` < its fold) that arrives meanwhile is
    taken instead, and the offer comes back to every page, answered.
    Showing or resting anything ends the grace at once.
  - A page refused for its version pauses an offer's time, as no page does.
  - An unnumbered answer from a page that never said hello on this
    connection is version 1 (left up across an update): the brain opens it
    anew, once per connection, at most once a minute (`createNotchReopen`).
  - Bridge: a `refuse` of this version proves a brain is there, so the
    hello tries start again (still 3 s apart). Esc is not claimed while the
    brain says it does not know the page, or once the page gave up asking.
    A page only out of step for a moment keeps Esc: Esc is what takes a
    fuse back.
- A no and a fold end every line (`after` has them on all kinds), as the
  brain always took them; the design's table had them on offers only.
- `refuse` also answers a page of this version that the brain does not
  know on this connection (the brain was started again): it says hello.
- Not built: the `shown` message and a fuse clock started by it, `held`
  mirrored to the other desktop, the "did not go out" line for a lost
  fuse. The fuse keeps `ms + 1500` from when it was put, with `left` and
  `NOTCH_FUSE_SEEN_MS` from step 2. `since` that fails the gate is logged,
  not refused (owner decision 2 still open).
- `NotchSurface.act` stays as the name for an `effect`; park, mouth, eye
  and sounds have setters and cannot travel as one.

## Esc lease (step 4, page side)

Renew every 2 s (`NOTCH_ESC_RENEW_MS`), lease 6 s (`NOTCH_ESC_LEASE_MS`).
Three renewals per lease, so two lost or late ones (timers in a window that
is not the active one) do not cost Esc. Longer than the pulse's 5 s on
purpose: on a proven page the pulse lets go first, and every renewal is a
sign to the pulse, so a page that renews is never taken for gone. The
desktop app does not enforce the lease yet: the page calls
`__notch_esc_lease(6000)` only where it exists, and that is step 5 of
point 10. No Go file was changed: the desktop app carries the v2 messages
as opaque JSON under the same 64 KB limit.

## Only a real webview can show

(The reviewer's own list did not reach me; this is mine.)
- Whether `__notch_esc(true)` every 2 s holds in a background window: a
  timer throttled past 6 s would let a future sidecar lease lapse.
- Whether `sessionStorage` survives `location.reload()` in WebView2 and
  WKWebView: without it a page refused for its version rests at once and
  never loads itself again.
- Whether `:hover` and `pointerenter` reach a page in a window that is never
  active (the hand report also uses `__notch_cursor`).
- Whether a 1.5 s fold grace is long enough on a slow remote brain.

- The fuse resumes through a negative `animation-delay` (`--fuse-from`), also
  under `.notch-still`. The tests check the value, not the painted fuse.
- Timers in a window that is never the active one may be throttled. A page
  that says `done` late meets the brain's `ms + 1500`, and the yes is lost.
- Messages keep their order through the desktop app: `rest` to the other
  desktop is sent before the next `show`, and must arrive before it.

## What steps 5 and 6 proved wrong in the design, or left out

- Step 5 is `core.ts` (the model and every rule the page applies, no DOM, no
  timers), `render.ts` and `input.ts`, as designed. `index.ts` is about 450
  lines, not 150: the Esc, hand and `at` timers, the outline and the
  failed-draw restore stay there. The model is a value; the joining code
  holds the one variable and the one wake timer (`notchWakeAt`).
- "The tests stop sleeping" was not done: the contract tests already run on a
  test clock where they matter, and none had to change for step 5. The new
  table tests are `core.test.ts`.
- What only the page can see (a sheet's end on screen, the text in a field,
  whether a letter was in sight) is handed to the model with each input, and
  looked at only when the model reads it: looking at a sheet's end marks it
  seen, and did so before only on a yes.
- Step 6 is additive in version 2, no version change: a typed value is
  `word` with `text` (no `value`), and the `ack` carries `unread: true` when
  the brain could not read it. An older page never sends `text`; an older
  brain takes such an answer as a word that changed to nothing. The brain
  pushes the edited line to every page, since a feature does not always
  draw the line again after a word.
- The page does not shake and keep the old value at once: the field waits
  for the `ack`, then closes (read) or empties and says "I did not get that"
  (unread). A yes meanwhile is taken by the field and answers nothing.

## Owner to confirm (steps 5 and 6)

Each is how it is built now, and one line to change.

- A word typed into a schedule as "tomorrow" or "today" is refused. The page
  made it "day at 9:00", every day.
- A day typed with a time into a word that holds a day ("monday at 9") is
  refused. The page kept the day and dropped the time.
- "every morning at 6" typed into a schedule is "day at 6:00". The page
  refused it (the corpus row was not marked; it follows rule 262).
- A value read from what was typed is drawn on every desktop that shows the
  line, not only on the one it was typed on.
- A typed value is drawn one round trip later (the brain reads it); on a slow
  remote brain the field stays up for that moment.
- What was typed into a word that takes anything keeps `<`, `>`, `"`, `&` and
  backticks. The page drew text as text, and so does the brain's mail.

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
- Step 4 (protocol v2): done in "notch: protocol v2: what the notch is apart from what it does once, numbered, answers acknowledged and taken once, a fold the brain owns, and a page of another version refused"
- Review of step 4: done in "notch: review of protocol v2: a decided fuse offers no undo, the first answer that holds a line stands, answers name their run of the brain, a late yes beats the fold, and a page nobody knows keeps no Esc"
- Step 5 (reducer): done in "notch page: what the page holds and decides is a model with no screen and no clock, drawn by its own part and fed by one reading of the keys"
- Step 6 (typed values, with point 3 C6): done in "notch: a value typed into a lit word goes to the brain as it was typed, is read there by the one reader, and one it cannot read is refused on the page"
