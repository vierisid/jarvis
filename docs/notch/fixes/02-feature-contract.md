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
- (Gone with step 7.) The daemon's wiring is pinned by a test that reads the source of
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
- (Changed in step 4.) A feature hands its words over as `intents()`, and the
  registry puts them into the one table. `route` stays a method of each
  `api` for the parts' own tests. The eye claim and the four signals are not
  in the context yet: nothing that was moved uses them.
- `ctx.surface` is effects only: `resting`, `current`, `setSound`, `onStop`,
  `setFace`, `act`. What is shown goes through the inbox.
- `ctx.use(id)` hands a feature only the parts it named in `needs` or
  `wants`. Asking for another throws, by name, in production as in tests: the
  list in the definition is then the whole list of what it leans on.
- Rule for a feature: where one of its members does what a method of its
  `api` does (`stop` today; `done`, `hello` later), it calls that method when
  it is itself called, `stop: () => api.stop()`, never `stop: api.stop`. The
  `api` is the object `real.ts` hands back, and `real-wiring.test.ts` stands
  in for single methods of it; a kept function would go past the stand-in.
- The scheduler can skip a run while the one before it is still under way
  (`skipWhileRunning`, for runs that come back with a promise). It is off
  everywhere: every clock runs as it did.
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
  The quiet links at the foot of Home are in build order, and are gathered.
- (Done in step 4, see below.) What step 4 had to add to the contract, each
  with a position of its own, and gather in the registry.
- A feature that is absent because the brain was not given what it is made
  from says nothing (as before). Only a missing `needs` is logged.
- The clocks of agents, chases and noticing, and the look for approvals, keep
  their own catch and their own words in the log; the scheduler's guard is
  around them as well now.

What step 4 does, and what it proved:

- Asks, look, talk, drop, jobs, catch, teach, put and agents are features,
  each defined in its own file. `real.ts` adds them in the order they were
  made before.
- The contract gathers, besides the quiet links: `intents`, `homeRows` with
  `open`, `settingsRows` with `setWord`, `done`, `undo`, `hello`. Each kind
  has its order written once in `real.ts` (`NOTCH_ORDER`), not taken from
  the build order: says pause, dayOne, mail, put, teach, people, standing,
  agents, memory, calls, prefs, moves, canDo, said; Home's rows people,
  agents, standing, calls; Settings noticing, calls; done and undo standing,
  agents; hello day one (the inbox hears a page first, by itself). A part
  that gives one of them and has no place in its order cannot be made.
- The parts of step 5 give theirs through `registry.lend(id, get, gives)`,
  asked only while the part is there, so moving one changes nothing of
  where its rows stand. People, standing and around are lent now as well.
- The notch routes by `registry.all.intents()`. The corpus still asks
  `notchSide`; both put the lists together in `NOTCH_ORDER.says`, and
  `real-wiring.test.ts` holds that the two tables are the same.
- `ctx.all` is what is gathered, for the parts that show Home and Settings
  and route (asks, prefs). Prefs reads the rows of noticing and calls from
  it instead of asking those two parts by name.
  A word changed in Settings is now offered to noticing before calls (it was
  calls first); their words are disjoint (`notice`; `calls`, `callside`), so
  nothing can tell.
