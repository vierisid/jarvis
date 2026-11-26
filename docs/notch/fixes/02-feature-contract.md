# Point 2: a contract for the notch's features

Working document for the fix plan. It is removed before the feature merge.

## Original issue

`src/notch/real.ts` puts the whole notch together in one function of about 600
lines: 25 late-bound holders, 13 routers tried in a fixed order, home rows named
by strings, 10 clocks, and one `stop()` that nothing called. The daemon made it
inside the one `try` of the brain's start, whose `catch` exits.

What a person could see of that:

1. With `JARVIS_NOTCH=1`, any throw while the notch was made (a notch table that
   cannot be created or altered, the peer store) printed "Fatal error during
   startup" and the brain exited 1. Under a supervisor it looped. The whole
   assistant was lost to an optional surface.
2. Six clocks in `real.ts` had nothing around them. One throw in one tick is an
   uncaught exception, and the daemon answers that by shutting down.
3. `jarvis stop` while a turn drained (up to 85 s): the notch went on looking at
   the window in front every 2 s, reading mail, and a due chase could be mailed.
4. Parked bumps vanish when the desktop app restarts during a call (point 7).
5. Without mail, "tell me when Sam replies" falls through to an ordinary turn
   and nothing says why.

Everything else is cost of change: every later pass pays for the holders, the
string rows, the 390-line block in `src/daemon/index.ts` and the `noClock`
flags.

## Impact

- 1 and 2 take the brain down. 3 does work the person has just asked to stop.
- The rest slows and endangers every other point: points 1, 3 and 5 all edit
  the same closure, and nothing pins router order, row order or the absence
  matrix (no mail means no standing, and so on).

## Possible solutions

- Rewrite into feature classes at once. Rejected: no safety net, and it
  conflicts with every open branch.
- A DI container or a pure event bus. Rejected: it hides the one readable list
  of what the notch touches that the README promises, and most links between
  features are questions with answers, which events cannot return.
- Numeric priorities for routing. Rejected: a band says why, a number only
  says where.
- Only add try/catch in the daemon and leave `real.ts` alone. Rejected as the
  end state: it fixes 1 and 3 and leaves the cost of change. It is, though,
  what step 0 does first.
- A small contract plus a registry, moved to in steps behind tests. Chosen.

## Chosen solution

A feature is a definition with `id`, `needs`, `wants` and `make(ctx)`. What it
makes may have: `api`, `route` with a band and a position, `ticks`, home rows
and links, settings rows, `done`, `undo`, `hello`, `stop`. The context gives the
surface (effects only), inbox, settings, clock, log, `paused()`, `every()`, an
eye claim and `use(id)` for another feature's api. The registry owns the
scheduler (each run guarded) and the teardown (clocks, inbox, features in
reverse). `real.ts` ends as a list. The daemon side moves to
`src/daemon/notch-wiring.ts`.

Steps:

- 0: isolation and stop only. No structure changes.
- 1: characterisation tests (row order, absence matrix, hello order, clocks,
  stop) before anything moves. Router order is the corpus's.
- 2: `feature.ts`, `registry.ts`, scheduler; questions and news registered.
- 3: moves, canDo, memory, prefs, said, promises, pause, suggestions.
- 4: asks, look, talk, drop, jobs/catch/teach/put, agents; router and home rows
  move to the registry.
- 5: mail, standing, soon, calls, around, day, presence, where, notice, dayOne,
  people; eye claims.
- 6: `dev.ts`; fixtures out of the deps type.
- 7: `notch-wiring.ts` as a pure move, then the hooks.
- 8 (optional): drop the `noClock` flags.

What step 0 does:

- `src/daemon/notch-start.ts`: `startNotchPart` makes a part of the notch and
  ends a throw there: one log line, what was set for the notch is put back
  (Pause holding loops, the owner-word probe, the front source, the capture
  guard), the dashboard is told, null comes back. The surface, the peer parts
  and `attachNotchReal` are each made through it.
- The notice uses the dashboard's saved notifications
  (`src/vault/dashboard-notifications.ts`, the list a dashboard loads when it
  opens) plus the live broadcast for one that is open. Said once while unread.
- `attachNotchReal` stops what it had made when a later part throws, then
  rethrows. No clock is left running for a notch that is not there.
- The six bare clocks run through one guard that logs and goes on: the first
  failure with its stack, then at most once a minute with a count.
- `NotchInbox.stop()`: what is on the notch ends where it is and its line
  leaves; nothing is taken, shown or played after it. A fuse that is burning
  fails its wait, so nothing is sent (README rule 22).
