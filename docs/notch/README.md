# The notch

A desktop surface that is still being built: Jarvis in a shape at the top
centre of the screen, one line at a time. It ships dark. This page states what
"dark" guarantees, the messages that exist so far, and how to try a build.

Where things are:

| What | Where |
|---|---|
| The switch, and telling a desktop app to host the notch | `src/notch/switch.ts`, `src/notch/attach.ts` |
| What the brain and the page say to each other | `src/notch/protocol.ts` |
| What the notch is showing, held by the brain | `src/notch/surface.ts` |
| Canned moments for trying it, and their gate | `src/notch/demo.ts`, `src/notch/demo-gate.ts`, `src/cli/notch.ts` |
| The page | `ui/notch.html`, `ui/src/notch/` |
| The window, its shape and its rules | `sidecar/notch*.go` |
| The keys | `sidecar/notch_keys.go` (the deciding), `notch_keyboard.go`, `notch_keys_winlogic.go`, `notch_keys_windows.go`, `notch_keys_darwin.go` |

## The switch

- `JARVIS_NOTCH=1` in the brain's environment turns the notch on. Any other
  value is off, including `true` (`src/notch/switch.ts`).
- It is classified as a setting, not a secret (`JARVIS_SETTINGS_ENV_NAMES` in
  `src/util/model-exec-env.ts`), so a brain restarted from the assistant's own
  shell keeps the owner's choice.
- A desktop app advertises the capability `notch` to say it understands
  `notch.*`. It hosts nothing until the brain tells it to.
- When a desktop app connects, a brain with the switch on sends it
  `notch.configure {enabled: true}` (`src/notch/attach.ts`).

The decision is the brain's alone. A desktop app cannot turn the surface on by
itself, and `sidecar.yaml` has no setting for it.

## Invariants this protects

1. **Off means silent.** With the switch off the brain registers no notch
   listener, sends no `notch.*` message to any desktop app, holds no notch
   state, and has no notch route: absent, not refused. The page's built files
   ship in `ui/dist` like any other asset and are inert: the page draws
   nothing until a brain answers its hello, and a brain with the switch off
   never does.
2. **Old desktop apps are left alone.** A desktop app that does not advertise
   `notch` is never sent `notch.*`, whatever the switch says. One that
   advertises it but reports `surface: "none"` is never asked for a window.
3. **The switch does not outlive its connection.** The desktop app keeps it in
   memory and turns it off on disconnect, which also closes the window. A brain
   that reconnects with the notch off says nothing, so nothing stale survives a
   brain restart.
4. **A malformed request changes nothing.** `notch.configure` without a boolean
   `enabled` is refused and the switch stays where it was. `notch.spawn` is
   refused while the switch is off.
5. **`bun run dev:local` does not turn it on.** The launcher builds its
   environment from scratch and carries `JARVIS_NOTCH` across only when the
   caller set it to exactly `1` (`scripts/integration/dev-env.ts`).
6. **Only the brain's own page renders.** `notch.spawn` pins its URL to the
   brain origin in the enrolment token and signs it in with a short-lived
   access token, exactly as `panel.spawn` does.
7. **The page cannot cut the window to any shape it likes.** An outline is at
   most 16 polygons and 720 points in all. A polygon of fewer than 3 points, a
   malformed point, or a point far outside the window, and the outline is
   refused whole and the previous shape stays. The page sends two outlines at
   a time, and one bad outline refuses both.
8. **Appearing never takes the keyboard.** The window is shown without
   activation. It takes the keyboard only when the page calls
   `__notch_focus(true)`, and gives it back to the window that had it.