- Not gathered, on purpose: the rows of a call that is on, the prepared
  replies, what is seen and the jobs that were shown stand above the
  gathered rows in places of their own in `asks.ts`, with what their open
  does to Home (a call's row ends it). The jobs keep their own place in
  Today with their own undo, which leaves Home.
- Behaviour that changed, both after stop only: the features are stopped
  from the last made to the first, before the parts that are not features
  yet (drop, look, asks, agents, put, teach, catch, jobs, then the rest as
  before); a stop runs synchronously and no stop calls another feature, so
  nothing can see the order. And a page that comes up after stop no longer
  reaches day one.
- `talk` is a feature. Its stop (added after the review) lets go of what the
  desktop apps say of the keys and clears the limits of open recordings: the
  port has no way to take a listener back, so the listener asks first. The
  scheduler's `skipWhileRunning` stays off: every clock runs as it did.

What step 5 does, and what it proved:

- Mail, standing, soon, calls, around, day, presence, where, notice, day one
  and people are features, each defined at the foot of its own module
  (`notchMailFeature` in mail/attach.ts, and so on). The attach bodies are
  untouched: a definition wraps the attach function and hands it what
  `real.ts` used to. Nothing is lent any more and no part is stopped by
  hand. (After the review, `lend` and `onStop` left the registry.)
- `real.ts` is a list: the settings, the quiet hours, the inbox, the
  approvals, Today and the look for approvals are still made there (the
  core every part stands on), then one `registry.add` per feature.
- Presence is made right after the inbox instead of before it. The inbox
  asks it whether a line may come up; until it is made (the same
  synchronous making) the inbox has no presence to ask and may speak. Its
  calm goes to `ctx.inbox.calmed()`, so the `calmed` holder is gone.
- Eye claims: `ctx.eye(on)` claims one of the notch's eyes for the feature
  that calls it. The eye is citron while any feature claims it. Standing
  and calls claim it; the surface is told at each claim, as before.
- `ctx.surface` adds `setWhere` and `setPark`, the where's and the
  around's; `attachNotchWhere` and `attachNotchAround` take only what they
  use.
- What a part leans on is in `wants`, never `needs`, with a null check: a
  brain without mail, the day, a desktop app, asking or the peers makes
  the same parts as before and logs no new line. `real-wiring.test.ts`
  holds that over fifteen combinations.
- Behaviour that changed, after stop only: every part is stopped from the
  last made to the first: day one, noticing, around, calls, standing,
  mail, the promises and the pause, drop, look, asks, people, agents, put,
  teach, catch, jobs, where, presence (the day and soon have no stop). As
  in step 4, no stop calls another feature.
- Known limits kept: calls hear the product's pause through a subscription
  that is never taken back (it was so before); the surface's own page
  listeners are not removed.

After the review of step 5:

- The inbox's `maySpeak` keeps the quiet hours also in the moment before
  presence is made.
- The evening's slipped promises and day one's way to Gmail are called on
  their objects (`promises.slipped(...)`, `office.connect(...)`), as before
  step 5.
- A feature that is stopped claims the eye no more, and nothing can claim
  it on a stopped notch: the eye does not stay citron after stop.
- Talk's stop also clears the steps of `pretend`, and a recording that was
  still being made into words is dropped when it comes back: nothing
  reaches the asks after stop.
- `registry.lend` and `registry.onStop` are gone: every part is a feature.

What step 6 does:

- The fixed test items are made by `attachNotchDev(real, given)` in
  `src/notch/dev.ts`, beside the notch and not inside it. The daemon calls
  it only while the demo gate is open, right after the notch is made, and
  hands what it makes to the fixture route (`notchFixtures` in index.ts,
  the one holder the type change forces).
- `NotchRealDeps` lost `approveAsDashboard`, `toolRegistry`,
  `deliverApproval`, `recordFixtureFailure`, `promises.appendFixtureLog`, and
  what only the fixtures used of the promises: `create`,
  `executor.checkAndAnnounce`, `executor.setOriginRunner`. `NotchReal` lost
  `fixtures`.
- Behaviour: none changed. With the gate shut the route had fixtures and
  answered 404 at the gate; it now has none and answers the same. With
  the gate open the same items are made from the same functions, and the
  fixture promise's runner is set on the executor right after the notch is
  made instead of during it, before anything can run.
- The demo moments (`src/notch/demo.ts`) are made with the surface, before
  the notch, and stay where they are: moving them is step 7's.
- Tests that made fixtures through `attachNotchReal` make them through
  `attachNotchDev` now (setup only, every assertion is the same).

After the review of step 6: the test items are made through
`startNotchPart` (a throw leaves the brain and the notch up, and the
dashboard says the test items are missing), and only with the gate open
(`notchDevFor`, held by `dev.test.ts`); `notchMaySpeak` holds the quiet
hours with no presence; a talk stopped while a look's files are fetched
claims no dropped file; prefs calls `connect` on the back office.

What step 7 does:

- `src/daemon/notch-wiring.ts` holds the notch's part of the brain's start,
  moved as it was (first commit): the surface and the demo
  (`createNotch`), the peer parts, `attachNotchReal` with its deps literal,
  the test items and the peer setup (`startNotch`), the notch's routes
  (`notchApiRoutes`), the stop on the way down (`stopNotchFirst`), the
  dashboard notice, and the holders. The only changes inside the moved
  text: `googleAuth`, `bgAgent` and the workflow deps, which index.ts sets
  again later, are asked for through getters, and the peer setup is handed
  back through `setPeerSetup`.
- The holders are module variables of notch-wiring.ts; index.ts reads none
  of them now. The hooks (second commit): `notchIsUp`, `notchShowing`,
  `notchSuggestionsNow`, `notchRefreshWhere`, `notchTurnsReady`, and the
  setters for what index.ts makes for the notch (`setNotchAttachments`,
  `setNotchSetWatching`, `setNotchFinishSetup`). The front source and the
  capture guard are set inside `startNotch`, as before.
- Order on the way down is unchanged: `stopNotchFirst` is where the stop
  was, before the first `await`, with the commitment executor beside it.
- The test that read the source of index.ts is gone. In its place,
  `notch-wiring.test.ts` holds by what they do: nothing made with the switch
  off, a surface or a making that throws leaves the brain up and tells the
  dashboard once, the hooks answer as if there were no notch, and the way
  down stops the notch first and the executor with it. The SIGTERM test
  of `notch-start.test.ts` still runs the real handler.
- Known limits: the holders are module state, so a second `startDaemon` in
  one process would share them (none does). A making that fails puts back
  the owner-word probe, not the front probe (as before).

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
  "Last answer" row and the morning line's sheet with its Undo. The stops of
  the chases and of the calls are pinned by what they do: a stopped notch
  sends no due chase, and lets go of a call it listens to.
- Step 2: done in "notch: a contract for its features and a registry that owns
  the one scheduler and the one way down; questions and news are the first
  two"
- Step 3: done in "notch: moves, what it can do, memory, settings, what is
  said over a line, promises, the pause and suggestions are features"
- Step 4: done in "notch: asking, the look, the drop, the jobs and the agents are features, and the registry gathers the words, Home's rows, Settings, today, undo and hello in one order" and "notch: review of step 4: talk is stopped with the notch, a making that fails after the drop is pinned, and the registry says when a feature is kept"
- Step 5: done in "notch: mail, standing, soon, calls, around, the day, presence, where, noticing, day one and people are features, and real.ts is a list" and "notch: review of step 5: the quiet hours hold before presence, promises and connect are called on their objects, a stopped notch keeps no eye, talk ends its pretends and late words, and lend goes"
- Step 6: done in "notch: review of step 6: the test items are made through the guard and only with the gate open, the quiet hours hold without presence, a stopped talk claims no dropped file, and prefs calls connect on the back office" and in "notch: the fixed test items are made beside the notch, only while the demo gate is open, and are no longer in what the notch is given or hands back"
- Step 7: done in "daemon: the notch's part of the brain's start moves as it was into notch-wiring.ts, and the test that read index.ts is a test of what it does" and "daemon: what the rest of the brain asks of the notch goes through hooks of notch-wiring.ts"
- Step 8: pending
