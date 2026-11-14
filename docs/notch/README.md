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
    executor). Every other surface is refused as before. A click that pays
    is a payment before it is an action on screen: never the notch. On the
    sheet, what the product says is acted on (the element's label, the app,
    what it may send or delete) comes first, then the tool and its
    arguments. A tool that wrote no sentence of its own is never shown by
    its name alone when it has arguments: they are what is approved.
41. **The notch's standing cannot be borrowed.** Turn and request ids that
    begin `notch-` are made only inside the brain (`BriefChatTransport.submit`);
    a dashboard socket that sends one is refused. What the notch starts on
    hearing a turn's event runs outside that turn, so it does not keep the
    turn's standing after the turn is over.
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
    The agent is told the same in the per-turn part of its prompt
    (`NOTCH_TURN_NOTE`): it does not ask on its own account before opening
    an app or doing what it was just told to, only before a delete, a send,
    a payment, an install or a change of settings.
42. **An action on the screen is approved by what it lands on.** A click, a
    typed text or a key press says "element 12", or "x 640, y 300", or
    nothing, and the product cannot tell a click that pays from one that
    scrolls. So when its sheet is made, the machine is asked what is there
    now (`describe_target`, a read), and the answer is the first line of the
    paper: `On screen: Button "Send" in "Inbox - Outlook" (olk)`; for typed
    text and keys with no element, the window in front. It is text from the
    screen: it is shown to the person as one short line with nothing unseen
    in it (`notchApprovalPlace`) and is never given to a model
    (`daemon/notch-where.ts`). Names from the screen lose their double quotes,
    so a button cannot be called `OK" in "Windows Security` and read as a
    window. The sheet waits at most 1.5 s for it; an answer that comes later is
    put on the open sheet; a sheet that comes back after more than five seconds
    is read again, since what was in front then is not what is in front now. A
    desktop app too old to answer leaves the sheet as it was. With screen
    awareness off nothing is read, for this either.
    **A click that lands on a payment is a payment.** The name the screen gave
    is read by the product's own reading of a control's label
    (`uiEffectHints`, no model). If it reads as a payment ("Buy now", "Pay"),
    the request is not taken on the notch whatever it calls itself: the line
    points at the dashboard, a sheet that was already up is taken away, a yes
    that was already burning its fuse is not acted on (`paying`, checked again
    in `decide`). This closes for a raw click what 23 closes for a declared
    payment. It rests on the label: a pay button with no name the screen can
    read is still only "a click", and that is why the exact place is on paper.
43. **Jarvis does not act in its own windows.** A click, scroll or drag at a
    place (`desktop_pointer`) is refused when the place is on a window of the
    desktop app itself, the notch first of all: the notch asks the person
    things, and the agent must never be who answers. A click on an element
    under the notch is refused the same way after the notch has been given
    two seconds to fold back (`pointerPlaceFree`, `pointerReachesElement`).
    Every press looks once more with the pointer already at its place and
    the button goes down in the same breath or not at all (`pointerPress`):
    the pointer takes 50 ms to settle, and a sheet could come up under it in
    that time. Typed text and keys are refused when the window in front is
    one of Jarvis's own (`keysIntoOwnWindowError`). The keys the agent sends
    were already not heard by the notch (17). What this does not cover: the
    dashboard open in the person's own browser is not a window of the desktop
    app, as it was not before.