9. **It hides for a fullscreen video and only then.** A browser in fullscreen
   that is only being read keeps the notch. When in doubt the notch stays.
   - **Windows:** all three must hold. A fullscreen app is in front. Something
     is keeping the display awake, which every player does while it plays. And
     the app is being watched (`sidecar/notch_video.go`): no mouse or keyboard
     input for 1.2 seconds, the app has hidden the mouse pointer, and either
     the app is playing sound or the picture has moved in the last 3.2
     seconds. Two looks in a row, 400 ms apart, hide the notch. Twelve in a row
     without, about five seconds, bring it back, and leaving fullscreen brings
     it back at once. A pointer in plain view always keeps the notch: that is
     what tells a page being read from a film.
   - **macOS:** a fullscreen app is in front, and that app (itself, a helper
     inside its bundle, or the system's WebKit process) is the one asking for
     the display to stay on.
   - A screen capture choosing its area covers the screen too: while Windows'
     own capture tools are in front the notch stays exactly as it was.

10. **The desktop app carries the messages and reads none.** What the brain
    and the page say to each other passes through it as JSON, at most 64 KB a
    message, in the order it was sent (`notch.push` is handled on the
    connection's own thread for that). It refuses what is not JSON, a push
    with the switch off, and a push with no page up. It never acts on a
    message's content.
11. **What the notch shows lives in the brain.** A page that appears says
    hello and is told everything at once, so a desktop app restarted in the
    middle of a line shows the same line, with the words the person had
    already changed. A page that has not said hello on its present connection
    is sent nothing.
12. **The page decides nothing.** It reports what the person did (yes, no, a
    pick, a changed word, typed text) and the brain decides what that means.
    The brain reads those reports strictly: anything that is not exactly one
    of its four messages is dropped, and an answer about a line that is no
    longer on the notch is dropped as late.
13. **The demo endpoint is shut unless opened on purpose.** `POST
    /api/notch/demo` exists only with the switch on, a `JARVIS_NOTCH_DEMO`
    secret of 16 or more characters, and not on a hosted install, and every
    request must echo the secret. Otherwise it answers 404. It can make the
    notch show sample sentences, make the fixed test items (below), and, on a
    development brain with no real model, load a script into the stand-in
    model (invariant 37). Nothing else.

14. **The keyboard is watched only while the notch is on screen.** The watch
    starts when the notch's page is attached and ends when it is detached, so
    it cannot outlive the switch. With the switch off nothing looks at the
    keyboard for the notch at all.
15. **What the watch may know.** A key is Esc, one of the eight modifier keys,
    or "another key". Which other key it was is not passed on, kept or logged,
    by construction: the event the deciding code is fed has no field for it.
    On macOS plain typing does not even reach Go. Nothing is logged from
    inside the watch.
16. **What the watch may change.** Esc is kept from the app in front while the
    notch has something Esc would close, and only then (and the second Esc of
    a quick two). No other key is ever kept. When a pair has been understood
    one key that no keyboard has is sent, so that letting go of the Windows
    key or Alt does not open the Start menu or the menu bar.
17. **Only a person talks to the notch.** A key a program sent is not seen
    by the watch at all, on either system. Jarvis itself types and presses
    keys in other apps: an Esc it presses there reaches that app, and a pair
    it presses is never a yes to its own offer.
18. **The watch ends with the switch, at once.** Turning the switch off stops
    the watch before the window is closed, not when it has finished closing.
19. **A message into a closing window is dropped.** Everything sent into the
    page checks first that the window is not on its way out. On Windows a
    script run while the web view is being taken apart is a crash.

## Real things on the notch

From pass 4 the notch is fed by the product itself. `src/notch/real.ts` is
the one place that puts it together, and reading it is reading the list of
what the notch touches.

| On the notch | Where it comes from | How it is found | How it is answered |
|---|---|---|---|
| An approval | `approval_requests` | looking once a second | `applyApprovalDecision`, as decider `notch` |
| A promise about to be kept | the commitment executor | its `subscribe` | `cancelExecution` |
| A workflow's question | `workflow_human_request` | looking every 5 s | `resolveHumanInput` |
| A failure | the open failures list | looking every 5 s | nothing: it is news |
| A background task that ended | the task manager's lifecycle | its `subscribeLifecycle` | nothing: it is news |
| A suggestion | the awareness delivery policy | given in place of its toast | nothing: it is news |
| Everything stopped | the emergency controller | its `subscribe` | `pause`, `resume` |

What holds for all of them:

20. **The notch decides nothing.** A yes goes through the same function every
    other surface uses, so "decided once" holds: a second answer, from the
    notch or from anywhere else, is refused there, and the notch says so.
21. **Esc is a no. Looking away is not.** Esc on a line turns it down
    through the product's own function: an approval is denied (a payment
    too: it can be refused from anywhere), an approve-or-reject question is
    rejected, a promise in its window is cancelled. It is gone from the
    notch, the count and the dashboard, and whoever asked is told no. A
    question that has no "no" (a choice, a form) leaves the notch for good
    and stays in the dashboard. A line left alone until it folds is not
    answered: it goes back to the count and comes round again. Esc inside a
    fuse takes back the yes just given, and nothing else. By the owner's
    decision of 13 November 2026; before it, Esc only meant "not now".
22. **A yes is not acted on at once.** A fuse burns first and Esc takes it
    back. Nothing has been decided while it burns, so nothing has to be
    undone. A fuse nobody saw burn out (the page went away) decides nothing.
23. **What a key may approve.** Whatever the notch can show whole: a shell
    command, a file write, a delete, an install, a message, stopping an
    agent. The rule a spoken yes follows (nothing destructive by voice) is
    not applied on the notch, by the owner's decision of 13 November 2026;
    a destructive request is shown with a careful face. Two things a key
    never approves: a payment (the product refuses it from every surface but
    the dashboard), and an action whose letters could be look-alikes or
    whose exact text is over 3,000 columns. The line says why and yes on it
    only opens the dashboard. A sentence is drawn one block per word, and a
    word longer than a line (a path, a URL) is cut into pieces a line can
    break between, so no part of what is being approved is ever out of sight.
38. **An approval is asked in plain words, with the exact action under
    them.** Decided by the owner on 13 November 2026: a person is asked "Look
    up where Steam is installed?", not shown a registry query. An action
    whose exact sentence is short (60 columns), and the model's own one-line
    intent, are a line as before. Anything longer, and anything that has to
    be reviewed on screen, is a sheet: the question on top, and on paper
    under it every character of what will be done (`notchApprovalExact`). So
    what is approved is on screen at the moment of the yes. The question is
    written by a small model that is shown the tool and its arguments and
    nothing else, not the conversation and not what the agent read, so a page
    that steered the agent cannot also word the question. When it has no
    answer in four seconds the question is the kind of thing it is ("Run a
    command on this computer?"). On such a sheet yes approves, Esc is a no,
    and a click somewhere else is neither.
39. **The notch may approve what has to be reviewed on screen.** The product
    lets only the dashboard approve a browser or desktop action, because a
    chat reply or a toast cannot show what it would do. The notch is on the
    screen the action happens on and shows it as in 38, so its yes counts
    (`approvalDecidableBy`, asked by the decision function and by the
    executor). Every other surface is refused as before.
40. **Opening an app is not asked about.** Decided by the owner on 13
    November 2026, with the operating system as the measure: it does not ask
    before it opens an app; it asks before a delete, a payment, or a program
    it does not know. In a turn the owner started on the notch, a plain app
    open needs no approval and is not held back by outside content read
    earlier in the turn. A plain app open is `desktop_launch_app` with no
    arguments, of an app named as a person names one or installed in the
    system's own folders for apps, and never a shell, a script host, an
    installer or a tool that acts by being started (`authority/app-open.ts`).
    Opening it still counts as outside content: what the turn does after it
    is asked about as before. Everywhere but a notch turn, and with the
    switch off, opening an app is reviewed on screen as it always was.
24. **A tap cannot land on the wrong thing.** A line that came by itself
    takes no yes and no Esc for 0.7 s, counted in the page from when it was
    drawn. After that an Esc pressed for the app in front does land on the
    line, because Esc is taken from that app while a line is up (16).
25. **The page starts nothing.** A promise is run by the executor's own
    clock. The page saying its fuse has burnt is not what runs it.
26. **One item per subject, and each has one chance to speak up.** An item
    speaks when it arrives and the notch is free, otherwise it joins the
    count. Exceptions: one that arrived while no notch was up, or while
    everything was stopped, speaks when that ends; and a window that is
    already running (a promise's fuse) takes the notch.
27. **Before anything is shown it is asked whether it is still true.** What
    was decided, answered, cancelled or expired elsewhere leaves by itself.
28. **While a notch is up, it is the one that asks.** The approval toast and
    the task-complete toast are not raised for what the notch shows.

## Talking and typing

Hold the talk keys, speak, let go. Or yes at rest, and type. Nothing is spoken
back.

Both are the same thing to the brain: one instruction, entering at one
function (`src/notch/asks.ts`, `run`). It becomes one stored turn of the
product's own turn store (`BriefChatTransport.submit`): the same agent, tools
and authority gate as a dashboard message, kept in one conversation called
Notch, which the dashboard lists like any other. "Remember that..." does not
go to the agent: it is written to memory as one fact and read back
(`src/notch/remember.ts`).

| What | Where |
|---|---|
| The instruction from heard to answered, and Home | `src/notch/asks.ts` |
| The ledger, and the two promises it keeps | `src/notch/ledger.ts` |
| The desktop app's recordings, made into words | `src/notch/talk.ts` |
| The microphone while the keys are held | `sidecar/notch_talk.go` |
| What the notch is given from the product | `src/daemon/notch-asks.ts` |
| Nothing is spoken: the one question every speaking place asks | `src/notch/silence.ts` |
| The stand-in model, and its dev route | `src/llm/scripted.ts`, `src/notch/script.ts` |

What the person sees. While the keys are held the line listens. When they
come up it shows what was heard, for 0.9 seconds, and then the work. Esc at
any point before the work starts turns it away. Typed words are not shown
back: the work shows at once. While it works the line says what is being done
(the product's own fixed sentences, never a tool's arguments), and Esc stops
it. The answer is one line; one longer than 140 characters, or in more than
one paragraph, opens as a sheet that stays until it is closed.

29. **A recording that was turned away can never run.** An instruction runs
    only by its row in the ledger being claimed, which moves it from `heard`
    to `running` in one statement. A row that was dismissed is not `heard`.
    Its audio arriving late, its words arriving late, a second key-up: none
    of them can claim it.
30. **Nothing runs twice.** A row is claimed once. The turn it starts carries
    the row's id as its request id, which the turn store refuses a second
    time. A restart retries nothing: what was running is closed as failed,
    and what had not run is closed as turned away.
31. **Audio is acted on only by its recording's id.** The id is made where the
    microphone opens. The brain keeps one open recording per desktop app and
    drops an `end` for any other id unread. Nothing looks up "the latest".
32. **What stays on the machine.** A recording ended by a slip (another key
    with the pair held), one made while the microphone was muted, one with
    less than 250 ms of voice in it, and one that ran into the 60 second
    limit are not sent. The brain is told how it ended and gets no sound.
    What counts as voice is judged against the recording's own quiet: a
    piece of sound is voice when it is 2.5 times louder than the quiet tenth
    of the pieces, never asking for less than a level of 90 or more than 500
    (`notchTalkMeasure`). The desktop app's log has one line per recording
    with what it measured and what became of it.
33. **Words are not in a log or in a broadcast.** The brain logs how long a
    transcript was, never what it said. `notch.message` and `notch.talk` are
    not passed on to dashboards with the other desktop app events.
34. **Nothing is spoken back.** With the switch on no reply, confirmation,
    suggestion or workflow note is synthesised, live voice is off whatever
    the settings say, and the desktop app refuses to play speech. The speech
    settings are not changed: with the switch off everything speaks as it
    did, and the settings page's voice preview still plays.
35. **It does not listen for its name.** With the switch on the brain says so
    when a desktop app connects, and that desktop app never opens the
    microphone for the wake word. A desktop app too old to understand still
    sends what it hears, and the brain drops it untranscribed. The talk keys
    are the only way to speak to it.
36. **A memory holds only what was said.** "Remember that..." is split into
    who, what and the rest by one small model call. If the reply is not
    exactly that, if it uses a word the person did not say, or if the name
    fits more than one entry, nothing is saved and the notch says so. The
    fact is confirmed, its evidence is the person's own sentence, and its
    source reads "you told me".
37. **The stand-in model cannot be mistaken for a model, or reach one.** It
    is never in the settings: nothing lists it and no save can keep it. It is
    bound only on a `dev:local` brain with the dev gate open, after a script
    is loaded, and only while no real provider is bound. Its script's words
    are free; its tool calls are limited to three with fixed arguments
    (`NOTCH_SCRIPT_TOOLS`). Words can be sent through the dev route only
    while it is the model that answers.

### What this branch changes with the switch off

Invariant 1 is about the notch. These are changes to the product itself, made
because the notch needed them to be true, and they hold whether or not the
switch is on:

- **A payment is approved on the dashboard only** (`approvalDashboardOnly`).
  A notification button or a chat reply could approve one before. Decided by
  the owner on 12 November 2026.
- **A commitment runs at its due time, at most once, and a cancel holds**
  (`commitment-executor.ts`, `claimCommitmentRun`, new column
  `commitments.started_at`). It no longer runs up to two minutes early; the
  same words due in the same minute are one commitment; one cut off by a
  restart is closed, not run again; nothing is announced or run while Jarvis
  is paused; a turn that came back as error text is a failure.
- **The audit trail has a channel `notch`**, unused while the switch is off.
- **The wake listener opens the microphone when the brain has answered the
  registration**, not at the moment of connecting (`wakeHold`,
  `sidecar/pebble_wake.go`). A brain with the switch off answers at once, so
  this is milliseconds; a brain too old to answer is given three seconds.
- **A recording on the talk keys ended by a slip is a new key action**
  (`talk-cancel`). The keys are only watched while a notch is up.
- **The turn store has a door for the brain itself**
  (`BriefChatTransport.submit`, `onEvent`, `cancelTurn`) and a rule for
  whether a spoken reply may be spoken (`speakAllowed`). Nothing calls them
  with the switch off.
- **A sheet row that opens something shows its small word** (the page's
  `blocks.ts`). No sheet used both before.

And these are behind the switch:

- **Pause also holds the model loops** (`setPauseHoldsLoops`, `whenRunnable`).
  Background model calls wait for Resume. One line in `daemon/index.ts`
  makes it the rule everywhere.
- **Suggestions join the count** and are not spoken or toasted.
- **Nothing is spoken and nothing listens for the wake word** (invariants 34
  and 35).
- **Typed and spoken notch events are not broadcast to dashboards.**
- **Approval and task-complete toasts are not raised** while a notch page is up.

## The keys

| What | Keys | How it is told |
|---|---|---|
| Talk | hold Ctrl + Win (Mac: Ctrl + Option) | the pair down alone for 150 ms; ends when either comes up or any other key goes down |
| Yes | tap Win + Alt (Mac: Option + Cmd) | the two down within 0.7 s of each other and up again within 1.5 s, with no other key |
| Esc | Esc | only while the notch has something on it, and never with a modifier |
| Stop everything | Esc twice | the second within 0.4 s of one that was taken |

- A pair is two different modifier keys. Left and right are the same key.
  AltGr is never Ctrl and never Alt.
- A shortcut that begins with the same keys (Ctrl + Win + D, Win + Alt + R)
  is not ours: any other key makes the press somebody else's.
- One press of the modifiers says one thing. Letting go of one talk key and
  pressing Alt does not become a yes.
- The pairs are per machine: `notch_talk_keys` and `notch_yes_keys` under
  `preferences` in `sidecar.yaml`, written like `ctrl+meta`, or the two lists
  in the desktop app's settings window (shown only while the notch is on). An
  unreadable pair, or the same pair twice, falls back to the system's default.
- The page shows the machine's own keys in its hints. With nothing on the
  notch, yes opens Jarvis.
- Windows takes a low-level hook away, without saying so, if its callback is
  ever too slow. The hook is put back once a minute while no key is down.
- Twice a second the watch checks the keys it believes are down against what
  Windows says. A key let go over a window that runs as administrator, or
  while the screen was locked, never reaches the hook; this is what ends a
  talk that such a release left hanging.
- Keys sent by a remapping tool are keys a program sent, so the notch does
  not see them. Someone who remaps Ctrl, Alt or the Windows key in software
  needs to pick pairs from keys that are not remapped.
- A window that runs as administrator in front (Task Manager) does not let
  the hook see keys. Nothing can be done about that from here.
- `notch.configure` answers `keys: "watch" | "blocked" | "none"`. On macOS
  the tap needs the Accessibility permission, asked for in setup and never
  from the watch itself; without it the answer is `blocked` and the notch
  answers to the mouse only.

## What it does not protect, and what is missing

- Approvals a restart left without a receipt ("run once or close") are not
  on the notch. They are in the dashboard, and in the tray's count.
- Esc twice is heard only while the notch has something on it, because that
  is the only time Esc is taken from the app in front. To stop everything
  from rest: yes (which opens Home or starts a round), then Esc twice. Or
  the tray's Pause. The same pause either way.
- Pause does not stop watching. The observers run on; "eyes closed" here
  means nothing is done, not that nothing is seen.
- Held model loops are in memory. A brain restarted while paused comes back
  paused, with what was held gone.
- A workflow's question that needs typing, or more than one field, is not
  answered on the notch: the line points at the dashboard.
- Workflow questions, failures and suggestions on the notch have tests but
  no fixture that makes a real workflow run, so they have not been seen on a
  real brain. Approvals, promises and the pause have.
- After a turn has opened an app or read a window, a page or a file, every
  command it runs next is asked about, also one that only reads (the
  product's guard against a page telling Jarvis what to do). On the notch
  that is one tap each, in plain words. It is not loosened.
- The plain words of an approval are a model's. They can be wrong. The exact
  action under them is what is approved.
- A second instruction while one is running is not queued: it is not
  started, and the notch says what is still running.
- "What was understood" in the ledger is a second, small model's one
  sentence about the words, made beside the turn. It is not a record of what
  the agent that acted understood, because the product keeps none. For
  "Remember that..." it is exactly what was stored.
- The answer is the text after the last thing the turn did. If an agent's
  late progress arrives after its last words, the whole reply is shown.
- The words do not appear while they are spoken: only when the keys come up.
  No speech-to-text provider here streams.
- The microphone stays open until the keys come up, also after Esc turned the
  line away. What it records then is dropped by the brain unread, but is sent.
- The Windows foreground rule may refuse the notch the keyboard when Home is
  opened with the keys and not with a click. Then a click on the field takes
  it, as before.
- The old summon hotkey still opens the microphone and answers in its bubble,
  in writing. It is a second way in, with its own history.
- The talk path was written against a stand-in microphone. The first real
  one it met, a Logitech C270 webcam across a desk, showed the fixed voice
  level of the first build (500, taken from the one-shot capture) to be
  wrong: speech hardly reached it and every recording was thrown away as too
  little. The level is now relative (invariant 32). It has been measured on
  no other microphone.
- A room that is steadily louder than a level of 500 is all voice to the
  measure, speech or not. Then the recording is sent, and what was said is
  left to speech-to-text.
- Today (the list under Home's text field) holds approved actions and kept
  promises only. Work that needed no
  approval is in the audit trail by tool name, with no sentence to show.
- The keys were tried by hand on one Windows 11 machine. The macOS tap has
  never run.
- The existing Ctrl + Shift + Space hotkey is untouched and still does what
  it did.
- What the prototype drew outside the black shape is not there: the soft
  shadow under the notch, and things arriving along the whole top edge of the
  screen. The window is 800 pixels wide, so an arrival starts at its edge.
- A brain that restarts forgets the line. Only the desktop app restarting is
  covered.
- Two desktop apps on one brain show the same line, and the first answer is
  the one that counts. Nothing yet tells the other notch that it was answered.
- On Windows the last 1.5 CSS pixels inside the edge belong to the backdrop
  window, not the page (see "How the edge is drawn"). That band is always
  black, whatever the page paints there.
- The smooth edge and the pointer feed have run on one Windows machine (a
  2560 by 1440 display at 100%). Outline points with fractions of a pixel have
  not: they were added after that run, because corners sent on whole pixels
  read as polygons.
- The fullscreen rule was rebuilt twice on evidence from one machine. "The
  display is being kept awake" alone failed because some other program held
  the display all day, so a browser in fullscreen lost the notch. "The picture
  keeps changing" alone failed because much of what people watch barely moves:
  a fullscreen video kept the notch. What the present rule cannot tell:
  - A muted video that does not move at all keeps the notch.
  - The notch stays over a film until the player hides the pointer, about
    three seconds after the hand leaves the mouse, and returns about five
    seconds after the pointer is back in view.
  - With the pointer resting on another display the rule asks for sound and a
    moving picture together, so a still video keeps the notch then.
  - An app that hides the pointer while typing and is also playing sound (a
    document in a fullscreen browser with music in another tab) reads as a
    video once the typing stops.
  - A Store app's window belongs to a host process, so for it any program's
    sound counts.
  - Sound is asked of the default output device only.
- The log names the program and window class in front each time the rule
  hides the notch, says at start whether the display was already being kept
  awake, and while a fullscreen app is in front writes what it saw every two
  seconds for the first twenty (`looking at chrome: hands off ..., pointer
  hidden ..., app sound ..., picture change ..., video ...`).
- **macOS (`sidecar/notch_host_darwin.go`) compiles in CI and has never been
  run.**
- On Linux the window opens as an ordinary always-on-top panel: no shape, no
  focus rule, no fullscreen rule.
- There is no per-machine opt-out: every desktop app that advertises the
  capability is told to host it when the brain's switch is on.

## Messages

| Direction | Message | Params | Answer |
|---|---|---|---|
| brain to desktop app | `notch.configure` | `{enabled: boolean}` | `{configured: true, enabled, surface: "none" \| "window", keys: "none" \| "watch" \| "blocked"}` |
| brain to desktop app | `notch.spawn` | `{url: string}`, on the brain's origin | `{spawned: true, already: boolean}` |
| brain to desktop app | `notch.close` | none | `{closed: boolean}` |
| brain to desktop app | `notch.push` | `{message: any JSON}`, for the page | `{pushed: true}` |
| brain to desktop app | `notch.open_dashboard` | none | `{opened: boolean}`. Opens the dashboard's window, as the tray's entry does. Decides nothing |
| desktop app to brain | event `notch.message` | `{message: any JSON}`, from the page | none |
| desktop app to brain | event `notch.talk` | `{phase: "start", talk_id}`; `{phase: "end", talk_id, voiced_ms, duration_ms, sample_rate, reason: "released" \| "cap"}` with the recording as 16-bit mono PCM, or with none when it is too little; `{phase: "cancelled", talk_id}`; `{phase: "refused", reason: "muted" \| "busy" \| "error" \| "none"}` | none |
| brain to desktop app | `register_ack` field `notch` | `true` when the switch is on; absent otherwise | The desktop app does not open the microphone for the wake word |

The page talks to the desktop app through six functions on `window`:

| Function | Meaning |
|---|---|
| `__notch_set_outline(shapes, cuts)` | Two lists of closed polygons, each polygon `[[x, y], ...]` in the window's own pixels (CSS pixels times the display scale). Fractions of a pixel are kept and matter: send a curve as it is, with a point about every pixel and a half, not moved onto whole pixels. `shapes` is the notch's true silhouette: its body, and any small shapes on the screen's edge beside it. `cuts` is the same 1.5 CSS pixels in, and may hold fewer polygons or none. Shapes that overlap are joined. Both lists are checked; if either is refused, nothing changes |
| `__notch_focus(true \| false)` | Take the keyboard for a text field, or give it back. Answers whether the notch has it |
| `__notch_send(text)` | One message for the brain, as JSON text |
| `__notch_esc(true \| false)` | Whether Esc would do anything on the notch right now. Only then is it taken from the app in front |
| `__notch_keys()` | Answers the machine's two pairs, `{talk: [a, b], yes: [a, b]}`, each key one of `ctrl`, `alt`, `meta`, `shift` |
| `__notch_log(text)` | One line in the desktop app's log, for test runs |

and the desktop app calls four functions the page defines:

| Function | Meaning |
|---|---|
| `window.__notch_receive(message)` | One message from the brain |
| `window.__notch_key(name)` | What the keys said: `talk-start`, `talk-end` (let go), `talk-cancel` (ended by a slip), `yes`, `esc`, `esc-twice` |
| `window.__notch_pairs(pairs)` | The pairs changed in the settings: same shape as `__notch_keys()` answers |
| `window.__notch_cursor(x, y, down)` | Where the pointer is, in the page's own pixels from the window's top left corner, and whether the main mouse button is down (1 or 0). Sent about 30 times a second, and only when something changed. The page hears the mouse only inside its outline, so this is how the eyes follow the pointer across the screen, and how a click in the app underneath closes a sheet |

## What the brain and the page say to each other

Version 1, in full in `src/notch/protocol.ts`. One thing is on the notch at a
time; a new `show` replaces it.

| From | Message | Meaning |
|---|---|---|
| page | `hello {v}` | The page is up. Answered with `state` |
| brain | `state {line, count, born, face}` | Everything the notch should show, at once |
| brain | `show {line}` | Put this on the notch |
| brain | `rest` | Back to the eyes |
| brain | `count {count}` | How many things wait |
| brain | `face {mood}` | The face the notch has at rest until told otherwise: `closed` while everything is stopped. Kept by the brain, unlike a mood given with `act` |
| brain | `update {id, ...}` | Change the line on the notch in place: steps done, a new sentence, words heard, a sheet's content |
| brain | `act {...}` | A face, a movement, a birth, the watching eye, the mouth, sounds. Not remembered |
| page | `answer {id, act, ...}` | What the person did with the line `id` |
| page | `open` | A click on the resting notch, or yes with nothing on it |
| page | `stop` | Esc twice: stop everything, and start nothing until told |

A line is one of seven kinds: `say` (a result that leaves by itself), `offer`
(yes or no, or a row of choices), `sheet`, `ask` (a text field), `work`
(steps), `send` (a window to take it back) and `listen`. A sentence is made
of plain words, `em` words, keycaps and lit words the person can change.

A line marked `unasked` came by itself: the page takes no yes on it for
0.7 s.

After `no`, `fold`, and a `say` that finished, the page has gone to rest by
itself. After any other answer it keeps the line until the brain says what
comes next.

## How the edge is drawn

A window cut to a polygon has a stepped edge: each pixel is in or out.

- **Windows.** A second window sits directly behind the page's window. It is
  drawn pixel by pixel with partial transparency along the edge
  (`sidecar/notch_raster.go` works out how much of each pixel the shape
  covers, from the outline's exact points), never takes clicks, and never
  takes the keyboard. The page's window
  is cut to `cut`, just inside it, so the stepped cut is hidden on black. The
  two windows are tied together as owner and owned, so they keep their order,
  and they are shown and hidden together.
- **macOS.** The page's window is masked by a shape layer, which is smooth
  already. Only `shape` is used.

## Trying a build

One command builds the desktop app from the checkout and runs the brain with
the switch on, against data kept apart from any installed Jarvis:

```sh
scripts/notch/try.sh
```

- **On WSL** it cross-builds the Windows desktop app into
  `%USERPROFILE%\JarvisNotchDev`, prints an enrolment token the first time,
  starts the brain on port 3143 with its data in `~/.jarvis-notch`, and then
  starts the desktop app. The first time, a window asks for the token. An
  installed Jarvis has to be quit from the tray first; a test build that is
  still running is stopped and replaced.
- **On a Mac** it builds `~/JarvisNotchDev/Jarvis.app` and writes
  `start-sidecar.command` beside it. Quit Jarvis from the menu bar, then run
  that file and paste the token. The Mac path has not been run yet.
- The test build has its own profile folder. It cannot run beside an installed
  Jarvis on Windows (single-instance lock). Leave "start at login" off in it.
- `--token` prints a fresh token, `--no-build` skips the desktop app build.
  `NOTCH_DATA_DIR`, `NOTCH_PORT`, `NOTCH_WIN_DIR` and `NOTCH_MAC_DIR` override
  the defaults.

### Playing the demo

With that brain running, in a second terminal:

```sh
scripts/notch/demo.sh            # a menu of moments
scripts/notch/demo.sh mail       # one moment
scripts/notch/demo.sh stop
```

It is `jarvis notch demo` pointed at the test brain. `try.sh` makes the secret
the first time and keeps it in the test data folder. Against any other brain:
start it with `JARVIS_NOTCH=1` and `JARVIS_NOTCH_DEMO=<16 or more characters>`,
and run `jarvis notch demo <moment>` with the same `JARVIS_NOTCH_DEMO` set.

### Making real things to try it on

The demo plays sample sentences. Fixtures make real records, found and
answered through the product's own code (`src/notch/fixtures.ts` says what
each does, and that it is harmless):

```sh
scripts/notch/fixture.sh               # a menu
scripts/notch/fixture.sh approval      # an approval a key may answer
scripts/notch/fixture.sh approval 3    # three, for the count and the round
scripts/notch/fixture.sh command       # an approval to run one shell command: echo notch test
scripts/notch/fixture.sh payment       # an approval that is a payment; no money moves
scripts/notch/fixture.sh promise 30    # a promise due in 30 s (two minutes when not said)
scripts/notch/fixture.sh failure       # one failure in the list of open failures
scripts/notch/fixture.sh elsewhere     # approve the fixture approval on the notch as a dashboard click would
scripts/notch/fixture.sh log           # one line per promise that ran
```

It is `jarvis notch fixture` behind the same secret as the demo. A fixture
promise is kept by adding one line to `notch-fixture.log` in the data
directory, with no model: the file is the proof that it ran once. Before
setup is complete the promise executor is not running; with the demo gate
open it runs for fixture promises alone.

### Asking without a model key

A test brain has no model and no speech-to-text until keys are typed into
its dashboard. Until then an instruction on the notch answers "No model is
set up yet", and yes opens the dashboard. To try the path without keys there
is a stand-in model: it answers from a script written in advance, and
nothing thinks.

```sh
scripts/notch/standin.sh load                          # the sample script, scripts/notch/standin.json
scripts/notch/standin.sh type "what is two plus two"   # as if typed in Home
scripts/notch/standin.sh say "what is two plus two"    # as if spoken, from after the microphone on
scripts/notch/standin.sh say                           # a recording in which nothing was caught
scripts/notch/standin.sh list                          # the script, and the calls the stand-in received
```

With the sample loaded, typing on the notch itself works too: "what system
is this" runs a real tool and answers in a sheet, "run the test command"
stops for an approval first, "explain the notch" is a long answer, "Remember
that Anna prefers calls." writes one fact. Once a real model is set up the
brain refuses all of this.

The page can also be tried without the desktop app or a brain, in a browser.
The preview runs the real page with the brain's own demo scripts, and can draw
the outline the desktop app would be given over what the page paints:

```sh
bun ui/src/notch/preview/serve.ts
```

### When Windows refuses the build

A local build of the desktop app is not signed. On a Windows machine with Smart
App Control switched on, each unsigned program is judged by itself: some builds
run and some are refused with "An Application Control policy has blocked this
file". `try.sh` checks for this after building and stops with a message, and
Windows records it in the event log under Applications and Services Logs,
Microsoft, Windows, CodeIntegrity, Operational (events 3077 and 3033).

There is no way around it from this side, and there should not be. The choices
belong to the machine's owner and to whoever holds the signing key:

- test on a Windows machine where Smart App Control is off, or
- have the test build signed. Release builds are signed in CI by a protected
  `signing` environment that is limited to `main` and release tags, so a branch
  build cannot use it as things stand.

With the switch on and a current desktop app connected, the brain prints:

```
[notch] switch on
[notch] "notch-dev" ready, surface: window
[notch] "notch-dev" is showing the notch
```

and the desktop app's log (`profile\.jarvis\sidecar.log` in the test folder)
has the window's size and place, what the page measured, each time the
keyboard was taken or given back, and each time the fullscreen rule hid or
showed the notch.
