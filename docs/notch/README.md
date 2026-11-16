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
    model (invariant 37). A fourth route behind the same secret, `POST
    /api/notch/study`, is for the mail study (below): on a brain whose owner
    signed in to Gmail in Jarvis's own browser it reads that mail, reads the
    calendar and calls the model. Its `navigate` opens no address but
    `https://mail.google.com/`, and it runs only the page scripts in
    `src/notch/mail/page/`. One of those, `site.js`, takes the same signed-in
    browser to Google Calendar and Google Drive and nowhere else (a test
    holds that no other script leaves the site it is on, and that these three
    hosts are the whole list). It sends nothing. The server lets these four
    paths past its own sign-in only while the gate is open
    (`notchGatedPath`), and a test holds every route behind the gate to that.

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

## Mail: Jarvis goes first

From pass 7 the notch says "You have not replied to Marco. I drafted a
reply." about the person's real mail. The parts are in `src/notch/mail/`:
`watch.ts` looks at the mailbox on a clock and decides, `waiting.ts` is the
rule for "a person is waiting", `proposer.ts` is the one model call,
`store.ts` is what is remembered, `mailbox.ts` reads and writes through the
browser, `notch.ts` is the line, and `attach.ts` puts them together.

54. **Jarvis looks at the mail by itself.** Decided by the owner on 15
    November 2026: it has to know that it needs to check mail periodically,
    through a connection when one exists and in the browser when not. So
    nothing waits for the person to open Gmail. A glance at the top of the
    list every minute, the last two days every five, the whole month when
    the brain starts and every six hours (`MAIL_GLANCE_MS`, `MAIL_RECENT_MS`,
    `MAIL_SWEEP_MS`). One look at a time; none while everything is stopped,
    and none while no real model is set up, since nothing could be prepared.
    The way is chosen each time with `firstWay`: a connection first, the
    browser tab second. No way is not an empty mailbox: a look that finds no
    way changes nothing and says so once in the log.
55. **A look reads little.** The list first. A thread is read only when the
    list shows it changed since it was last read (how many messages, who is
    shown last, a draft) and the one shown last is a person who is not the
    owner (`mailCandidate`, which leaves out only what the rule would leave
    out). On a real month that was 601 threads of 3,689. A reply that waits
    is checked the same way: its thread is read when the list shows it
    changed, and a full look checks every one. A message that is too new is
    remembered with the moment it will have waited long enough.
56. **A message is put to the model once.** One row per message a person
    waited on (`notch_mail_proposals`), whatever came of it: a reply is
    ready, the model said none is needed, or it gave nothing usable. What
    it cost is on the row, every redraft counted, and Today shows it for
    what was sent. There is no cap (the owner's decision G).
57. **The notch has a tab of its own.** The browser has one page that the
    agent drives. A look at the mail every minute in that page would pull it
    out from under whatever the agent was doing. So the desktop app keeps a
    second tab (`sidecar/browser_mail_tab.go`, calls `mail_tab_navigate` and
    `mail_tab_evaluate`, feature `browser_mail_tab`). It is taken to Gmail,
    Google Calendar and Google Drive and nowhere else; an address anywhere
    else is refused before the browser hears of it. A script runs in it only
    while it is on one of those three, and never on Google's sign-in page:
    there the answer is "signed out", and nothing is typed. Nothing is
    enabled on it, because the client wakes whoever waits for a browser event
    by the event's name alone and an event from this tab would be taken for
    one from the agent's page. An answer names the site, never the address.
58. **It never opens a window nobody asked for.** When no browser is running
    the tab's browser is started hidden. A browser started that way is not
    the one the person was promised: the first call for the agent's page
    that says nothing about visibility gets a visible browser, as it always
    did, and the hidden one gives way (`keepRunningBrowser`). The browser is
    started with background timers left alone, because the tab is never in
    front and its scripts wait on timers that Chrome would slow to one a
    minute.
59. **One thing has the tab at a time.** A look, a reading of the calendar, a
    search of Drive and a reply being sent all use the same tab
    (`MailTabTurn`). A reply holds it from its first step to its last, so
    that no look navigates away from a draft that is written and not yet
    sent, and what the person is waiting on goes before what Jarvis does by
    itself.
60. **Who a reply goes to is not a model's to decide, and is checked on the
    page.** `mailReplyTo` decides it from the message that is answered: the
    one who wrote, and in copy everyone else it went to, without the owner.
    Before the reply is written and again before Send is pressed, the page
    script (`page/reply.js`) reads who Gmail's own reply frame goes to and
    refuses unless it is exactly those people. It also refuses unless the
    thread on screen is the one meant and the text in the reply is the text
    that was shown.
61. **Two yeses and a fuse, and saying yes is the approval.** Yes on the line
    shows the draft, on paper, with who it goes to. Yes on the draft puts it
    in the thread as a draft in Gmail, burns a fuse of five seconds, and
    sends it. Nothing more is asked (44). Esc while the fuse burns takes the
    yes back and nothing else: the draft is removed from Gmail and the reply
    waits again. A fuse nobody saw burn out sends nothing. Esc before that
    is a no on a reply that was offered: on its line, and on the draft that
    line led to, the reply is turned down and does not come back (21). A
    draft the owner opened themselves, from the list or from Home's row, is
    closed by Esc and kept, and the key says so: the sheet's `no` word is
    "back" or "close" there. Found on the owner's first evening with it (15
    November 2026): ten replies were turned down in eleven minutes by the key
    that everywhere else means back. Under every draft is the link "Not
    needed", which is the no in words. Left alone, a line folds and waits.
62. **Sent means it is the last word in its thread.** Gmail saying "Message
    sent" is not taken for it: the thread is read again, and the reply is
    called sent when the owner's mail, sent since the yes, is its last
    message. If it cannot be sent the line says so and says where the draft
    is. A reply is never left half written: when a step fails, or something
    else takes the notch between the draft and the fuse, what was put in
    Gmail is taken out again.
