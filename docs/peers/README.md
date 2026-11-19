# Other people's Jarvises

How one person's Jarvis talks to another's. Built in passes on `notch/main`. This file states
what is built, the rules it keeps, and where it stops.

It ships dark. With `JARVIS_PEERS_ENGINE` unset nothing in `src/peers/` runs.

## The shape

```
notch  <->  brain  <->  src/peers  <->  the engine (a separate program, a child)  <->  its server
```

The keys, the pairing by code, the encryption and the mailbox are not written here. They are the
work of a separate program, the collab engine, which was made to sit under a coding agent. The
brain starts that program as a child and talks to it the way a coding agent would. What is written
here is the brain's side: starting it, speaking to it, and handing on what it asks of the person.

The engine is not part of this product yet. It is not bundled, it exists for Linux only, and its
server is a test server. So the switch is the place of the program:

| Setting | Meaning |
|---|---|
| `JARVIS_PEERS_ENGINE` | Full path of the engine program. Unset, or not a full path: off. Needs `JARVIS_NOTCH=1`. |
| `COLLAB_SERVER_URL` | Passed on to the engine: its server, for the first sign-in. |
| `COLLAB_KEYSTORE` | Passed on to the engine: `file` keeps its key out of the desktop's keychain. |

## Pass I1: the engine under the brain

| File | What it does |
|---|---|
| `src/peers/switch.ts` | The switch. |
| `src/peers/engine-process.ts` | Starts the program with an environment made name by name and a data folder of its own (`<data dir>/peers/engine`, owner only), and in that folder. |
| `src/peers/engine-client.ts` | The brain's end of the line: MCP over the program's standard input and output. Calls a tool, hears a notice, is handed a dialog. |
| `src/peers/engine-read.ts` | Reads what the engine stored (status, contacts, inbox, requests) as JSON, through the program's own command line. |
| `src/peers/engine.ts` | Keeps one engine up: starts it again when it falls, 1 s later at first, doubling to 60 s. |

### Rules

1. **A dialog is never answered by the brain itself.** Whatever the engine asks of the person
   (approve a request, send a result, trust a device, change a rule) goes to one handler and its
   answer goes back unchanged. With no handler, or when the handler fails, or when it gives
   anything but accept, decline or cancel, the dialog is closed. The engine treats a closed dialog
   as "nothing changed". There is no path that says yes without the handler saying it.
2. **The engine is lent nothing.** The brain declares that it can show a dialog (a form, or a web
   page to open) and nothing else. A request of the engine for anything more (a model, most of
   all) is refused.
3. **Its environment is made, not passed on.** The engine decides from its environment whether a
   person can be asked. A brain started from a coding agent's shell carries that agent's variables
   and would turn every dialog off. So the engine gets the allowlist every child of the brain gets
   (`src/util/subprocess-env.ts`), the two settings above, what the desktop's keychain needs, and
   five values set here whatever was set outside: its data folder, arrival notices on, its own
   desktop notifications off, unattended work off, and that a person can be asked. The last is
   said outright because the engine otherwise takes one dialog that was closed at once (no notch
   was up to show it) for proof that nobody can ever be asked. A dialog with nobody to show it to
   is still closed. Nothing of the brain's own reaches the engine.