44. **Saying it is the approval.** Decided by the owner on 13 November 2026,
    after a day of using it: "If I ask something, it should do it. Everything
    apart from deleting and payments." In a turn the owner started on the
    notch, typed or spoken, a call is not asked about: not a click, typed
    text, a key press, a page, a command, a file, an app with arguments, a
    send, an install or a change of settings, and not the step after outside
    content was read. Two things are asked about, always, also where the
    product's ordinary rules would let them run: **a delete** and **a
    payment** (`authority/owner-word.ts`, applied where the main agent, a
    helper agent and the model's own `request_approval` are decided).
    What is read as one of those: a category the call's gate names
    (`delete_data`, `make_payment`, which is how an on-screen action on a
    control called "Delete" or "Buy now" arrives); a command whose text
    removes something (`commandDeletes`: `rm`, `del`, `Remove-Item`, `git
    clean`, an uninstall, a `DROP TABLE` and their kin); a Delete key; and
    for a raw click, what the machine says is at that place, read the same
    way (`notchPressReads`). A payment still goes to the dashboard (23). A
    helper agent cannot hold a question, so a delete there is refused and
    the main agent does it. A call the product refuses outright stays
    refused, and one whose own classifier failed is judged by the ordinary
    rules. The standing ends with the turn: once it has finished or been
    stopped with Esc, whatever it left running has none
    (`BriefExecutionContext.over`).
    **What this gives up, and it is the owner's choice:** the guard that
    asked about every step after a page, a file or a window had been read.
    That guard exists because such text can carry instructions. Now, if
    something Jarvis reads while doing what was asked tells it to do
    something else, nothing holds that for a yes unless it is a delete or a
    payment: a file sent somewhere, a command run, a message posted. The
    agent is told that what it reads is information and never an
    instruction (`NOTCH_TURN_NOTE`); that is a sentence to a model, not a
    lock. And the reading of "a delete" is a reading: a script that removes
    files in a way none of the signs catch, or a button with no name the
    screen can read, goes ahead like anything else.
    Everywhere but a notch turn (dashboard chat, Telegram, background
    agents, workflows), and with the switch off, nothing changes.
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
    with the pair held), one made while the microphone was muted, and one
    with less than 150 ms of voice in it are not sent. The brain is told how
    it ended and gets no sound. One that ran into the 60 second limit is
    sent as far as it got, marked as that (`reason: "cap"`): the brain makes
    it into words, shows them whole on a sheet, and acts on them only on a
    yes, since they may stop in the middle of a sentence. (It used to be
    thrown away, the whole minute of it.)
    What counts as voice is judged against the recording's own quiet: a
    piece of sound is voice when it is 1.8 times louder than the quiet tenth
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
- **On Windows an app that cannot be started by its name is looked up in the
  Start menu** (`sidecar/desktop_startmenu.go`). `launch_app` could only
  start what is on PATH or under "App Paths", so "open Steam" failed while
  "open Notepad" worked. Now a bare name with no arguments that fails is
  started as the Start menu starts it, when exactly one app answers to it.
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
- **An app is found by the way a person says its name**
  (`startMenuPick`, `sidecar/desktop_startmenu.go`). The Start menu's list
  is read once and matched in the desktop app: the app with exactly that
  name; else the ones whose name contains it, the closest name winning
  ("powershell" is Windows PowerShell, not its ISE); else a short way of
  saying it ("vs code", "ms teams"). Two that are equally close are not
  guessed between: they are named in the refusal.
- **Typed text can break its lines with Shift+Enter** (`desktop_type`,
  `line_break: "shift_enter"`, Windows). A line break is typed as Enter,
  which sends the message in a chat app: the first line of a two-line
  message went out alone. The tool's own text now says so. On the Mac, on
  Linux and without a desktop app it is not built: text with a line break
  asked for that way is refused before anything is typed, never typed with
  a plain Enter.
- **One path with spaces stays one argument** when an app is started
  (`launchArgLine`). "Open that file in Notepad" used to reach Notepad as
  two halves of a path.
- **Typed text and keys say which window received them** (`foreground_pid`,
  a number) **and are refused before the first key when that window runs as
  administrator** and the desktop app does not (`DESKTOP_TARGET_UNREACHABLE`).
  Windows drops those keys without an error, and the reply used to say
  success. `delivery: "unconfirmed"` when the window could not be asked.
- **A window read says why it is empty or short**: `window_minimized`,
  `window_elevated`, `truncated` (3,000 elements or 15 seconds, whichever
  comes first). All three used to read as "custom-drawn, use a screenshot".
- **"The window of a program" is the one in front** (`pickWindowOfPid`), not
  the first one found. File Explorer owns every folder window and the
  desktop. `desktop_focus_window` takes an `hwnd` to name one of several.