63. **One reply per thread, asked again before it is shown.** A newer
    message in a thread overtakes the reply to the older one. Before a reply
    speaks up by itself the mailbox is asked whether it is still an answer to
    the last word, unless a look saw so in the last ninety seconds: nothing
    is said and then taken back. A reply the owner asks for (a row of the
    list, Home's row, the line they tapped the notch for) comes up at once
    and the mailbox is asked behind it. If it then says the thread moved on,
    the draft is taken away with the reason: "The thread has moved on since.
    This reply is no longer needed." Not known is not no. The question is one
    reading of the thread: whose mailbox it is was learned by the look.
    Measured on the owner's brain on 15 November 2026: one reading takes
    about 0.6 s, but it used to be three questions asked before the draft was
    shown, each waiting its turn behind a look through the month (59), and a
    draft took many seconds to open. Before a reply is written into the
    thread the mailbox is always asked. Once the owner answers by hand,
    begins a draft, or the other side writes again, the reply leaves by
    itself, within a minute.
64. **Mail is one thing on the notch, and it never stands in front of the
    text field.** Whatever is in the count comes before Home when the resting
    notch is tapped (26), and mail that nobody has answered is there every
    day: on the owner's mailbox the first look prepared about twenty replies.
    So the replies are one item, `mail`, and it is in the count only while
    there is a reply the owner has not seen. A reply has been seen once its
    line came up or it was a row of the list they opened, whatever they did
    then. After that it waits in Home, under the text field, as one row for
    all of them ("3 replies drafted"), which opens the reply or the list. It
    is kept, it is not said again, and Esc on the line about several, or on
    the list, turns nobody's reply down: each is turned down on its own
    draft. What has been seen is remembered until the brain restarts.
65. **Coming to Gmail, a reply speaks up.** The desktop app says which site
    is in front (pass 6). Coming to `mail.google.com`, the newest reply the
    owner has not seen takes the notch when the notch lets it (66), as the one
    line "You have not replied to Marco. I drafted a reply." A reply prepared
    while Gmail is in front speaks the same way. Tapping the notch shows what
    is unseen: one line when one is, "3 people are waiting for a reply. I
    drafted them." and a list when several are. With nothing waiting it says
    "Nobody in your mail is waiting for a reply", once in thirty minutes and
    only when a look reached the mailbox; when none did, it says that it
    cannot see the mail. While the desktop app looks away the site is not
    known, so nothing is said. From pass 8 a reply to a mail that has just
    come also speaks from anywhere (69).

What a draft says besides the reply. Above the paper, one sentence that
says what the thread is ("James wants your time zone so he can send the
invite"): `about`, at most 160 characters, asked for in the same model call
as the draft. The list shows it in place of the subject. A reply prepared
before replies carried one gets it from a small call of its own
(`mailAboutMessages`), at most eight a look and asked once per start of the
brain. Under the paper, what Jarvis did not know, with the word "tell me":
the owner types it (up to 200 characters) and the reply is written again
with it. What they told is shown ("You told me: ... change") and kept with
that reply. It is not remembered for the next one.

What reaches the model, and how: the thread as text, inside the marks for
outside content (`wrapUntrusted`); links as their words and their address;
the names of attached files; the calendar; the owner's time zone; and a few
of the owner's own mails for their voice. What the owner told for a reply
reaches it as theirs, outside those marks. The tone the owner picks on the
notch is one of four fixed manners. What the model answers is a draft, what
it did not know, and the sentence about the thread, and nothing else: not
who it goes to, not whether it is sent. A sentence that carries the marks of
outside content is not shown.

To try a build without waiting four hours for a test mail: start the brain
with `JARVIS_NOTCH_MAIL_WAIT_MINUTES=2` (honoured only on a development brain,
where the demo gate is open). To check a build from the command line, numbers
only: `bun scripts/notch/mail-study.ts tab` (is the tab there and signed in)
and `bun scripts/notch/mail-study.ts watch sweep` (one look, and what the mail
layer has done so far).

What is not done, or not proven:

- **Writing and sending through the tab has been run on one mailbox.** On
  15 November 2026, with the owner's yes, on a thread with themselves: a
  draft written, saved and thrown away; then one reply sent, the thread one
  message longer, one recipient, no draft left. The same evening the owner
  sent one reply to another person from the notch. That is one account and
  one build of Gmail. A step that does not find what it expects refuses and
  says so; it does not guess.
- **The sentence about the thread is the model's.** It is asked to name
  nothing that is not in the thread, and it is shown as written. How often it
  is wrong has not been counted.
- **A draft that is taken away because the thread moved on** has been run
  by tests only, not seen on the owner's mailbox.
- **A reply with people in copy** uses Gmail's "Reply all" and then requires
  the frame to name exactly the expected people. How Gmail shows several
  people in that frame has not been seen. If it shows them in a way the
  script does not read, such a reply is refused, not sent wrongly.
- **No connection reads mail yet.** The order is in place (`firstWay`), and
  the first place is empty: the Google connection reads unread messages one
  by one for the email observer, not threads. A thread reader over it would
  slot in as `connection` in `attach.ts`.
- **The desktop app's side is tested against a stand-in browser** (the pipe
  conversation, the three sites, the hidden-to-visible rule), not against
  Chromium.
- The time in a draft is a word the person can type over; it offers no other
  free times from the calendar.
- What a reply does with a file found in Drive is not decided: the sheet
  names what was found.
- Gmail's pages are read by their build as it was in November 2026. A change
  there makes a step refuse; the `shape-` scripts print the build again.

## From anywhere, and the shape of the day

Pass 8 is one rule and the things that follow from it. The rule is the
owner's, from the plan: only a person waiting or a running clock speaks up,
only after four seconds of still hands, always with its source. Everything
else joins the count.

66. **A line nobody asked for comes up in a still moment.** The desktop app
    says when the person's hands have been off the keyboard and the mouse for
    four seconds (pass 6). The inbox asks before it lets anything speak by
    itself (`maySpeak`): their hands are still, they are not away, and it is
    not their quiet hours. What may not speak joins the count and has its say
    at the next still moment (`calmed`). Two things do not wait: what the
    person asked for themselves, and what has a window already running (a
    promise about to be kept). Tapping the notch is never held back: the
    person can always open it and find what waits.
67. **Whether the person is there is known from their hands alone**
    (`presence.ts`). Still for twenty minutes is away; hands on again is
    back; the first time in a day, which begins at five in the morning, is
    the morning. Nothing is read from the screen for it and a locked screen
    is not known. Someone who reads for twenty minutes without touching
    anything is "away" and then "back": that errs towards telling them what
    changed. Nothing is said to an empty chair.
68. **Quiet hours: inside them nothing arrives.** 22:00 to 07:00 unless the
    person changes them, and whenever they say "Quiet for an hour". Both are
    in Home, under the text field: the two times are words that can be
    changed, and the button is beside "What you asked". Kept in
    `notch_settings`. What arrives joins the count and can be found there.
    A promise about to be kept is still shown: stopping it is theirs to do.
69. **Always with its source.** A reply to a mail that has just come speaks
    from anywhere as "In Gmail: you have not replied to Marco. I drafted a
    reply.", with the mail icon; in Gmail the place itself says it. The
    replies the first look found for mail that had been lying there speak
    only in Gmail: twenty old mails are not twenty interruptions.
70. **A meeting is said ten minutes before** (`soon.ts`): "Board call in 10
    min.", with the calendar icon. Only events other people are in: the
    owner's own notes in their calendar are theirs to remember, and whole
    days are not clocks. Read through a connection when there is one and in
    the signed-in browser when not, every five minutes, for today and
    tomorrow. It waits for a still moment like everything else, and says how
    long is left then; two minutes before the start it does not wait any
    more. A meeting moved or cancelled in the meantime is not announced at
    its old hour. The prototype's line went on "Notes are ready": nothing
    prepares notes yet, so nothing is said about notes. A title is text from
    the calendar: it is shown to the person and no model reads it.
71. **On a call, everything is held** (`around.ts`). The desktop app says
    when a program people make calls with has the microphone
    (`sidecar/notch_around.go`). It reads that from the record Windows keeps
    for the person's own privacy settings: nothing is listened to and nothing
    is recorded to know it, and which program it is is not said. A minute of
    it is a call (a sentence dictated is not); with a meeting in the calendar
    for that moment it is a call at once. The notch says "On a call. I hold
    everything until you are done." once, takes nothing to the person while
    it lasts (`inbox.hold`), and shows a bump beside itself for each thing
    that arrives. Fifteen seconds after the microphone is given back the call
    is over, and what was held is offered: "Call ended. I held 2 things."
    Dictation tools, noise filters and assistants that listen for their name
    are not calling programs and hold nothing back. A record that never
    closed (a program died with the microphone) is not believed past six
    hours, and no call is held past three. When the desktop app goes away
    nothing is held on its last word.
72. **The lines of the day are counted when they are said** (`day.ts`).
    The morning line, the first time the person is there: "Morning. 2 things
    done overnight. 3 need you.", where done is actions carried out, promises
    kept and replies sent since they left, and "need you" is what is in the
    count plus every reply that is drafted. Yes shows what waits. The evening
    line, from six in the evening if they are there: "Today: 5 things done. 2
    still wait." Each is said once a day, remembered across a restart.
73. **Back after being away, one line says what changed.** Who wrote and is
    waiting, and what moved in the calendar: "While you were away: 3 people
    wrote and are waiting for a reply, and Board call moved to 16:00." The
    calendar is read afresh and compared with what it held when they left.
    One new mail is its own line and gets no summary; nothing new is nothing
    to say. Replies a line has told of do not each speak up after it: they
    wait in Home.
74. **A lost connection is said, once.** The desktop app says what the
    system itself knows about its connection; nothing is sent anywhere to
    find out. Gone for eight seconds: "No connection. I carry on when it is
    back." When it returns: "Back online.", and what could not be read is
    read. A blink is not said, and a return is not announced when its going
    could not be.

What is not done, or not proven, in pass 8:

- **The two facts from the desktop app have not been read on a real
  machine**: that a calling program has the microphone, and that the machine
  is online. The reading of the record is tested against made-up records. Its
  shape was checked on the owner's machine on 15 November 2026, by counts
  alone: programs not from the Store are listed by path with `#` for the
  backslash, and each entry has a start and a stop as 64-bit numbers. That a
  call is then seen as one has not been tried. On a Mac neither fact is read
  yet: nothing is held for a call and nothing is said about the connection
  there.
- **One path per event is not enforced across the product.** With a Google
  connection the older observers still raise their own events for the same
  mail and calendar. The notch's own lines are one each.
- **The evening line counts; it does not offer to move what slipped.** The
  prototype's "1 thing slipped today. Move it to tomorrow?" needs a way to
  change when a promise is due, which the product does not have.
- **The lines of the day and the quiet hours have their defaults** (a day
  begins at 05:00, the evening line from 18:00, away after twenty minutes, a
  meeting ten minutes before). Only the quiet hours can be changed, in Home.
- Which events are meetings is read from how Google Calendar words an
  invitation ("Accepted", "Needs RSVP"), in English.

## Look at this, where is, and a dropped file

Pass 9. Three ways of showing Jarvis something instead of describing it.
Built for Windows and for the Mac. The Mac's side is compiled and has never
run; what that means, and what has not been seen on a real machine, is
listed under the invariants.

75. **While the talk pair is held, the pointer is Jarvis's.** A press with
    the pair down, and its letting go, are kept from the app in front
    (`sidecar/notch_looker.go`). A press that hardly moves is a click on the
    one thing under it; a press and a line is a circle round what is meant.
    Moving the pointer is never kept from anything, and a click a program
    sent is never taken: only a person looks. The pointer is the look's from
    the moment both keys are down, not from when the hold has become
    talking, because a click is quicker than that. A press on one of Jarvis's
    own windows is that window's.
76. **The pointer is watched only then.** The mouse hook exists only while
    the pair is down or a line is being drawn. At every other time nothing of
    Jarvis stands between the mouse and the apps (`lookWindows.watchThread`).
77. **The ink dims nothing and takes no click.** The line is drawn in a
    window over the display it was begun on. Every pixel the marker has not
    touched is clear, a click goes through it, and so does every question
    about what is at a place. It is a marker: one strength where the line
    crosses itself, nothing darker inside (`notch_ink.go`). This program
    knows each display's own scale, so the pointer, the ink and the elements
    are in the same real pixels at any scale and on any display.
78. **A circle is drawn fast and not neatly.** A thing is inside a line when
    the line's inside covers the middle of the thing: twelve pixels of the
    line through its centre, across or down, or half of a thing smaller than
    that (`lookCovers`). So a circle round the left end of three rows means
    those rows, and the row above that its top edge runs through is not
    meant. A line with no inside (a stroke under a word) means what it runs
    over.
79. **What is read is the app's own description of itself.** From the word
    under a place the look climbs to the row it is in, when that row is about
    as tall as the word; failing that to the nearest thing that is one by
    itself (a button, a link, a field); failing that it keeps the word
    (`lookSettle`). Things that stand side by side in one container are read
    from the container, so a row between two places that were asked about is
    not left out. The cells of a spreadsheet are gathered into rows when the
    line took several of each row. What is typed into a password field is
    never read.
80. **Nothing is read where Jarvis looks away, and a quick click waits for
    that to be known.** Whether the window is one Jarvis looks away from (a
    password, a bank, an app on the list: 45 and 46), and whether watching is
    switched off or Jarvis is asleep (50), is decided on the machine before
    anything is read or copied: the person's "stop looking" covers this way
    of looking too. Finding it out takes a few
    milliseconds beside the watch on the pointer, and a click can be done
    before it is known: so every line has its own state, and nothing is read
    or told until its press has finished finding out (`lookLine.ready`). The
    press is still kept from the app, and the notch says why it did not
    look.
81. **The pictures are of the screen, not of the line.** A copy of the
    display is taken at the press, before any ink is on it. When the line is
    finished two pictures are cut from it: what was circled, or the things
    that were found there when they reach further, with room round them, at
    most 1,600 pixels a side; and the whole window round it, made smaller to
    1,400 pixels on its longest side, when that is a good deal larger than
    the first. The copy is let go as soon as they are cut.
82. **What was read never travels in a payload, and never reaches a log.**
    The event `notch.look` says how the look was made, how many things it
    holds and where. The words and the pictures travel beside it: four bytes
    of length, the words as JSON, the close picture, the window's picture.
    The words say how long the first picture is. With the things they hold
    the names of what the things stand in, the nearest first (the panel, the
    list, the page: `lookAroundNames`). The event is not passed round the
    dashboards. Both sides log counts and sizes only.
83. **A look and what is said with the keys held are one gesture.** The
    microphone is open while a line is drawn, because the same keys are
    held. Nothing said: the look answers by itself, in one line, and the
    listening line leaves without "I did not catch that". Something said: it
    runs as an instruction that carries what was read
    (`circled-on-screen.txt`) and the picture (`circled-on-screen.png`) as
    the turn's attachments, which is where the model reads a file as outside
    content. Esc while a line is drawn throws the line away, reaches no app,
    and ends the talking as a slip (`notchKeyboard.key`). The look waits for
    the words of its hold for as long as they are being made: see 92.
84. **A look by itself says what the thing means, not what it is.** Decided
    by the owner on 15 November 2026, after he circled the number of installs
    on a dashboard and was told that he was circling it: the worth of a look
    is that Jarvis knows which window the person is in and what is around the
    thing. So a look with nothing said is asked about as an instruction,
    "What does this tell me?", that carries what was read, what it stands in,
    and both pictures; and the turn is told not to name the thing back but to
    say what it means where it stands (`NOTCH_TURN_NOTE`). One case is
    answered here, at once and without a model: rows or cells of numbers are
    counted and added up ("3 rows. They add up to 1,291.00."), because that is
    arithmetic (`lookAddsUp`, `lookSums`: a column is added when every row has
    a number there, cents are added as cents, and a unit is said only when
    every number has the same one). With no model set up, what was read is
    said as it is.
85. **"Where is…?" and "how do I…?" are answered from the element's own
    place.** A question that begins like one (`whereQuestion`: "where is",
    "how do I", "how to", "what do I click", "which button") reads the window
    the person is in (`notch.window`), gives a model the program's name and
    the named things in the window as a numbered list, and takes back a
    number. "How do I start recording?" with OBS in front is a question about
    the button that starts recording: the owner asked it on 15 November 2026
    and was told it depends what is meant. Jarvis's own pointer goes to that
    element's own rectangle and a ring is drawn round it (`notch.point`, see
    94): never to a place the model wrote. What is not on the screen yet is
    walked to one click at a time (95). The
    window read is the one in front unless that is the notch itself (it has
    the keyboard while something is typed), then the first one behind it that
    is somebody else's. The read runs beside the working line, so it can be
    stopped.

    **A window that says nothing about what is in it is looked at.** The
    list above works where a program tells of its own buttons: OBS, Notepad,
    a file window, Settings. A page in a browser, the many apps built on a
    browser, a game, a remote desktop tell of nothing in them: there the
    list holds the browser's own tabs and toolbar and nothing of the page.
    The owner, 16 November 2026, with Instagram open in Chrome, asking where
    to post: "it told me on the notch, but it should have pointed to it.
    [...] Why does it only work on OBS and just a few others? It should work
    everywhere." The log of that hour shows the model was given about
    thirty things to choose from, all of them the browser's, and either
    chose none (the answer came in words) or pointed at one of the
    browser's own buttons. So:
    - A window is blind (`pointBlind`) when the things it names, taken
      together, reach over less than a third of it or lie on less than a
      tenth of it. It leans towards blind: being called blind costs a
      moment, not being called blind when it is costs a wrong answer first.
    - A blind window, a window that cannot be read at all, and a window
      whose list does not hold the thing, are shown to a model that sees
      pictures. The desktop app sends a picture of the window with a ruler
      on it (`notch.shot`, `sidecar/notch_shot.go`): numbers from 0 to 100
      along the top and down the left side, a faint dotted line at every
      ten. The model is given the list too, and takes a thing from the list
      by its number when it is there: then the element's own rectangle is
      used, as before.
    - Otherwise it says where the thing is in the ruler's numbers. That
      place is then shown close up, as large as it is on the screen and
      twice that when it is narrow, and the model marks the thing's edges
      there. The brain turns the numbers back into the screen's pixels: it
      was told which part of the screen each picture shows. So a picture
      made smaller is still exact to the screen, at any display scale.
    - A place that is not found again close up is never pointed at: the
      question then runs as any other instruction, in words.
    - No picture is made where the desktop app looks away, or with watching
      switched off. Only the window the person is in is ever shown, cut to
      its display.
    When neither the list nor the picture shows a way, the question runs as
    any other instruction.