4. **Reads are fixed commands that open no line.** The command line of the engine does without
   the dialogs its tools go through. From here it is used to read only (it sends nothing; a read
   of the requests tidies the engine's own log of them), with words that are fixed
   in code and `--offline` wherever a command would otherwise connect. A flag is added only when
   its value has the shape it must have (a device id is 22 characters of a fixed alphabet), so
   nothing a contact wrote can become a flag.
5. **A call made while the engine is down fails at once.** Nothing is queued for an engine that
   may come back as another one.

## Pass I2 and I3: an organisation, tell and ask

| File | What it does |
|---|---|
| `src/peers/link.ts` | The seam. Turns the engine's shapes into people, a message, and a decision that is the person's. The notch and the brain know only this. |
| `src/peers/notes.ts` | A note: a few words of data on the last line of a message, so that the other notch shows keys in place of prose. |
| `src/peers/store.ts` | What the brain keeps itself: the organisation's name, what was sent and is waited on, what arrived and was already answered. |
| `src/notch/people.ts` | The notch's side: Home's row, the sheet, signing in, the code, naming the other, tell, ask, what arrives. |
| `sidecar/notch_open_url.go` | The desktop app opens the sign-in page in the person's own browser. |

What a person does, and what happens:

- **Home** has a row: "Make an organisation, so your Pillows can talk." (the notch calls itself
  Pillow, `src/notch/name.ts`). With people in it:
  "Northwind: you and Leo."
- **Make one:** a name, then signing in. The engine asks "sign in at this server?"; the notch puts
  that as one line; yes opens the server's page in the browser, and the person signs in there.
- **Join two machines:** "Invite someone" shows a code on the notch to read out. On the other
  machine "Join with a code" takes it. The code proves to each side that the keys it got are the
  other's. Each then types a name for the other, and that name is the only one the other ever
  has here.
- **"Tell Leo the review moved to Friday"** goes with a three-second window to take it back.
  Leo's notch says "Sam: The review moved to Friday"; ok on it sends "seen" back, and Sam's notch
  says "Leo saw it."
- **"Ask Leo: the review on Thursday or Friday?"** reaches Leo with one key for each answer. The
  pick comes back: "Leo says Friday." With no answer after ten minutes the asker is told once:
  ask again, wait, or take it back.

### Rules

6. **Only the person answers a decision.** A dialog of the engine goes to the call that named its
   kind and to nothing else; one that nobody waits for is closed. The handlers are scripts on
   the notch, and what they return is the key that was pressed there. A key press made by a
   program is not a key press: the desktop app drops injected keys (`sidecar/notch_keys_winlogic.go`).
7. **A yes sooner than a person can read is not taken.** One that comes within 400 ms of its
   question is not passed on, and the question is put again; after three such it is closed. So a
   second tap meant for the line before cannot approve what nobody has read. Showing a code,
   typing one and opening a page approve nothing and are free of this.
8. **Which decision it is, is read from its shape.** The names of a dialog's choices say what it
   is. One whose shape is not known is "other" and is closed, whatever its sentences say.
9. **A page is opened only when it is reached safely.** The sign-in address must be https. The
   brain checks it and the desktop app checks it again.
10. **A person has the name the owner typed.** Never the name a device gives itself, and never
    one the server reports: a contact without a typed name is nobody here. Only a contact the
    engine holds as verified by a code (or vouched for, once that is switched on) is a person.
11. **Saying is approval, and nothing else is said for the person.** "Tell Leo ..." is sent as
    said. Three small things go by themselves, each because of a key the person pressed: "seen"
    for ok on a message, the pick for an answered question, and the organisation's name when
    somebody joined.
12. **What another person wrote is shown and nothing else.** Control characters and marks that
    hide or reorder text are taken out, and it is put on the notch as words. No model reads it,
    nothing runs on it, and it is not kept in the brain's memory. A note on it is checked field
    by field: what does not check is no note.
13. **An answer is one of the answers that were offered, from the one who was asked.** A pick
    that is not among the question's options, or that comes from another device than the
    question went to, is not an answer.
14. **Not now is never no, and a no is an answer.** A message or question left alone waits in
    the count. One the person answered is never shown again, whatever the engine still lists.
15. **A pairing code is on the notch and nowhere else.** It is in no log, not in what was asked,
    and no model sees it: it goes from the engine's dialog to the line, and from the field
    somebody typed it into to the engine.

## Pass I4: a request, and its yes

"Ask Leo's Pillow what changed in the last deck." A request is asked of the other person's
Jarvis, not of the person. The person there says yes or no to it, their Jarvis finds the answer,
and they see the answer before it goes.

| File | What it does |
|---|---|
| `src/notch/people.ts` | Both sides on the notch: asking, the question there, the work line, "Send only that?", the answer coming back. |
| `src/daemon/notch-peers.ts` | Does a request that was said yes to: one turn of the background agent, made for it. |
| `src/daemon/background-agent-service.ts` | The option `outside`: a turn that quotes what somebody outside wrote starts tainted and runs on a thread of its own. |

On the asker's notch: "Asking Leo's Pillow: What changed in the last deck. Leo must say yes
there." with the window to take it back, then "Asked Leo's Pillow. I will tell you what comes
back." Later one of: the answer ("Leo's Pillow: ..." or, when it is long, "Leo's Pillow answered.
Read it?"), "Leo said no. Nothing left Leo's laptop.", "Nothing came back from Leo's Pillow.
Nothing left Leo's laptop.", "Leo's Pillow could not do it.", or after ten minutes with nothing,
once: "Leo has not answered. Wait, or take it back?"

On the asked notch: "Sam asks me: What changed in the last deck. Do it here?" with Do it and No.
Then "Finding the answer for Sam…", then "For Sam: ... Send only that?" with Send it and No, then
"Sent. Only that left this laptop."

Also taken as a request: "get me the Q3 numbers from Leo's laptop", "check the disk space on
Leo's computer". Only the name of somebody this machine is joined with makes it one.

### Rules

16. **Nothing is done before the yes.** The request is opened in the engine only when its line is
    about to be shown, so the engine's own question about it is the line on the notch, and its
    answer is the key pressed there. The work begins after that answer and not before. Esc is
    not a no: the request stays available and waits in the count.
17. **A yes is a yes to one request.** The answer given to the engine is "allow once", with the
    check of the result on. No standing rule is made by it.
18. **What is found is shown before it goes, and what goes is what was shown.** The answer is
    made into lines that can be read (control characters and hiding marks out, at most 4,000
    characters) before it is shown, and that same text is what is sent. On a sheet, closing it
    decides nothing; "Do not send" is the no.
19. **What cannot be read whole cannot be said yes to here.** A request longer than 2,000
    characters is shown as far as it goes, says that it goes on, and has only its no.
20. **A request is done by reading.** It runs as one turn of the background agent. The request
    itself is quoted inside the product's marks for outside content; the sentences around it
    are the owner's. The turn starts tainted, so everything that changes the machine, sends,
    pays or starts another agent stops for an approval of its own, from the first step: the yes
    on the notch was a yes to an answer, not to an action. It runs on a thread of its own, so
    nothing of it is in the conversation with the owner or in what later turns are sent, and
    nothing is learned from it.
21. **A failure is not an answer.** When the agent fails, returns nothing, or is held, nothing is
    sent but the end of the request.
22. **Stopped means nothing goes.** Stop on the work line, a no on what was found, three times
    closing it, the asker taking it back, the brain being started anew in the middle: each ends
    the request with nothing of this machine's sent, whatever is found afterwards.
23. **An answer counts from the one who was asked.** It is read from the engine's record of the
    request this machine made to that device, and only once the answer itself is there, not
    when the word that it ended is. What they wrote is shown as text and nothing else.

## Limits

- The engine answers a tool call in prose. Reading an id out of a sentence is done by the shape of
  the id, never by the words around it, and a newer engine may still word things differently. The
  engine's version is pinned by whoever sets its path.
- The engine's command line is reachable by anything that runs as the same user, including a shell
  the model was given. This is the engine's own limit and holds under a coding agent too. Nothing
  here widens it; nothing here closes it.
- **Nothing that needs the engine's server has been run.** Signing in, the code, a message between
  two machines: all of it is tested against a model of the engine written from its code
  (`src/peers/testing/fake-engines.ts`), and that model can be wrong where the reading was. The
  engine layer itself is tested against the real engine with no network
  (`src/peers/engine-real.test.ts`, run only when `JARVIS_TEST_PEERS_ENGINE` names the program).
- An organisation is a name and the people this machine was joined with. There is no list kept
  anywhere else, no admin, no invitation by mail, and joining is two machines at a time.
- Signing in needs the browser on the machine the brain runs on (the engine waits for the
  browser on its own machine's loopback address). A hosted brain cannot be signed in this way.
- No files cross: a request's answer is text. "Get the deck from Leo's laptop" gives what Leo's
  Jarvis can say about it, not the file.
- The asker cannot tell "they kept it back" from "it was not found": both end with nothing sent.
- A request that is being done when the brain stops is ended with a no. It is not picked up again.
- While somebody's request is open here with its check on, the engine checks everything else
  that goes to that person too. "Seen" and a pick for them are then not sent.
- An answer is looked for every 5 seconds while a request is out, and a taking back is noticed
  within 30 seconds: the engine announces neither.
- The other side is not told that a message waits because its owner is on a call, and "saw it"
  comes only from a Jarvis: a contact on another client sends none.
- The notch says "their Pillow is on" from whether the server could hand a message over at once.
  It knows nothing else about the other side.
- On a Mac the page opener is compiled and has not been run.