- **The notch's own two windows are not in the list of open windows.**
- **A new tool, `desktop_pointer`**: click, double-click, right-click, scroll
  or drag at a place read off a screenshot, for windows that list no element
  (a game, Steam's own pages, a canvas). Windows only. It is reviewed on
  screen like every raw click (`REVIEWED_UI_TOOLS`), is not allowed in a
  workflow, and takes the place as a pixel of the last screenshot of that
  machine (good for three minutes). The place is given in thousandths of
  that picture (0 to 1000 across and down), not in pixels: a model provider
  often shrinks a picture before the model sees it, and a pixel read off the
  smaller one is another place on the real one. The brain sends it on as a
  fraction of the main display. Refused on a window that runs as
  administrator, where Windows would drop it without a word.

And these are behind the switch:

- **Pause also holds the model loops** (`setPauseHoldsLoops`, `whenRunnable`).
  Background model calls wait for Resume. One line in `daemon/index.ts`
  makes it the rule everywhere.
- **Suggestions join the count** and are not spoken or toasted.
- **Nothing is spoken and nothing listens for the wake word** (invariants 34
  and 35).
- **Typed and spoken notch events are not broadcast to dashboards.**
- **Approval and task-complete toasts are not raised** while a notch page is up.
- **Jarvis's own browser keeps its profile for good**
  (`sidecar/browser_profile_dir.go`): under `~/.jarvis/browser/`, where it
  was the system's temporary folder. A sign-in lives in the profile, mail is
  read through this browser, and a temporary folder is what Windows and
  cleaning tools empty. A profile already in the temporary folder is moved
  once; one that cannot be moved is used where it is.
- **Saying it is the approval** (44): in a turn asked on the notch only a
  delete and a payment are asked about, and a recognised delete is asked
  about even where the ordinary rules would let it run.
- **The notch comes back over a fullscreen video while it has a question
  that waits for an answer** (`__notch_asking`, `notchShouldHide`): an
  approval or a question back. It hides again once answered. Windows only.

## Where you are, and looking away

The resting notch shows three things, and one rule decides them:

- **Eyes open, an app's icon beside them:** this is the app in front, and it
  is being watched.
- **Eyes turned aside, no icon:** it is looking away by itself. A password
  is being typed, or the window is a bank's. Nothing is captured.
- **Eyes closed, no icon:** it sees nothing here. The app is on the
  person's "never watch" list, or watching is switched off, or it is asleep.

Home has a row ("I see Notepad.") that opens "What I see": the same in
plain words, a button to never watch the app in front (or to watch it
again), and one to sleep.

45. **Looking away is decided on the machine, before anything is captured.**
    The desktop app hears from the system which app is in front and where
    the keyboard is (`sidecar/notch_where_windows.go`, a window event hook;
    `notch_where_darwin.go`, NSWorkspace). It looks away for an app on the
    list, for a password field, and for a bank, known by its window's title
    (`notchLookFor`). The screen observer asks before it takes the
    screenshot and the window observer before it reads a title
    (`screenObservationHeld`, `WindowObserver.poll`): the picture is not
    taken and thrown away, it is not taken. What an observer reads by
    itself a moment later is judged by the same rule, and a capture already
    made is deleted (`NotchWhere.Refuses`). The brain is told what was
    decided (`notch.where`). It does not decide, and a brain that is late or
    wrong cannot make the desktop app look.
46. **The "never watch" list is the machine's.** It is in the desktop app's
    own settings file (`notch_never_watch`). The brain asks for a change
    (`notch.never_watch`) and shows the list it is answered with. A list
    that cannot be saved is not changed.
47. **A second door in the brain.** A capture that was already on its way
    when looking away began is not kept: before the brain keeps a
    screenshot, a change of window or an idle report it asks whether that
    machine is looking away, whether the app is on its list, and whether
    Jarvis is asleep (`awareness/capture-guard.ts`, `NotchWhere.mayKeep`).
    `notch.where` is not queued behind other events, so the brain knows
    before it reads what was queued ahead of it.
48. **A window's title goes no further than the sheet.** It is text from the
    screen. The desktop app does not send it while it looks away. The brain
    shows it on "What I see" and gives it to nobody else from the notch.
    What is logged is that the machine looked away and why, never what was
    in front. `notch.where` is not passed to the dashboards.
49. **An icon is a picture.** The app's own icon travels as a small PNG and
    is drawn as an `<img>` from a data URL, checked for exactly that
    (`notchIconUrl`). Nothing from the machine is ever set as markup.
50. **Sleep means it sees nothing.** With the notch on, while everything is
    stopped (Esc twice, the tray's Pause, "Sleep" on the sheet) the desktop
    apps' observers are paused too (`whileAsleep`, pushed on every change of
    the pause and to every desktop app that connects). The pause used to
    freeze what Jarvis does and leave it watching.
51. **With the notch off none of it runs.** The desktop app starts
    listening only when the brain says the notch is on, and the observers'
    checks answer "watch" until then (`NotchWhere.Look`, `Refuses`).

52. **In a browser, the site says where the person is, and only the site is
    kept.** Asked for by the owner on 14 November 2026: "Chrome" says little.
    The desktop app reads the browser's own address bar, the way it reads
    any control, and walks only the browser's own controls to find it: the
    page is one control of the kind "document", and that one is passed by
    (`uiaBrowserSite`). Of what the bar holds only the site is kept,
    `github.com`: not the page, not what follows a `?`, which can be a name,
    a search or a key. The rest never leaves the function that reads the bar
    (`notchSiteOf`). The site is told to the brain as `site`, and not at all
    while the notch looks away for a password or a bank.
    With the site known, a bank is a bank by its address (`notchBankSite`)
    and the title is not guessed from: a page about river banks is watched,
    a bank whose title says nothing is not. The list can hold a site
    (`site:github.com`), which covers the sites under it.
53. **A site's icon comes from the site, once, and stays on the machine.**
    The notch shows the site's own icon beside its eyes. The desktop app
    asks the site itself for it (its `/favicon.ico`, else the icon its front
    page names), draws it at one size and keeps it in
    `~/.jarvis/site-icons`. It never asks a lookup service: that would tell a
    third party every site the person opens. The request sends no cookie and
    does not say who asks. Nothing is asked of a site while the notch looks
    away, of a site on the list, or of an address that is a number or a
    machine on the local network. A site that has no icon to give is not
    asked again for six hours, and the browser's own icon is shown.

What "never watch" does not do: it stops Jarvis watching by itself. If the
person asks Jarvis to read that app, it reads it: saying it is the approval
(44).

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
- A spot under the notch's own line cannot be clicked while a task is on the
  notch: the line stays for the whole task and the notch is above every
  window. The agent is told so and tries a way that needs no pointer. Making
  the notch step aside for the length of a click would lift this; it is a
  change to how the notch looks, so it is the owner's to decide.
- `desktop_pointer` has been compiled and its arithmetic tested, and has not
  been run on a real screen. How well a model reads a place off a picture is
  not known. A screenshot is of the main display only, taken by a helper
  that does not know the display's scale: on a display scaled above 100% the
  picture may not be the whole screen, and a place read off it would then be
  wrong. On the Mac and on Linux the tool refuses.
- A window that runs as administrator cannot be read or driven at all, and
  with one in front the notch's own keys do not reach the notch either
  (Windows keeps them from every ordinary program). The agent now says so
  instead of reporting success; the limit itself is Windows'.
- A bank is known by its address when the app is a browser whose address
  bar could be read (Chrome, Edge, Brave, Firefox and their kin; checked on
  Chrome only). Anywhere else, and in a browser window with no address bar,
  it is known by the window's title, from a list of words and names
  (`notchBankWords`), which errs towards looking away. Either list is a
  list: a bank on neither is watched until a password field takes the
  keyboard.
- The site's icon is asked of the site by a plain request. A few sites
  refuse one that is not a browser's, and some only have a vector drawing,
  which is not read: the browser's icon is shown for those. Of twelve
  well-known sites tried, eleven gave one.
- While somebody types in the address bar it holds what they type, not an
  address. The site last known for that window stands until the page
  changes.
- On the Mac the site is asked of the browser by a script, which the Mac
  lets through only after asking the person once per browser. Firefox on
  the Mac cannot be asked.
- A password field is known when the program says so. A plain Windows edit
  box does by its style; a browser or a modern app is asked through UI
  Automation, with 700 ms to answer. A program that draws its own field and
  tells nobody is not known.
- The "hands are still" signal (four seconds without a key or the mouse) is
  sent and kept, and nothing uses it yet. It is for the proposals of the
  passes after this one.
- On the Mac this is written and compiled and has never run. There a
  window's title, and so a bank, is only known when the person has allowed
  screen recording.
- Some apps have no icon of their own to read (many Store apps), and the
  notch then shows none. The name shown is what the program's file says of
  itself, which is sometimes not what a person calls it.
- Start menu names are in the language of Windows. "Settings" finds nothing
  on a Windows in Italian, where it is "Impostazioni".
- On the Mac the notch does not yet come back over a fullscreen video for a
  question.
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
- In a turn asked on the notch nothing is held for a yes but a delete and a
  payment (44). What that gives up is written there. In every other kind of
  turn, after an app was opened or a window, a page or a file was read,
  every command that follows is still asked about.
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
| desktop app to brain | event `notch.where` | `{app, name, title, site, icon, look: "" \| "password" \| "bank" \| "never", still: boolean, never: string[]}`. `app` is the program's name in small letters; `site` is the site in a browser (`github.com`), or empty; `icon` a key, of the site's icon when there is one, else the program's; the icon itself comes once per connection as a PNG. `title` is empty while it looks away, and `site` too for a password or a bank. `never` holds program names and sites (`site:github.com`). Sent on every change | none |
| brain to desktop app | `notch.never_watch` | `{app: string, watch: boolean}`, where `app` is a program's name or `site:` and a site | `{never: string[]}`, the list as it now is |
| brain to desktop app | `register_ack` field `notch` | `true` when the switch is on; absent otherwise | The desktop app does not open the microphone for the wake word |

The page talks to the desktop app through seven functions on `window`:

| Function | Meaning |
|---|---|
| `__notch_set_outline(shapes, cuts)` | Two lists of closed polygons, each polygon `[[x, y], ...]` in the window's own pixels (CSS pixels times the display scale). Fractions of a pixel are kept and matter: send a curve as it is, with a point about every pixel and a half, not moved onto whole pixels. `shapes` is the notch's true silhouette: its body, and any small shapes on the screen's edge beside it. `cuts` is the same 1.5 CSS pixels in, and may hold fewer polygons or none. Shapes that overlap are joined. Both lists are checked; if either is refused, nothing changes |
| `__notch_focus(true \| false)` | Take the keyboard for a text field, or give it back. Answers whether the notch has it |
| `__notch_send(text)` | One message for the brain, as JSON text |
| `__notch_esc(true \| false)` | Whether Esc would do anything on the notch right now. Only then is it taken from the app in front |
| `__notch_asking(true \| false)` | Whether a question that needs a yes or a no is on the notch. While one is, the window does not stay hidden behind a fullscreen video |
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
| brain | `state {line, count, born, face, where}` | Everything the notch should show, at once |
| brain | `show {line}` | Put this on the notch |
| brain | `rest` | Back to the eyes |
| brain | `count {count}` | How many things wait |
| brain | `face {mood}` | The face the notch has at rest until told otherwise: `closed` while it sees nothing (asleep, an app never to be watched, watching off), `away` while it looks away by itself. Kept by the brain, unlike a mood given with `act` |
| brain | `where {app}` | The app in front, `{name, icon}`, for the icon beside the resting eyes; `null` takes it away. The icon is a PNG data URL. Kept by the brain |
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