86. **A dropped file is the page's to take, and never the browser's.** The
    page says to the brain that a file is over the notch, and sends a file
    that is let go as the body of one request to `/api/notch/drop`, which
    answers only a signed-in page of this brain (the secret of the
    development routes never lets a file in). The page stops every drop,
    of a file or of anything else, from doing what a browser does with one,
    which is to leave the page and show what was dropped.
87. **What cannot be read is refused in a sentence that says what it is.**
    What can be read: what a chat attachment can be (text, Markdown, CSV,
    JSON, a PDF with text in it of up to 40 pages and 1 MB, a PNG or a JPEG of
    up to 4 MB), and files that are made of words in another dress, which are
    turned into their words first and travel as plain text under their own
    name (`drop-read.ts`): a web page (its scripts and styles thrown away
    unread), `.docx`, `.xlsx`, `.pptx`, and code and settings files, up to
    16 MB. An Office file is a zip of XML: the few parts that hold the words
    are unpacked with a limit on what any part may unpack to, and read with
    patterns, never with a parser that follows what the XML declares. Words
    are cut at 120,000 characters, and the question says so. A file that
    can be read waits for its question (93), which is then an instruction
    that carries it. Anything else gets its own sentence and what would work instead
    ("Call with Anna.m4a is a sound file. I cannot listen to files yet."). A
    file too large is not sent at all: the brain is told its name, kind and
    size. A file's name is shown and given to the model; it is never logged.