- `handleShutdown` calls `stopNotch()` before it waits for anything. When
  there was a notch, the commitment executor is stopped with it: a promise
  whose cancel window was on the notch is not kept by the executor's own
  clock after nobody can see the window. A stopped notch says `showing()` is
  false, so approvals are toasted again while the turns drain.

Known limits of step 0, left for later steps:

- A notch that failed to start still has its window: the page shows resting
  eyes that answer nothing. Taking the window away needs `attach.ts`.
- After a failed start the person has neither notch nor pebble: the desktop
  app is still told `notch: true` and its pebble is closed, because those
  gates read the switch, not whether the notch was made.
- The daemon's wiring is pinned by a test that reads the source of
  `index.ts`. It is replaced by a real test when the wiring moves (step 7).
- `talk`, the approvals' timeouts, the hello listener of day one and the
  listeners on the surface port are still not removed by stop. With the inbox
  stopped none of them can put anything on the notch.
- The clocks that features own (`asks.ts`, `people.ts`, `mail/attach.ts`,
  `jobs.ts`) were not looked at for bare throws.
- A step already handed to the mailbox is not interrupted: stop means no new
  work.
- (Gone with step 2.) After a failed making, stop told a part that was never
  made from one that failed to stop by the language's own "not yet declared"
  error. The registry stops what was made, and every error of a stop is
  logged.

What steps 1 to 3 do, and what they proved:

- `src/notch/real-wiring.test.ts` pins, with every part given at once: Home's
  rows and links in their order, Today and Undo out of five places, the rows
  of Settings, hello (inbox, then day one), every clock with its pace, and the
  order of stop. Which part takes which words is pinned by the corpus, through
  `notchSide`, and not again.
- `src/notch/feature.ts` is the contract, `src/notch/registry.ts` the one
  scheduler and the one way down. A feature's definition stands in its own
  file (`notchMovesFeature` in `moves.ts`, and so on); `real.ts` adds it.
- Ten features are on it: questions, news, moves, canDo, memory, prefs, said,
  promises, pause, suggestions. The clocks of the parts that are not features
  yet run through the same scheduler.
- `route` is not in the contract yet. It stays a method of each `api`, and
  `real.ts` hands the parts to `notchSide` as before (point 3 is replacing
  that chain). The eye claim and the four signals are not in the context yet:
  nothing that was moved uses them.
- A part that is not a feature yet is lent under its id (`registry.lend`), so
  that a feature reads `ctx.use('where')` the same before and after that part
  is moved. Its stop is given to the registry in the old order.
- Stop order: clocks, inbox, the features from the last made to the first,
  then the parts that are not features yet, in the order they always had.
  Reverse order for all of them comes when they are all features.
- The design's "features in build order" does not hold for what Home shows.
  Home's rows are people, agents, chases and eyes, calls, and they are made
  as agents, people, chases and eyes, calls. Settings shows noticing before
  calls, and calls is made first. Today's `more` is standing before agents.
  So rows, settings rows, `done` and `undo` need a position of their own
  before they can be gathered. Until then the registry refuses a feature that
  names one of them (or `hello`), so that none is silently left out. The
  quiet links at the foot of Home are in build order, and are gathered.
- A feature that is absent because the brain was not given what it is made
  from says nothing (as before). Only a missing `needs` is logged.
- The clocks of agents, chases and noticing, and the look for approvals, keep
  their own catch and their own words in the log; the scheduler's guard is
  around them as well now.

## Owner decisions

- 2026-11-26 (decision 8): step 0 lands alone first; a notch that fails to
  start shows a dashboard notice.
- Still open: one feature failing alone or the whole notch; routing bands;
  step 8; whether a watch asked for without mail should say it needs mail.

## Status

- Step 0: done in "notch: a clock that throws is logged, and stop ends what is
  on the notch", "daemon: a notch that cannot start leaves the brain up, and
  shutdown stops the notch" and "notch: review of step 0: a stopped notch
  tells nothing, promises are not kept past it, failures are logged with
  their place and not flooded"
- Step 1: done in "notch: how the parts are put together is pinned before any
  of it moves: rows, links, today and undo, settings, hello, clocks, stop" and
  "notch: more of the wiring is pinned: what looks by itself, the back office,
  and the pause with the part that knows where the person is". Not pinned: the
  "Last answer" row, the morning line's sheet with its Undo, and the stops of
  the chases and of the calls (`real.ts` does not hand those two back).
- Step 2: done in "notch: a contract for its features and a registry that owns
  the one scheduler and the one way down; questions and news are the first
  two"
- Step 3: done in "notch: moves, what it can do, memory, settings, what is
  said over a line, promises, the pause and suggestions are features"
- Step 4: pending
- Step 5: pending
- Step 6: pending
- Step 7: pending
- Step 8: pending