88. **An instruction can carry files, and nothing is left half kept.** The
    files of a notch turn are kept as its attachments by the notch's door
    (`src/daemon/notch-asks.ts`). When the turn cannot start they are taken
    back. When they cannot be kept, nothing is asked and the reason is what
    the notch says. A Notch chat the owner had closed is opened again to hold
    them.
89. **Every question on the notch is told which app is in front.** The name
    the notch shows beside its eyes, and the site in a browser, are said to
    the agent with each notch turn (`notchFrontNote`), so that a request that
    does not say what it is about is about that app. Only while Jarvis is
    watching it: not asleep, not looking away. The name comes from the
    program's own file, so only letters, digits and a few marks of it are
    kept, and four words at most: it names an app and cannot say anything.
    The window's title is never part of it (48).
90. **The notch does not keep a keyboard it did not ask for.** Windows makes
    the window a file is let go on the one in front. When the notch finds
    itself in front without the page having asked, the keyboard goes back to
    the last window that was somebody else's (`notchWindow.watch`).

91. **A yes or no from Windows is sixteen bits.** UI Automation hands a
    property over in a VARIANT, whose yes or no is 16 bits of a field 64
    bits wide. The other 48 are not promised to be zero, and what answers
    from another program leaves anything in them. Read whole, a "no" with
    stray bits above it came out as "yes": so the bare desktop, and ordinary
    windows, were taken for a password being typed, and the eyes turned
    away (the owner's machine, 15 November 2026: five times in four minutes,
    some for less than a second). Every yes or no is read through
    `oleBoolIsTrue`, which looks at the 16 bits. When a password field is
    believed to have the keyboard, the log says how it was known and what
    kind of control said so, as a number: never its name or what is in it.
92. **A look waits for the words of its hold, however long they take.** What
    was circled is read after the button comes up, and that takes from a
    moment to a few seconds. The words are made after the keys come up, and
    that takes a second or two. So the look can be told in between: the keys
    are up, no recording is open, the words are not in. A recording that has
    ended and is being made into words still counts as open (`NotchTalk.open`),
    and the look waits for what it says. The owner circled a figure and
    asked about it with the keys held on 15 November 2026, three times; each
    time the look answered by itself and his question ran without it. A look
    that is read only after its words went on without it (it took more than
    8 seconds) says nothing by itself. The desktop app's log says how long
    each look took to read and to be told.
93. **A dropped file waits for its question.** The notch opens its mouth
    while a file is over it and swallows it when it is let go: the
    prototype's animation (`mouth` open, over, gulp). Then it says what it
    got and asks what is wanted from it: the file's card, three things to
    pick by what kind of file it is (the prototype's, less what the product
    cannot do), and a field that has the keyboard. What is typed there is
    the question. So is what is said with the talk keys held while the file
    waits: the words take the file (`NotchDrop.claim`, asked by `talk.ts`
    once words are in). Enter on an empty field asks the first of the three.
    Esc lets the file go. A second file dropped while the first waits joins
    it, up to three and up to what one turn may carry, and then "what
    changed" is the first thing offered. A file nobody asks about is let go
    after five minutes. Nothing is asked of a model until the person says
    what they want. The owner, 16 November 2026: "it should either give me
    the opportunity to ask a specific question about it, or give me a few
    options".
94. **Jarvis's pointer is its own, and it never clicks.** To show where a
    thing is, a pointer leaves the notch, flies to the thing along the
    prototype's curve, and lands on it; then the ring is drawn round the
    thing, a piece at a time, and a few words are put beside it. The pointer
    is the prototype's citron arrow, drawn by the desktop app into a small
    window of its own that takes no click and never has the keyboard
    (`newNotchHand`, the ink thread in `notch_look_windows.go`). It is not
    the system's pointer, which stays in the person's hand and is never
    moved. When the ring's time is up the pointer flies home and is gone.
    (When Jarvis does a job itself, the press is made with the system's
    pointer and it is put back: 104.)
95. **The way to something is shown one click at a time, and the person
    does every click.** When what is asked for is behind a menu, a tab or a
    settings window, the pointer goes to the first thing to click and waits
    there (`NotchLook.PointWait`). The click is seen, never kept: the mouse
    hook is in for the length of the wait and passes everything on. A click
    Jarvis itself sends is not a click a person made, and is not counted;
    neither is a click on the notch. After the click the ring goes at once,
    the window is read again together with what the click opened (a menu or
    a dropped-down list is a window of its own with no title bar, and is
    read first: `notchPopupElements`), the model is told what was clicked and
    chooses the next thing, and the pointer flies on from where it stands.
    The notch's line says the step. It ends when the last step is clicked,
    when the model says the person is there, on Esc, on a new question
    (which is not told "I am still on the last thing"), when a line is drawn
    round something, after 60 seconds with no click, after three clicks
    somewhere else, and after eight steps. Nothing in it knows one program
    from another: it works wherever a program describes its own controls.
    The choice of the next click is asked of the middle model tier, not the
    smallest, because it rests on knowing the program as much as on reading
    the screen. The owner, 16 November 2026: "the little cursor that goes to
    the right button, waits until I click it, and then shows me the next
    step again with the cursor".

A correction to pass 6, found in the first test of pass 9: "a password
field has the keyboard" was asked only when the window in front or the
keyboard's place changed. A program built on Chromium sends no such event
until something has asked it, so the answer could stay true through every
window that followed, and the notch went on looking away. It is now asked
again each second for as long as it is believed, and twice after every change
of window. Why the desktop app looks away is written to its log when it
changes: the reason, never the window.

What is not done, or not proven, in pass 9:

- **What ran on a real machine, 15 November 2026:** the owner circled things
  in Chrome, Explorer and OBS (five looks, one to five things each, each with
  its picture), asked where to close a window (read and ringed in two
  seconds), and dropped a PDF. What he asked for after it is in 84, 85, 87 and
  89, and none of that has run on a real machine yet: the second picture, the
  names round a thing, "how do I" pointing, the wider file reading.
- **Why the notch looked away with an ordinary window in front is not known
  for certain.** The desktop app did not log why. A password field that kept
  the keyboard in its eyes is the one path found that fits, and it is closed;
  the reason is logged from now on.
- **The arrow keys are not built.** The plan has "hold the pair, move with
  the arrows, Enter". With the pair held those are Windows' own shortcuts:
  Ctrl + Win + Left and Right switch desktops, Ctrl + Win + Enter starts
  Narrator. Taking them would break both. That is the owner's to decide.
- **The Mac's side of pass 9 is written and compiled, and has never run**
  (`notch_look_darwin.go`, `notch_mac_darwin.go`; the owner asked for it on
  16 November 2026). It does what the Windows side does with the Mac's own
  means: the pointer is watched by an event tap that exists only while the
  look wants the pointer; the ink, the tag and the three pointers are layers
  in one window that lets every click through and never has the keyboard;
  what a thing is comes from the accessibility interface, asked of the
  program whose window is at the place, with a time limit on every
  question; "where is" reads the window in front the same way. What is
  typed into a password field is never read there either. It needs the
  Accessibility permission the notch's keys already need, and the picture
  of what was circled needs the Screen Recording permission: without that
  one the look still names things and sends no picture (the product's
  setup asks for both, `setup_permissions_darwin.go`). What is not known
  until it is tried on a Mac: whether the tap is given, whether the overlay
  stays above a fullscreen app, how well a given program describes itself,
  and every timing. On Linux the look has no hands (`notch_look_other.go`).
- **How well a real app can be named is not known.** The reading is general,
  not written for Excel, Explorer or Chrome. What each of them calls a row or
  a cell is known from documentation, not from looking. Chrome is the known
  weak spot: it describes a page to other programs only once it believes one
  is listening.
- **The page hears of a dragged file only once it is over the notch
  itself**, because the rest of its window lets everything through. So the
  mouth opens when the file arrives there, not when the drag begins, as it
  did in the prototype.
- **A spreadsheet's dates come as the numbers the file keeps them as**, and
  its formulas as their last results. A Word file's tables come as lines.
  Pictures inside Office files are not read.
- **What ran on a real machine in the second test, 15 November 2026, late:**
  five looks, three of them with a question spoken in the same hold. The
  log shows each of those looks told in the second its recording ended,
  which is the gap 92 closes. 91 to 95 were built after that test and have
  not run on a real machine.
- **91 was found by reading, not by catching it.** The desktop app logged
  "password" as the reason five times while no password was typed, and the
  wide read is the one fault found that makes a "no" into a "yes". It was
  not seen happening. If the eyes turn away again in an ordinary window,
  the log now names the kind of control that was believed.
- **The pointer has never been seen on a real display.** Its picture and its
  path are tested as numbers and were looked at as a rendered image; how the
  flight looks at 60 frames a second over real windows is not known. Nor is
  whether the ring and the words sit well on a menu.
- **How well the model chooses the next click is not known**, and neither is
  how long it takes between a click and the pointer moving on. Both depend
  on the model the owner has set up.
- **A step that is not a click cannot be shown:** a key to press, a thing to
  drag, words to type. The model can only point at something to click. A
  step done with the keyboard is not seen, so the walk waits its 60 seconds.
- **A program that draws its own controls and describes none of them**
  (a game, a canvas) cannot be walked: the question runs as an ordinary
  instruction, and the answer is words.
- **Reading what a click opened is untried.** A menu is taken to be a window
  of the same program with no title bar. A program that opens its menus
  from another process would have them missed.
- **A dropped file's suggestions are fixed sentences in English.**
- **The line stays inside the display it was begun on.** A circle drawn
  across two displays is cut at the edge of the first.
- **A PDF that is only scanned pages has no text to read** and is refused as
  one: nothing is guessed from its pictures.
- "Where is" is known by how a question begins, in English.
- **Pointing by sight has not run on a real machine.** It is tested against
  a stand-in for the desktop app and for the model. The ruler was drawn on a
  copy of the owner's screen and looked at: places can be read off it. How
  well the model the owner has set up reads a place off a picture is not
  known, nor how long two looks take: a way found by sight asks the model
  twice with a picture each time, where a way found in the list asks once
  with words. A picture of the whole window in front goes to that model
  when this happens; before, only the names of its buttons did.
- **Pointing by sight is not exact the way an element's rectangle is.** The
  ring is drawn round what a model marked on a close-up. It can be a few
  pixels wide of the thing, and a click on the thing may then count as
  beside it in a way of several clicks.

## Doing it in view

Pass 10. Jarvis does a job on the person's own screen, where it can be
seen: its own pointers go to each place before anything happens there, the
notch counts, Esc stops it, and it can go on or take back what it did. A job
gets there in three ways: the person does it twice by hand and Jarvis offers
to do the rest; the person shows it once ("Watch me"); or the person shows a
thing and then a place ("put it there").

Code: `src/notch/rounds.ts` (telling a repeated round from shapes),
`jobs.ts` (running, stopping, going on, taking back), `catch.ts` (the offer),
`teach.ts` ("Watch me", "run it", a time of the week), `put.ts`;
`src/daemon/notch-jobs.ts` (what they need of the product);
`sidecar/notch_watch.go` and `notch_watch_windows.go` (watching, and
`notch.act`), the hooks in `recorder_windows.go`, the pointers in
`notch_look_windows.go`. On the Mac: `notch_watch_darwin.go` (the tap, the
recorder and `notch.act`), `notch_mac_darwin.go` (windows, what a program
says of itself, the clipboard, a click or a key made as if by hand),
`notch_mac.go` (which keys are steps, tested), `notch_look_darwin.go`.

96. **The notch watches the shape of what the hands do, and only the
    shape.** With the notch on, the desktop app keeps its mouse and keyboard
    hooks in and tells the brain (`notch.watch`): a click, as which window
    and which place in it; a named key or a shortcut (Enter, the arrows,
    Ctrl + C), as which window. It never tells a key that types, the text of
    a field, the name of a control, or the title of a window, and in this
    mode it asks no program anything about itself. A stretch of typing is
    told as one word, `typed`. Which keys are steps is one function
    (`watchKey`), tested over every key: a letter, a digit, a sign, Space and
    Backspace are typing unless Ctrl, Alt or Win is held, and with the right
    Alt of a keyboard that types a third sign with it they are typing too.
    The brain keeps the last eighty shapes in memory and writes none of them
    down. Decided by the owner on 12 November 2026 (decision H).
97. **Where it looks away, nothing is told, not even the shape.** A password
    field, a bank, an app on the person's list, watching switched off, Jarvis
    asleep: the same answer that stops a look (`notchLookAway`) stops this.
    The brain hears `gap` once, so that what came before and what comes
    after are not taken for one job.
98. **What a program pressed is not what the person did.** Windows marks a
    click or a key that a program made. Both hooks drop those, for the
    notch's watching and for a recording alike. Without this Jarvis's own
    clicks, when it does a job, would be taken for the person's next round.
99. **A round is the same steps done twice, one place further along.** The
    brain looks at the end of what it was told for the shortest run of steps
    that was just done twice running, with the same keys in the same
    windows, where each click either stayed where it was or moved on by a
    clear step. The third round is those steps with every place moved on by
    that much again. It knows nothing of rows or sheets, so it works
    wherever things stand at even distances. It is a circle: the person who
    stops after the click in the file and the one who stops after the paste
    are in the same job at another step of it, and Jarvis takes over from
    exactly that step. Not a round, on purpose: a stretch with typing in it
    (Jarvis did not see that part), anything across a `gap`, a round in
    which nothing moves on, a place that moved a few pixels (neither still
    nor on), a window that changed size, two rounds more than ninety seconds
    apart, and clicks alone done only twice (two clicks happen all day; a
    third makes them a pattern).
100. **It offers, and does nothing without the yes.** Seeing a round,
    Jarvis's pointer comes up beside the person's own, goes to where the
    next round begins, and the notch says "I can take it from here", with
    "6 left" when that can be counted. The line came by itself, so no yes
    lands on it in its first 0.7 seconds. Turned down or left, the same job
    is not offered again for ten minutes. While Jarvis is working, or being
    shown a job, what the hands do is not looked at.
101. **How many are left is counted from what the window says, or not said.**
    From the place the things come from, the desktop app looks one step
    further each time and counts while there is a thing of the same kind
    that says something (`watchCountLeft`). Where a window draws its own
    rows and describes one large thing, it cannot tell, says so, and the
    sentence carries no number. Then a job that copies runs until a copy
    comes back empty, and a job that copies nothing asks how many.
102. **A step is done once.** Each step is one request to the desktop app
    (`notch.act`). One that was done is never sent again, and neither is one
    whose answer was lost, because it may have been done. Only a step the
    desktop app refused before touching anything is tried again. Going on
    after a stop starts at the first step that did not happen. Esc lands
    between two rounds: a round in hand is finished if that takes under
    three seconds, so a row is whole or not begun. The plan's test: "Esc at
    four. Go on. It finishes, and no row is there twice."
103. **Every press is checked first, and refused rather than guessed.** The
    window must still be there and be the same program's, be the size it was
    when the step was shown (or what stood at that place is somewhere else
    now), not be put away, not be covered at that place by another window,
    not be one of Jarvis's own, and not run as administrator. Keys are
    pressed only when that window is the one in front. A refusal comes back
    as a word (`gone`, `moved`, `outside`, `covered`, `own`, `elevated`,
    `front`), the job stops, and the notch says which.
104. **In a job the press is made with the system's pointer, and it is put
    back.** This amends 94 for jobs only. A press that every program takes
    can only be made with the system's pointer, so it is moved to the place,
    pressed, and put back where the person had it, in about fifty
    milliseconds. Jarvis's own pointer, which is a picture, has landed there
    first. A job uses up to three of them, one for each place a round
    touches, so that none has to cross the screen for every step; they hop
    between rows in 150 to 420 ms and go home when the job ends.
105. **What a job pasted is kept as shapes, and taken back only where it
    still stands.** For each paste the brain keeps where it went, how many
    cells, and a number that is the same for the same text (`clipShapeOf`).
    The desktop app reads the clipboard for that and tells the brain the
    shape, never the text. Undo, from the stop line or from Today, goes to
    each place newest first, reads it again, and presses Delete only when
    what is there has the same number as what was pasted. What the person
    changed since is left and counted in the answer. One cell is cleared
    only where taking in the cell beside it gives two cells: in a page of
    writing that gives one letter, and Delete there would eat a letter of
    the person's. The plan left "undo played backwards" out; this is the
    typed inverse of one thing, a paste.
106. **"Watch me" is the permission.** Saying it starts the product's
    recorder with no card to click (the owner, 13 November 2026: on the
    notch saying is approval). The notch says it is watching for as long as
    it does and counts the steps; the pebble's line and the two
    notifications are left out for a recording started this way. Yes or the
    word "done" ends it, Esc throws it away with nothing kept, and it ends
    by itself after ten minutes. What was shown is saved as a skill, signed
    like any other. The recorder now also records the keys that are steps,
    which it did not: a job shown with Enter or Ctrl + V in it is done again
    with them.
107. **A shown job at a time of the week asks first.** "Do it every Monday
    at 9:00?" keeps the time, and at that time the notch asks "Shall I do it
    now?" and does it on a yes. It does not start by itself: a job that
    drives the person's screen does not begin while nobody is looking, and
    the product's own rules refuse a recorded job on a schedule at the
    default permission level. A time that passed more than thirty minutes
    ago is not done late. Letting it run alone is pass 11's trust rungs.
108. **A job that pays is never run from the notch, and one that deletes
    asks once.** The skill's own classification of its steps decides
    (`resolveSkillEffect`).
109. **Put it there: what was shown is held for ninety seconds, and goes
    where the person points, in the form it should have.** After a look the
    brain holds what was read and tells the desktop app a few words for it
    (`notch.hold`). With the talk keys down, "Put 3 rows here" stands beside
    the pointer over a place that can take it (a field, a cell, a page of
    writing), before anything is clicked. A click there is not a new look:
    the notch asks "Put 3 rows here as a table?", and on a yes the thing is
    pasted at that place. Rows copied out of a sheet by hand and pasted into
    a document come out as words with gaps between them, so what Jarvis puts
    goes to the desktop app as rows of cells with a form (`as`), and the
    desktop app puts it on the clipboard twice, the way a spreadsheet does
    (`pasteFlavours`): a real table or list for a program that takes one,
    and plain words for one that does not. A document gets a table, a sheet
    gets cells, a plain field gets columns that line up, with numbers set to
    the right. The form is a lit word on the line (a table, a list, plain
    text) and can be said instead of tapped ("as a list"); into a cell there
    is no form to choose, and one value is just put. With a thing held and
    no place pointed at, "put it here as a table" puts it at the caret of
    the window in front. Every cell is escaped: what was read off a screen
    is words in the table, never markup. Nothing is reworded on the way.
    What is put is what was circled, and where the program does not say
    what that is, it is read off the picture: a browser showing a sheet or
    a dashboard says nothing about what is on its page, and all the look
    has at such a place is the page itself. The owner's first test, 16
    November 2026: he circled five numbers on a dashboard and the name of
    the browser's window was put. So the desktop app marks a thing the line
    was drawn inside (`over`, `lookOver`: higher than the circle by half and
    more, and wider than it; rows that run on past a circle round their
    left end are not that), the name of a page, a pane or a window is never
    carried, and a circle with nothing else in it is copied off its picture
    by a model that sees pictures (`read` in `src/notch/put.ts`,
    `NOTCH_PUT_READ_SYSTEM`: rows of cells, every character as shown,
    nothing rounded, added or corrected). "Put what you circled here"
    stands beside the pointer at once and becomes "Put 5 rows here" when it
    has been read; a place pointed at meanwhile waits for it. When it cannot
    be read (no such model, or nothing legible) the notch says "I could not
    read what you circled. Nothing was put there." and puts nothing: never
    a guess, never the window's name. Where the program does read what was
    circled (a row of a list, a cell, a field) its own words are taken,
    exactly, and no model is asked. A click is never read off a picture: it
    has no edge to read up to.
    After ninety seconds it has forgotten and says so. The text stays on the
    clipboard afterwards: putting the person's own back risks a slow program
    pasting that instead. A click to put something, with nothing said in the
    same hold, is not "I did not catch that" (`NotchLook.during`). The
    owner, 16 November 2026: the feature "is only useful if the formatting
    is done correctly".
110. **Where each step lands is measured on the screen, not taken from the
    hand.** Two clicks by hand on two rows are never exactly one row apart:
    the hand lands a few pixels higher in one row and lower in the next, and
    anywhere along a cell's width. Going on by that distance drifts into the
    wrong row within a few rows. So a round only goes down or up a list (how
    far to the side the hand landed is the hand, not the job; a job that
    goes across is not a round, because columns are not evenly wide), and
    before anything is offered the desktop app measures how far apart the
    rows really are at each place a round touches (`watchRowStep`). It reads
    a strip of the screen as where it changes going down, not as how bright
    it is: a line between two rows is a row of pixels unlike the one above
    nearly all the way across, and a fill, a selected row or a dark theme
    change nothing but their own edges, which are where the rows are. It
    finds the distance at which the strip is most like itself
    (`watchRepeat`), then takes the places where it changes one by one, keeps
    the evenly spaced set that carries the most weight, leaves out what does
    not stand in it (a heading over the list), and takes the distance of the
    straight line through the rest (`watchExact`). The rows it measures must
    be the ones that were clicked, and most of the places between the first
    and the last must have a line: a few bars that happen to stand evenly
    are not rows. This works in any program and asks the program nothing. A
    number leaves the desktop app and no pixel does. Where the rows cannot
    be seen, or what was measured does not fit what the hand did, nothing is
    offered at all, and "run it" says so: a row pasted one line off is worse
    than no help. It is measured again at the yes, from where the person is
    by then. Found by review before the first hand test, 16 November 2026.
111. **A shortcut held down is one shortcut.** A key that is held repeats
    itself, and Ctrl + C three times in one round and once in the next would
    not look like the same job. A shortcut is told when it goes down and not
    again until it has come up.
112. **On a Mac the same shapes are told, and nothing more.** One event tap
    sees the mouse buttons and the keys and keeps none of them
    (`notch_watch_darwin.go`). Which key it was is decided in C, before Go
    is woken: a key that types crosses over as "a key that types" with no
    key in it, and a letter is only read off the event while Cmd or Ctrl is
    held (`watchKeyMac`). What a program posted is passed over (its event
    carries a process id), so what Jarvis presses is never taken for what
    the person did. Cmd is to a Mac's shortcuts what Ctrl is on Windows: in
    what is watched, in what counts as a copy and a paste, in how a shortcut
    is said ("Cmd + C"), and in what the hands press for a copy and a paste
    whatever system the job was shown on. The tap is in only while the notch
    watches or a recording runs, and is out when neither does.
113. **A shown job is done again where it was done, when its window is
    there as it was.** The product's replay finds each thing again by its
    name through the element reading. A field on a page in a browser has no
    name to be found by (the owner's first "run it", 16 November 2026, on a
    job shown in a sheet in a browser: "I stopped at 0 of 12. I could not
    find the next thing to click on the screen."), and the Mac build has no
    element reading at all. So what "Watch me" saw is also kept as
    places (`teachPlaced`: a click in a window, a named key or shortcut,
    what a field held), and "run it" does those (`runPlaced`), each
    step one request to the desktop app, done once, with the same stop, go
    on and lost-answer rules as a round. The window is found again first
    (`notch.act` `find`): the very window if it is still there, or the
    program's topmost window of the same size. A step that typed into a password field
    was never kept, so the job stops there and says that step is the
    person's; going on continues after it. A job with a step that has no
    place (told with no window, outside its window, a key that types), or
    with a field that held more than 2,000 signs (it is read whole or not
    kept, never a part passed off as the whole), is not kept as places at
    all: half a job is worse than none. On Windows a job is done by place
    when it has places and its window is there as it was (asked first,
    which touches nothing), and through the product's replay by name when
    the window is gone or another size, or when a step has no place
    (`startSkill`). On a Mac by place is the only way (`byPlace` in
    `src/daemon/notch-jobs.ts`): with no places "run it" says to show the
    job again, and with the window gone it says it cannot find it and
    touches nothing. What is typed is told with the window it was typed in from now
    on, so a job with typing in it has a place for every step. The window
    is brought forward before the first step (`find` with `front`): a key
    or words to type go to whichever window is in front. Windows may refuse
    that, and then the step says another window is in front.

What is not done, or not proven, in pass 10:

- **None of it has run on a real machine.** The brain's side is tested end
  to end against a stand-in for the desktop app. The desktop app's side is
  tested where it is plain logic (which keys are steps, the shape of a
  copy, the place in a window, counting what is left, the hover), compiles
  for Windows, and has never clicked, copied or pasted anything real.
- **Whether a press lands in a given program is not known.** Clicks are
  made at places in a window. A program that lays itself out differently
  from one moment to the next, or scrolls between rounds, will be clicked in
  the wrong place, and only the window's size is checked. A job stops at the
  edge of its window: it does not scroll.
- **Measuring rows from the screen failed the owner's first test, and was
  rebuilt the same day (16 November 2026).** The first version read how
  bright each pixel row was. On two Google Sheets it saw no rows, and nothing
  was offered. On a copy of his screen it was worse than that: beside the row
  numbers it saw nothing, and elsewhere it named 15.6, 20.0 and 23.3 pixels
  for rows that are 21 apart, because what is in the rows (fills, a selected
  row, names of different lengths) changes the brightness far more than a
  thin grey line does. Read as where the strip changes, the same screen gives
  21.00 within 0.07 at about 2,600 places across both sheets, sees no rows
  in the toolbar, and says "no rows" at 8 places. That copy was a picture he
  sent, made smaller and sharpened back, not his screen itself: a real screen
  is crisper, which should help, and has not been tried. The tests paint
  sheets with what his had (a heading, fills that hide lines, a selected
  row, a dark window, a striped list, rows that are not a whole number of
  pixels apart). Lines of writing with no lines between them are measured
  only when they are regular enough; otherwise it says it saw no rows. Rows
  of uneven height cannot be measured, and there nothing is offered. When it
  sees no rows the log now says what it found, in numbers only.
- **A settings change used to cut the desktop app's recorder off from the
  brain until the next connection** (the events were sent on a cancelled
  context). Found by reading while building this, and fixed in
  `reloadConfig`; not caught happening.
- **How the hooks behave left in all day is not measured.** They do a few
  table lookups a click and nothing else, but Windows removes a hook that
  answers slowly, and eight hours of it is pass 13's soak.
- **A round with typing in it cannot be taken over**, and neither can one
  the person selects by dragging: a drag is seen as a click where it ended.
- **The Mac's side of pass 10 is written and compiled, and has never run.**
  The Mac had no recorder before; the tap, the recorder, the hands and the
  clipboard there are all new (invariants 112 and 113). Not known until it
  is tried on a Mac: whether a click or a key posted to the system lands in
  a given program; whether Docs, Pages or Mail take the table off the
  clipboard; whether measuring rows works on a display with two pixels to a
  point (the screen is copied at one pixel to a point for it); what the tap
  costs left in all day. Without the Screen Recording permission the rows
  cannot be measured, so there nothing is ever offered and "run it" says
  the rows cannot be seen. Doing a job again by place is cruder than finding
  a button by name: a window that opens at another size, or lays itself out
  differently, is refused or pressed in the wrong place, and only the
  window's size is checked.
- **What was typed is read from its field when the field is left, on both
  systems.** A field that empties itself at Enter (a chat box) or goes away
  with its window (a save sheet) can be read a moment too late and come out
  empty, and then the step is not in the job. The Mac's recorder does this
  the way the Windows one already did; neither was changed.
- **Undo exists for a paste only.** A draft that was made is taken back
  inside its send window (pass 7), and nothing on the notch makes a calendar
  event yet, so there is nothing of that kind to undo.
- **Two things the prototype showed are not built:** changing a job by
  voice while it runs ("skip the fees"), and making an agent out of a
  finished job. The last is pass 11. The prototype's "as a sentence" is not
  one of the forms a thing can be put in: that would have a model rewrite
  what was read.
- **Three things failed or were found in the owner's tests of 16 November
  and were rebuilt the same day:** the rows could not be measured on a real
  sheet (invariant 110); "run it" could not find a field on a page by its
  name (113); and "put it there" put the name of the browser's window
  instead of the numbers that were circled (109). After the first of these
  was fixed the catch itself worked on two Google Sheets: fifteen rows, then
  eighteen, with no step refused.
- **Reading a circle off its picture is a model reading a picture.** It can
  misread a digit, and nothing checks it against the screen. It is told to
  copy and nothing else, at temperature 0, and what it read is on the page
  the moment it is put, where the person sees it. Whether the model the
  owner has set up sees pictures at all is not known until it is tried:
  when it does not, the notch says it could not read the circle. What the
  picture shows goes to that model, as a circle the person asks about
  already does.
- **Doing a job by place does not check what is at the place.** Only that
  the window is the same program at the same size. A page that has scrolled
  or changed since is pressed in the wrong place.
- **A job that was shown before these changes has no places** and is still
  done by name. It has to be shown again.
- **Whether a given program takes the table is not known.** Word, Google
  Docs, mail composers and sheets read a table off the clipboard; a chat box
  or a plain field takes the plain words. Which one a program picks is its
  own choice and was not tried.
- **Words that start these are matched in English and a little Italian**
  ("watch me", "done", "run it on nine rows", "undo that").

## The keys

| What | Keys | How it is told |
|---|---|---|
| Talk | hold Ctrl + Win (Mac: Ctrl + Option) | the pair down alone for 150 ms; ends when either comes up or any other key goes down |
| Yes | tap Win + Alt (Mac: Option + Cmd) | the two down within 0.7 s of each other and up again within 1.5 s, with no other key |
| Esc | Esc | only while the notch has something on it, and never with a modifier |
| Look | hold the talk pair, then click or draw with the mouse | the pair down alone, from the first moment; the press and its letting go are kept from the app in front (75) |
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
| desktop app to brain | event `notch.look` | `{phase: "begun", look_id}`; `{phase: "taken", look_id, how: "click" \| "loop", things: number, rect, picture}` with the words and the pictures beside it (four bytes of length, `{app, title, around: [names], things: [{kind, name, value, parts}], picture_bytes}` as JSON, then the close picture as a PNG of `picture_bytes` bytes, then the window's picture as a PNG), or `{phase: "taken", look_id, how, refused: "password" \| "bank" \| "never" \| "private"}` with nothing beside it; `{phase: "dropped", look_id}` | none |
| brain to desktop app | `notch.shot` | none, or `{x, y, w, h}` for a part of the window, in the screen's pixels | `{x, y, w, h, app, close}`: which part of the screen the picture shows, and the picture beside it (PNG) with a ruler from 0 to 100 along its top and down its left side. A whole window is made smaller to at most 1568 pixels a side; a part is as it is on the screen, twice that when narrower than 720. Where this program looks away: `{away}` and no picture. Only the window the person is in is ever shown |
| brain to desktop app | `notch.window` | none | The window the person is in, as it describes itself: `{window_title, app, elements: [{id, name, control_type, rect: {x, y, w, h}}]}` (`app` is the program's name), places in the screen's own pixels. `{away: why}` and nothing else where the desktop app looks away What the program has open on top of it (a menu, a dropped-down list) comes first in `elements`, counted in `popups`. |
| brain to desktop app | `notch.point` | `{x, y, w, h}` in the screen's own pixels, `label?`, `ms?` (0.5 to 15 s); with `wait_ms` (up to 90 s) it answers only when the person has clicked or the wait is over; `{clear: true}` takes it away | `{pointed: true}`, and with `wait_ms` also `{clicked, inside, why}` (`why`: `click`, `time`, `replaced`, `gone`). Jarvis's pointer flies to the rectangle and a ring is drawn round it. The click is seen, never kept, and where it was is not said. Refused while the person is drawing a line. |
| desktop app to brain | event `notch.watch` | The shape of what the hands did: `{kind: "click", app, win: {id, pid, w, h}, pt: {x, y}, mods?, ts}` (the place is in the window, from its top left corner); `{kind: "keys", keys, app, win, ts}` (a named key or a shortcut, never a key that types); `{kind: "typed", ts}`; `{kind: "gap", ts}` | none. Nothing is told from one of Jarvis's own windows, of anything a program pressed, or where the desktop app looks away |
| brain to desktop app | `notch.watch` | `{on: boolean}` | `{watching}`. Puts the hooks in for the notch's own watching, or lets them go. They come out when the notch goes off or the brain is gone |
| brain to desktop app | `notch.act` | `{do, ...}`. `click`: `win`, `x`, `y` in the window (or `screen: true` and a place on the screen), `hand` 0 to 2, `mods?`, `double?`. `keys`: `win`, `keys`. `type`: `win`, `text` (up to 4000 signs), typed where the keyboard is when that window is the one in front. `find`: `win`, `app?`, `front?`: the window a step named as it is now, or the topmost window of that program at the same size, brought forward with `front`; adds `{win, app}`. `copy`: `win`, `keys?`, `right?`, `down?` (cells taken in first). `paste`: a place (or `front: true` for the caret of the window in front), and `text`, or `rows` (rows of cells) with `as`: `cells`, `table`, `list` or `text`. `hand`: a place or `beside: true`. `home`. `front`. `count`: `win`, `x`, `y`, `dx`, `dy`, `most`. `pitch`: `win`, `x`, `y`, `dy` | `{done: true}`, or `{done: false, why}` with one of `gone`, `moved`, `outside`, `covered`, `own`, `elevated`, `front`, `failed`: then nothing was done. `copy` adds the shape `{empty, rows, cols, chars, hash}`, never the text. `paste` adds `{win, app, pt, shape}`. `hand` adds `{ms}`. `count` adds `{known, left}`. `pitch` (`win`, `x`, `y`, `dy`: how far the hand went) adds `{known, dy}`: how far one step really is, measured on the screen. One at a time |
| brain to desktop app | `notch.hold` | `{what, ms}` (up to five minutes), or `{}` to hold nothing | `{held}`. With the talk keys down, "Put (what) here" stands beside the pointer over a place that can take it |
| brain to desktop app | `recorder_start` field `quiet` | `true` for a recording started from the notch | The pebble's line and the two notifications are left out for that recording. Its `ui_interaction` events now also carry `press_keys` steps, and for a click `win`, `pt` and `mods` |
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
| page | `drag {state}` | A file is over the notch (`over`), was taken away again (`left`), or was let go and did not reach the brain (`lost`). The file itself goes in one request to `/api/notch/drop`: its bytes as the body, `x-notch-file` (its name, percent-encoded), `x-notch-size` and `x-notch-count` as headers |

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

### The mail study

Before the notch proposes anything about mail, a study answers two questions:
can Gmail be read reliably in Jarvis's own browser, and are the proposals any
good. It is run from a script against the test brain, with the owner's word,
after they signed in to Gmail once inside Jarvis's own browser:

```sh
bun scripts/notch/mail-study.ts export      # 30 days of threads, read through the browser
bun scripts/notch/mail-study.ts calendar    # the calendar: a connection when there is one, else the same browser
bun scripts/notch/mail-study.ts replay      # the month put to the proposer as if it had been running
bun scripts/notch/mail-study.ts look        # a draft named a file it did not have: look for it in Drive
bun scripts/notch/mail-study.ts sheet       # the scoring sheet, served to this computer only
bun scripts/notch/mail-study.ts score       # what the marks add up to
```

What it reads and makes is kept in `<data>/study` and nowhere else. The
script prints counts, never mail: the only page scripts whose answers reach
the screen are the `shape-` ones, written to answer with counts and yes or no.
The gate it scores against: at least 60% useful and none to the wrong person.

The parts, in `src/notch/mail/`: `waiting.ts` (is a person waiting, decided
without a model), `proposer.ts` (does it need a reply, and the reply; mail
reaches the model marked as outside content, and the model never chooses who
a reply goes to), `gmail.ts` and `page/` (the reading), `study.ts` (the replay
and the score), `browser.ts` (a page's answer longer than the desktop app's
20,000 characters, read in pieces), `calendar.ts` and `drive.ts` (the
calendar and the files, read in the same browser).

### No connection is not "I can't"

The owner's rule, in his words: "Oh, there is no connection. Let me check if
I can use the Chrome that is signed in to go and find it." Jarvis's own
browser is signed in as the person. A service it has no connection to is one
address away there, so a missing connection is never by itself a reason to
say something cannot be done. The order is always: a connection when there is
one, the signed-in browser when there is none, and "I could not" only after
both, with what was tried.

It is held in three places:

- **Code that reaches for something** uses `firstWay` in `src/notch/ways.ts`:
  a list of ways, each answering with the thing, with null ("this way is not
  here": nothing connected, browser not signed in) or with a throw (it is
  here and failed). The first that answers is used and the rest are not
  asked. An empty answer is an answer: an empty calendar is not a missing one.
- **The agent** is told the same in its tool guide
  (`browserBeforeCannot` in `src/roles/tool-guide.ts`): with no tool or
  connection for a service, open the service's own site in the browser and
  look, before saying it cannot and before asking for a connection. Only a
  sign-in page stops it, and it never works around one. It is about finding
  and reading: the rules for sending, buying, deleting and changing are not
  loosened by it. A test holds the paragraph in the guide.
- **The mail proposer** gets the calendar that way, and names in `look_for`
  a file it would have needed, which Jarvis then looks for in Drive instead
  of only reporting it missing.

What was learned about the two pages, on a real account in November 2026
(the `shape-cal*` and `shape-drive*` page scripts print these shapes again
when Google changes them):

- **Calendar** (`calendar.ts`, `page/cal-week.js`): the week view at
  `/calendar/u/0/r/week/YYYY/M/D?hl=en`. Each day's column is a
  `div[role="gridcell"][data-datekey]`, and the key is a number that holds
  the date: `((year - 1970) << 9) | (month << 5) | day`. An event is a
  `[data-eventchip]` with a `data-eventid`. Its hours are read from the line
  Google writes for screen readers, the leaf that holds ", ": "9am to
  10:30am, Title, ..., November 16, 2026" (asked for in English so that the
  words are known). Its day is the column it is drawn in, never the words.
  Whole-day events sit in a row above the hours, outside any day's column;
  their line starts or ends with "All day", and their days are the columns
  they lie over. The title has a place of its own in the event, and the
  line repeats it. Events the owner declined carry "Declined" as a part of
  the line and are left out. Anything written another way is counted as not
  read and left out, never guessed at. The hours are in the calendar's time
  zone and are turned into moments with the browser's, so the reader refuses
  when the zone label on the page ("GMT+01") is not the browser's. What is
  read is what the owner sees: every calendar they have switched on. A week
  takes about three seconds; a full page load each, since an answer given
  while the address changes is thrown away by the desktop app.
- **Drive** (`drive.ts`, `page/drive-search.js`): the search at
  `/drive/search?q=words&hl=en`. A result is a
  `div[role="gridcell"][data-id][aria-label]`; `data-id` is the file's id.
  Its name is the text of the `[data-tooltip]` inside it, and its label is
  the name, then the kind ("Google Slides", "PDF"), then a five-word hint
  about keys that is the same on every result. A search that finds nothing
  shows a `[role="status"]` in the main area after about three seconds. The
  words searched are words only: anything Drive would read as an instruction
  (`owner:`, `-`, quotes) is taken out, because they come from a model that
  read a stranger's mail. Finding is all it does: it opens no file, shares
  none and attaches none.

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
