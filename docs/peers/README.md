# Other people's Jarvises

How one person's Jarvis talks to another's. Built in passes on `notch/main`. This file states
what is built, the rules it keeps, and where it stops.

It ships dark. With `JARVIS_PEERS` and `JARVIS_PEERS_ENGINE` both unset nothing in `src/peers/` runs.

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
| `JARVIS_PEERS_ENGINE` | Full path of the engine program, named by hand. It is used as it is. Needs `JARVIS_NOTCH=1`. |
| `JARVIS_PEERS` | `1` switches the same thing on with no engine yet: one comes when an organisation is made or joined (see "Getting in"). Needs `JARVIS_NOTCH=1`. |
| `JARVIS_PEERS_SOURCE` | Full path of a checkout of the engine's source. With it this machine can make an organisation, which means hosting its server. Without it, it can join one. |
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
- **"Ask Leo: the review on Thursday or Friday?"** reaches Leo with its answers to pick from
  (a click, or said aloud: the notch has no number keys while it does not have the keyboard). The
  pick comes back: "Leo says Friday." With no answer after ten minutes the asker is told once:
  ask again, wait, or take it back.
- **Long words.** What the person says goes whole. The line that shows it going has three lines,
  so it shows where the words begin (110 characters) and a mark that they go on.

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
    question went to, is not an answer. A question is answered only where all of it can be read:
    the notch shows about three lines of a sentence and fades the rest, so one longer than 140
    characters is opened on a sheet, with its answers as buttons.
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
    decides nothing; "Do not send" is the no. And the sheet must have been seen to its end: while
    its end has not been on screen, the yes key moves it down a page and answers nothing
    (`whole` on the sheet's line, `src/notch/protocol.ts`). The same holds for a long request.
19. **What cannot be read whole cannot be said yes to here.** A request longer than 2,000
    characters is shown as far as it goes, says that it goes on, and has only its no.
20. **A request to find something out is done by reading.** It runs as one turn of the
    background agent. The request itself is quoted inside the product's marks for outside
    content; the sentences around it are the owner's. Everything that changes the machine,
    sends, pays or starts another agent stops for an approval of its own, from the first step:
    the yes on the notch was a yes to an answer, not to an action. It runs on a thread of its
    own, so nothing of it is in the conversation with the owner or in what later turns are
    sent, and nothing is learned from it. A request to have something DONE is another yes and
    another turn: rules 68 to 79.
21. **A failure is not an answer.** When the agent fails, returns nothing, or is held, nothing is
    sent but the end of the request.
22. **Stopped means nothing goes.** Stop on the work line, a no on what was found, three times
    closing it, the asker taking it back, the brain being started anew in the middle: each ends
    the request with nothing of this machine's sent, whatever is found afterwards.
23. **An answer counts from the one who was asked.** It is read from the engine's record of the
    request this machine made to that device, and only once the answer itself is there, not
    when the word that it ended is. What they wrote is shown as text and nothing else.

## Hardened on 19 November

Found by a heavy test pass the same day, before any of it had run against the engine's server.
Each has a test that fails without it.

24. **The notch is never blank while it waits on the engine.** A script that waits on the engine
    says what for ("Reaching the server…", "Making a code…", "Opening what Sam asks…"). Esc on
    that line stops the waiting. The engine has 20 seconds to come back with its first question;
    after a stop, after that time, or when something else took the notch, the flow is over and
    whatever the engine asks later is closed, unanswered. Before, a script could hold the notch
    with nothing on it for as long as the engine was silent, and a tap opened nothing.
25. **A decision goes to the newest call that names its kind.** A call can outlive the script that
    made it (a sign-in waits minutes for the browser). The next try is answered, not the dead one.
26. **A code window does not outlive its script.** When something takes the notch while a code is
    open, the window is closed and the notch says so when it is free again.
27. **What cannot be seen is not there.** Every format character (the marks that hide, join or
    reorder text, the soft hyphen), the tag characters that spell words invisibly, the variation
    selectors and the letters that draw nothing are taken out of what another person wrote and of
    what is about to be sent. A request is kept as what can be read, and that is what the agent is
    handed. Text nobody sees on the notch could otherwise be read by the model, or leave with an
    answer.
28. **A pick goes with the window to take it back,** like anything that goes to another person. A
    pick can be a slip, and one said aloud can be a word that was never said.
29. **A message is sent once.** Every send carries a key of its own. When the line breaks while it
    goes, it is tried once more under the same key, and if that fails too the notch says that it
    does not know whether it arrived. It never says "not sent" for that.
30. **A taking back names what it takes back, and counts only from the one who asked.** It is a
    note with the id of the question (the engine lets a message reply only to something that
    arrived, and a taking back is about something that was sent). A third person naming somebody
    else's question takes nothing off the notch.
31. **More than one person, or another way to reach them, is not a word to the first name.** "Tell
    Leo and Anna ...", "tell Leo, Anna and Sam ...", "message Leo on Slack ...", "ask Leo's
    brother ..." are not taken here. They are instructions like any other.
32. **After the engine or the brain was started anew, what is said is what is true.** The engine
    holds an open request in its own process. Once that is gone the request cannot be answered or
    declined from here: the notch says that nothing was sent, ends it, and does not say "I told
    Sam no" unless Sam was told.
33. **A request that ended does not come back.** Stopped, or taken back, while the answer was
    being found: what is found afterwards goes nowhere and puts nothing in the count.
34. **The people are read from what is stored.** Like the inbox and the requests: the engine under
    the brain is the one line to the server.

## Getting in: making an organisation, joining one (20 November, a demo)

Until here the engine was a file somebody built and named by hand, at a server somebody else ran.
The owner, 20 November 2026: "when I go to make organization, if I make a new one, then it
directly downloads the protocol, it integrates for me, and it starts the server. Like, I get to
choose when to start the server. ... if I instead choose to join a organization, then it would
download the protocol and install it, and start it for me ... but not start the server." And:
"This would only be for a demo."

| File | What it does |
|---|---|
| `src/peers/setup.ts` | The two ways in. Holds the one engine, so that it can be started after the brain is up and started anew when another is put in its place. |
| `src/peers/host.ts` | For whoever makes an organisation: runs the server and its tunnel from the engine's own source, makes accounts, builds the engine for each system. Signs the host in at their own server without a browser. |
| `src/peers/install.ts` | For whoever joins: takes the engine for this system from the organisation's server and puts it in `<data dir>/peers/bin/`. |
| `src/peers/zip.ts` | Reads and writes the archive the engine travels in, so that no machine needs a zip program. |
| `src/notch/people.ts` | The steps on the notch: make, invite, join, the server's row, leave. |

**Make.** "Make an organisation" asks its name, the owner's name in it, and, the first time, the
address of their ngrok tunnel. Then the source's own script starts the server, a proxy and the
tunnel; the engine for this machine is built against that address, put in place and started; an
account is made for the owner and they are signed in. The engines for the other four systems are
built after that, one at a time. Home gets a second row, "Your server is on.", which stops it and
starts it. A server that was on comes back with the brain; one that was stopped stays off.

**Invite.** The host types a name. An account is made at their server, and the notch shows three
things once: the address, the name, the password. Then the code, as before.

**Join.** "Join an organisation" asks the address. The engine for this system is taken from
`<address>/plugin/collab-plugin-<system>.zip`, checked, put in place and started. Then the
sign-in page opens in the person's own browser, and the code is typed, as before.

**Remove somebody.** Each person's row in the organisation's sheet has "Remove". It is asked
once, in the engine's own question, and only when that question is about that very laptop. After
it the two connect with a new code before anything crosses again. It is how a laptop that was
set up anew is taken out as its old self: the host then invites the person again under the same
name, and "New password" lets them back in.

**Leave.** Asked once, because it takes something away. The engine's folder is set aside as
`peers/engine.left-<time>`, not deleted, and the engine starts again with nothing. A host's
server stops.

### Rules

35. **Nothing of the server is in this repository.** It is run from a checkout the owner names,
    with fixed words. The only words that vary are a login name made of `[a-z0-9-]` and a build
    target from a fixed list. No model writes any of them.
36. **The server lives only as long as the brain.** It is started through a watcher that ends it
    when the brain's end of a pipe closes. A brain that is killed leaves no server and no open
    tunnel. Three things make that hold (23 November 2026, after a proxy was left behind and
    held the server's port all morning):
    - The script writes to a file, not to the brain. It says a word on its way out, and into a
      pipe whose other end is gone that word ended it before it had stopped anything.
    - The script runs in a group of its own. A Ctrl-C in the brain's terminal does not reach it,
      and after the script has had ten seconds to go out in its own way, the watcher ends
      whatever is left of the group.
    - Which program a start is, by its number and the moment it was started, is written down
      beside its logs. The next start ends it first when it is still that program, and touches
      nothing when it is not.
    - That moment is read where the clock of the day cannot move it: on Linux the system's own
      count since it was switched on, not the start time `ps` works out from the clock. On a
      machine whose clock is corrected under running programs the same script read four
      minutes earlier than when it was written down (23 November 2026), and would not have
      been known again.
37. **What the scripts get is made name by name**: the allowlist every child gets, the person's
    real home (the tunnel program keeps its account there), and two addresses. Pinned in
    `src/peers/host.test.ts`.
38. **A password passes through once.** It is made by the server's own tool, shown on the notch
    (the invited person's) or used for one sign-in (the host's), and is in no log and no store.
39. **The host is signed in without the question, at their own server only.** Making the
    organisation was the yes. An engine that names any other server gets no answer.
40. **The password goes to the server it was made at and nowhere else.** The page, the form and
    every hop are checked against that address, and the last step only goes to this machine.
41. **The engine a joiner runs is whatever the organisation's server hands out.** So the address
    is one a person typed, never one from a message; it is reached over https, or on this machine
    itself; redirects are not followed; and what comes back is taken only when it is an archive
    holding a program for this system under the build's own name. That is the same trust as
    joining at all: the server is where everything goes through.
42. **An engine has one server for good.** One that is still signed in elsewhere is left only on
    a yes, and its folder is set aside, not destroyed. An engine that was put in place here is
    started with its organisation's address, whatever server the environment names.
43. **An engine named by hand is never written over**, by a join or by a build.

### Where it stops

- **A demo.** The source's script calls itself a test environment: one machine, no backups, and
  the tunnel's address is the server's whole identity. Change the address and every sign-in and
  every build is void.
- Hosting needs bash, bun, curl, openssl and ngrok with an account, on Linux, macOS or WSL. A
  brain on Windows itself can join and cannot host.
- The other systems' engines take a few minutes the first time: each needs its runtime fetched.
  They are built in this order: Mac (Apple chip), Windows, Linux, Mac (Intel), Linux (ARM). The
  invite sheet says which are ready. Until one is built, a joiner on that system is told to try
  again.
- The first start of the tunnel at a real address has been run by the owner only, not by a test:
  the tests use a stand-in script, and the rehearsal outside this repository uses the real script
  with a stand-in for the tunnel program.
- The tunnel program must be signed in to the account that owns the address. When it is not, or
  when it refuses for another reason, the notch says so with the program's own error number, and
  the account it named. The first real try failed on exactly this (number 320). The program's
  log of a failed start is kept in the source's `deploy/ngrok/data/`.
- After the server was off, the others' engines need some seconds to find it again. A message
  said in that time is not sent, and says so.
- A joiner who typed the wrong address and wants another has to leave first.
- On a Mac none of this has been run.

## A file, from one Pillow to another (20 November, a demo)

The engine carries text and no files. So a file crosses as what it does carry: messages, through
the same sealed channel as every word. The owner agreed to that for a demo, capped at 25 MB.

| File | What it does |
|---|---|
| `src/notch/people-files.ts` | The offer, the yes, the pieces, the check, the news on both sides. |
| `src/peers/notes.ts` | The notes it rides on: `file`, `file-yes`, `file-no`, `file-part`, `file-got`, `file-lost`. |
| `src/peers/downloads.ts` | Where a file that arrived is put: the person's Downloads. The desktop app does the saving; the brain's own hand is the fallback. |
| `sidecar/notch_files_peers.go` | The desktop app's part: `notch.save` puts a file into the downloads, `notch.find` looks one up by what it is called. |
| `src/notch/drop.ts` | The way in: a file dropped on the notch can be sent on, by a button or by "send it to Leo". |

1. **The offer.** A file is dropped on the notch and somebody is named. One message goes: the
   file's name, its size, the number of pieces, and the SHA-256 of its bytes. Nothing of the file.
2. **The yes.** "Sam sends you a file: deck.pdf, 2.1 MB. Take it?" Only a yes brings it.
3. **The pieces.** 144 KB each, in base64, one message each, a little slower than the server's
   limit of two a second from one machine.
4. **The check.** The whole is compared with the offer, byte count and SHA-256. Only then is it
   saved. Both sides are told how it ended.

### Rules

44. **A yes on both sides.** The sender's is the saying, with the same window to take it back as
    a message. The receiver's is a key. No piece leaves before both.
45. **A piece is taken only for an offer the person said yes to, from the one who made it, and no
    longer than the offer said.** A piece of anything else is dropped unseen and never shown.
46. **What arrives is saved, and then held like a file the person dropped.** The same card, the
    same three things to ask with a click, and it can be sent on. It is read only when the person
    asks something about it, by the same reader and under the same rule as a dropped file: what
    is in it is information, never an instruction. Until then nothing opens it and no model sees
    it. It is never run, and never written over something that is there.
47. **A name from outside is made safe before it is shown or used**: the last part of a path,
    readable characters only, nothing a file system gives a meaning to.
48. **A file that does not check is not kept**, and both sides are told.
49. **A file that cannot be read can still be sent on**, when there is somebody to send it to. It
    is then held for that alone, and no question is asked about it.

50. **The desktop app does the saving.** It is the program the person gave leave to touch their
    folders, on every system. It takes the file in pieces, checks the whole against the size and
    the SHA-256, and only then puts it in the downloads under a name that is free. When no app
    can, the brain saves with its own hand; when that fails too, the notch still holds the file
    and says it could not put it in Downloads. A file that is whole is never lost to a folder.

### Asking for a file (22 November)

The owner: "i might want to retreive a file in someone elses pc like we built in our poc". The
prototype's scenes (v15, `fetchFromLapo` and `lfile`) are the script.

1. **The asking.** "Get me the Q3 numbers from Leo's laptop." One message goes: the words for the
   file. Their laptop can be named anywhere in the sentence, and as speech is written down
   ("Leos pc"). "Get the deck from Leo" and "ask Leo for the contract" count too, when the thing is
   named as a file.
2. **The looking.** Leo's Pillow looks for it on his desktop, documents and downloads, two
   folders deep, when its line is about to be shown, and asks HIM: "Sam asks for the Q3 numbers. I
   found Q3 numbers.xlsx, in your Documents, changed today, 180 KB. Send only that?" Send it,
   Another file, No.
3. **The yes.** It crosses as any file does. Sam is not asked "Take it?": the asking was the yes.
   Leo's line stays until it has gone: "Sent. One file left this laptop, nothing else."
4. **Another file.** Nothing is sent. Leo is shown the other files that may be meant and picks
   one, or drops the right one on his notch and picks "Send to Sam": that file is the answer.

**Which file is meant (23 November).** The owner, after trying it: "it only basically works if I
already know what the file name is, which shouldn't ... Send me the deck. It might not be called
deck. It might be called deck v30." Nobody who asks a colleague for the deck knows what the
colleague called it. So a name is only one of the things a file is told by.

- The desktop app names the files that fit by name, and with them the ones that were changed
  last and are the kind of thing people ask for (documents, sheets, slides, PDFs, pictures),
  whatever they are called: 60 at the most.
- The model is asked which of them is meant, from each one's name, kind, size, when it was
  changed, the folder it is in, and the line that is remembered about it where the owner once
  had it read. 40 at the most are put to it.
- One file: "I think that is Pillow v30.pdf, in your Documents, in Pitch › Decks, changed
  yesterday, 4.2 MB. Send only that?" ("I found" when its name says so.) Two or three: "Which
  one?", and Leo picks. None: it says so.

51. **The one who asks learns nothing from the looking.** Not what was found, and not that
    nothing was. Only the owner's yes or no comes back, and a no reads the same whatever was
    found. Nobody can find out from afar which files a laptop holds.
52. **A wrong file is not put up as found.** By its name a file fits only when more than half of
    the words that name it are in the name: "the Acme contract" is not found in a Northwind
    contract. What the model picks without the name saying so is put up as "I think that is",
    never as "I found", and it is told that a file about another company, person or project
    than the one asked for does not fit.
53. **What would never be handed over is never named**: a file that is private by its name, a
    shortcut, a folder, an empty file, one that is kept online only, anything in a blocked folder.
54. **An offer skips "Take it?" only for an asking this machine made, of that person, that is
    still open.** One that claims to answer anything else is asked about like any other.
55. **Something to do there is still a request.** "Restart the server on Leo's laptop", "ask
    Leo's Pillow what changed": the request of pass I4, with its two questions on his side.
56. **The model picks from a list and can do nothing else.** What it answers is read as numbers
    of that list: at most three, each a file that is in it. Anything else is nothing. It can put
    a file in front of the owner. It can send nothing, and the yes is the owner's.
57. **It adds what a name does not say, and never takes away what a name does say.** The one
    file whose name fits best is put to the owner even when the model picked another or none.
    A file whose whole name was said is the one, and the model is not asked.
58. **The words asked with, and the names of the files, are outside text to the model**, each
    inside the marks every outside text goes in, cut to fixed lengths before they are framed.
59. **Nothing is opened to find a file.** What is known about one is what the owner had read
    before, and it is about the file at the top of its place, not one of the same name in a
    folder below. The names of up to 40 of the owner's files go to the owner's own model when
    somebody asks for a file. Nothing of them goes to the one who asked.
60. **A folder is gone into two deep and no further**, and never one that is hidden, blocked,
    private by its name, a link to somewhere else, or the kind nobody keeps their own files in
    (`node_modules` and the like). A file is taken from a folder below only through real folders
    of that place.
61. **A look is quick, and a look that is not answered is said.** The desktop app asks for every
    file whether it lies in a blocked place. The blocked list is read once for a look, not once
    more for every file: read for every file, a look through two thousand files took 46 seconds
    on a Windows machine, where the brain waits 8, and nothing said why (23 November 2026; it
    read as folders that could not be reached). Read once, the same look takes about a second
    there. The app writes down how long a look took, and the brain writes down a look it got no
    answer to, with how long it waited.

### A file of one's own, by saying which (23 November)

The owner: "send your own file via voice". "Send Leo the deck", "share the Acme contract with
Leo", "send the deck on my desktop to Leo's laptop". The laptop is looked through as it is when
somebody asks for a file (rules 56 to 61), and what is found is offered as a dropped file is
(rules 44 to 49): the other side is asked "Take it?", and nothing of the file crosses before.

62. **Saying it is the yes.** One file that is clearly meant goes with no question. The line says
    which file and from which folder ("Offering Leo the file Pillow v30.pdf, in your Documents,
    in Pitch › Decks, 4.2 MB…"), and it can be taken back while it burns.
63. **A file that was picked burns longer than one that was dropped**: five seconds, not three.
    A dropped file was in the owner's hand. A picked one they see named for the first time.
64. **Two or three that may be meant are put up to pick from.** That is the answer to "which",
    not a second question. "None of these" sends nothing.
65. **Nothing is offered in place of what was not found.** Not the newest file, and not the
    nearest. The notch says it found none, or that the one it found is too large to be taken
    from its folder, and asks for a drop.
66. **Only a file is looked for.** "Send Leo my regards", "send Leo my number", "send Leo 50
    dollars", a mail, a message, a link and another way to reach them ("by email", "on Slack")
    are not this. With "send", "share" and "forward" anything else is taken for a file ("send
    Leo the tax return"). With "give", "pass" and "hand" only what is named as one ("give Leo
    the Q3 numbers", not "give Leo a hand").
67. **It goes to the people who were named, and to all of them or to nobody.** "Send Leo and
    Anna the deck" offers it to both (rules 130 to 133). With a name in the list that is nobody
    of the organisation, or with "Leo or Anna", it is not sent to the ones that happened to be
    known.

### Where it stops

- A file is found on the desktop, in the documents and in the downloads, two folders deep. It is
  told by its name, its kind, its date, its folder and what is remembered about it, not by
  opening it. 16 MB is the most that is taken from a folder.
- Which file the model picks has not been tried with a real model: the tests and the rehearsal
  use a stand-in for it. That its pick reaches the owner, and only as a pick, is tested.
- The desktop app's saving and looking have been run in its own tests and not on a person's
  machine yet. On a Mac, macOS may ask once whether Jarvis may use the Downloads folder.
- 25 MB, and both sides must be Pillows. Anybody else reads one sentence that a file is offered.
- The sender's brain has to be on when the yes comes. Its pieces start again from the first after
  a restart.
- It is slow by design of the channel: about 14 MB a minute at best.
- An offer that is never answered waits. It is not taken back by itself, and the one who
  offered is not told that it waits.
- "Everybody" and "the team" are not names: a file goes to people who are named.

## Something done on their laptop, while they watch (23 November)

The owner: "build I-10, something done on their laptop while they watch." The prototype's scene:
"Leo asks me to restart the server here. Do it, where you can watch?" One yes, then every step
on the owner's own notch, and Esc stops it.

"Ask Leo's Pillow to restart the server." Leo's notch: "Sam asks me: Restart the server. Do it,
where you can watch?" On his yes: "For Sam, step 1: On this computer, in ~/app, run: systemctl
restart app…" stands for five seconds and is then taken. So for each step. Then "For Sam: The
server was restarted and answers again. Send only that?", and Sam hears "Done on Leo's laptop:
The server was restarted and answers again."

### Rules

68. **What is a thing to do is decided by rule, on the laptop it is to be done on**
    (`peerAsksToDo`): from the words its owner is shown, never by a model and never by the one
    who asks. A request that begins as a question, or ends with a question mark, is never a
    thing to do. One that is taken for a question by mistake can only read: that is the safe
    way to be wrong.
69. **The yes is a yes to an action, and says so.** "Do it, where you can watch?", not "Do it
    here?". The asker's line says so too: "... must say yes there, and watches."
70. **Every step that changes anything is shown before it is taken**, in the words the product
    writes for an approval: the exact command, the exact action. Never the model's own account
    of what it is about to do.
71. **A step on one line is taken when its five seconds are up.** The owner said yes to the
    thing being done, and watches: a key for each step would be a second question. A step that
    does not fit a line is read on a sheet and taken only on a yes.
72. **A step nobody saw is neither taken nor stopped.** When no page says that its time ran out,
    it waits with its line. Left for two minutes it is withdrawn, and the job ends.
73. **Esc stops the whole of it**: that step is not taken, none after it is, the model is not
    asked again, and what it had written is not an answer. The owner hears how many steps had
    been taken. The asker hears that it was not finished, never that nothing was done.
74. **Some things are never done on a colleague's word**, whatever the owner said to the
    request: what deletes, what pays, what sends something to somebody, what installs or
    removes software, what changes a setting, a step that cannot be shown whole, and a
    thirteenth step. The step is not put up. The job ends there, and the owner is told why.
75. **A step belongs to the job it is a step of.** It is marked as one (`watched`), and no other
    surface shows it as a card of its own: not the notch's list of approvals, not a toast, not
    a chat. There it could be said yes to after the job was stopped.
76. **Nothing is left behind.** A step that is waiting when the job is stopped, or that nobody
    decided in time, is withdrawn. A watched turn never leaves an approval to be given later.
77. **No other turn is changed.** A request to find something out, and every turn of the
    background agent's own, still gets "awaiting approval" at once and goes on, and its
    approvals go where they always went.
78. **What was done is shown before it goes**, like any answer (rule 18).
79. **What the owner's own settings refuse stays refused.** A step is only ever a call that
    would have asked. A call the Authority settings deny is denied here too.

### Where it stops

- Which steps a real model takes for a request has not been run: the tests script the model,
  and the rehearsal stands in for the whole of the work. That each step is shown, waits, runs
  on its go and is stopped by Esc is tested against the real gate and the real executor.
- Deleting is told from the kind of the call and from the command's words (`rm`, `del`, `git
  clean` and the like). A command can delete in ways its words do not show.
- The model is not interrupted in the middle of one answer. After a stop it is not asked again.
- A step in an app on the screen is read on a sheet and needs a yes. Pillow's drawn pointer does
  not show where it acts.
- The asker cannot tell a stop from a failure. Both read "It was not finished".
- Twelve steps at the most.

## A time that is free for both (23 November)

The owner: "build I5". The prototype's scene: "Comparing calendars with Leo's Jarvis. Neither of
you sees the other's." Then one time is asked of the other person, who says "Book it".

"Find a time with Leo." The asker's Pillow reads its owner's calendar and works out every free
half hour of the next seven days. Those starts go to Leo's Pillow, which works out the same for
Leo and answers with up to three that are free for both. The asker picks one. Leo's notch: "Sam
wants 30 min. Thursday at 10:00 is free for both. Book it?" On his yes each side is offered the
time in its own calendar, filled in, to save there.

### Rules

80. **Only free times cross, never an event.** A start is a number: whole minutes, on the hour
    or the half hour. No title, no place, no guest, and nothing about a time that is not free.
81. **Which times are free is read off the calendar by rule, on each side**
    (`mailFreeStarts`): Monday to Friday, nine to six in that person's own clock, not today,
    with nothing else in that time. No model is asked, on either side.
82. **The comparing goes at once, with its moment to take it back.** Saying it is the yes. Taken
    back, nothing of the calendar has left.
83. **The other Pillow answers the comparing by itself, and says little**: up to three starts,
    one a day, on the first days that have one. Its owner is told that it answered and how
    many times it named. It is never asked.
84. **A calendar cannot be mapped by asking again.** One person is answered six comparings an
    hour. The seventh gets no answer.
85. **An answer names only times that were asked about.** A start the asker did not offer is
    dropped, and an answer from somebody who was not asked is nothing.
86. **A time is asked of a person, and only that person says yes to it.** When it is asked their
    calendar is read again: a time that is no longer free is said to be so, in the question.
87. **Each side says a time in its own clock.** What crosses is an instant.
88. **Pillow does not write to a calendar.** It reads one. After the two yeses each side is
    offered Google Calendar's own page for a new entry, filled in, in the owner's own browser,
    and the owner saves it there. The notch does not say "booked" for what it did not book.
89. **A slow calendar holds nothing up.** A comparing is answered beside everything else that
    arrives, and the same asking is not answered twice.

### Where it stops

- Reading a real calendar, on either side, has not been run for this: the tests and the
  rehearsal give each side a calendar of their own making. The reading itself is the mail
  layer's, and is used every day for "offer a slot".
- Half an hour or an hour, in the next seven days, on working days, nine to six. "Next month"
  and "on Saturday" are not looked for.
- Two people. "A time with Leo and Anna" is not found.
- The entry is each person's own. Nobody is invited to the other's.
- Somebody with no calendar that Pillow can read is told so, and so is the one who asks.
- An answer that comes after the asker's line has left arrives as news. An asking for one time
  that is never answered waits.

## The rule per person (23 November)

The owner: "build I7". The prototype: the rule is a word on a person's row ("asks every time"),
and after five yeses in a row Pillow offers: "Let me answer those myself?"

On a person's row in the organisation: "Connected by a code. Asks you every time." with a button
"Answer without asking". Or said: "let Leo have answers without asking", "ask me every time for
Leo". With the rule, a thing Leo asks to find out is answered with no question, and the owner is
told after: "I answered Leo by myself: What changed in the last deck. Read what went?"

### Rules

90. **The rule is the engine's own**, for tasks from that contact, and it is read from the
    engine each time it is shown or used. Nothing here answers the engine's questions in the
    owner's place: the engine takes no answer that comes sooner than a person can read, and
    that is not worked round. A rule that cannot be read counts as "asks every time".
91. **A change of the rule is asked once, by the engine, in the notch's words.** The engine asks
    before any rule changes. That question is put on the notch as one line, and only the
    owner's own answer goes back. A question about another person's rule is closed.
92. **"Without asking" is for a thing to find out, and for nothing else.** A thing to do is
    asked about as always ("Do it, where you can watch?"), and what was done is shown before
    it goes, although the engine would let both through. So is a request too long to be read
    whole. A file is asked about as always.
93. **What went without a question is shown after, whole, with the way back.** "I answered Leo
    by myself", the question and the answer on one sheet, and "Ask me every time again" on it.
94. **Whatever does not go as the rule says is put to the owner.** A question the engine asks
    after all, an answer it will not send, a slow engine: the request is then on the notch like
    any other. A request never waits unseen for the engine.
95. **It is offered once, after five in a row.** Five requests from one person that were sent as
    they were found, with no no in between. The offer is the change itself, so it is one
    question. A no to it is an answer: it is not offered for that person again.
96. **A no starts the count again**: a no to the request, a no to what was found, a stop.
97. **The notch is never blank while the engine is asked for the rule**, and gives up with the
    same words as for any other wait on the engine.

### Where it stops

- One rule for a person, not one for each kind of thing. The prototype's "Stripe numbers without
  asking" needs requests told apart by what they are about, and that is not built. So "without
  asking" means every thing that person asks to find out.
- The answer is found by reading, on the owner's laptop, by the background agent. With the
  rule nobody sees it before it goes. That is what the rule is.
- The rules are on the organisation's sheet on the notch. They are not in the dashboard's
  Settings.
- Run against the real engine in the rehearsal. Not run on two people's machines.

## What was circled, shown to somebody (24 November)

The owner: "build I6, i13 and i14". The prototype: "Sending 3 rows to Leo…", and on the other
notch "Sam shows you 3 rows from Sheets: ...".

Circle something, then say "send this to Leo" or "show Leo what I circled" while the notch still
holds it (ninety seconds, as for "put it here"). Leo's notch: "Sam shows you 1,291 from Chrome:
1,291". Several rows are read on a sheet, row by row.

98. **What goes is what was read, and words only.** The rows the notch holds from the look, a few
    words for what it is, and the program's name. No picture of the screen, and nothing of the
    window but its program.
99. **It goes whole or not at all.** More than can be read on the other notch is not cut: the
    owner is told to circle less.
100. **What cannot be seen in a cell does not travel**, as for every text that crosses.
101. **With nothing held it says so.** It does not send the last thing that was held before.
102. **Seen comes back** as for a message, because it is one.

## An agent, sent to somebody (24 November)

The prototype: "Sam sends you Tony: Every Monday send Sam the numbers. Take Tony on?"

"Send Tony to Leo", "share my agent Tony with Leo". Leo's notch shows the sentence the agent was
made from. On "Take it on" Leo's own notch builds it, as it builds any agent.

103. **Its name and its sentence go, and nothing else.** Not the workflow that was built from it,
    not what it has run, and not the rung it stands on.
104. **What it does is read whole before it is taken on.** A sentence longer than can be read
    whole is no offer: it arrives as words.
105. **Taken on, it is built anew, by the taker's own notch, and asks first.** The yes on the
    line is the yes: the sentence is not read back a second time. Everything else is as for an
    agent that was said: one sentence, one agent; built, switched on, named there.
106. **A laptop that cannot make agents takes none**, and the sender hears "passed on".
107. **An answer counts only from the one it was offered to.**
108. **An agent is asked for by its name.** "Send Enzo to Leo", with no agent called Enzo, looks
    for a file. "Send my agent Enzo to Leo" says which agents there are.

### Where these two stop

- What was circled goes as words. A chart or a picture that was circled cannot be shown yet.
- The other side cannot put what it was shown somewhere ("put it here as a table"): it reads it.
- An agent that needs something set up on the taker's side (a connection, an account) is built
  and waits switched off there, as any agent would.

## A job that changes hands (24 November)

The prototype (handChase, lhand, jobTake, askBack): a job goes to a teammate with what was asked,
what was done and what is left. It changes hands only when they take it.

A job is a chase (docs/notch: "until it is done"): getting somebody's answer by a day, by mail.
"Hand Dana's answer to Leo." Leo's notch: "Sam hands you Dana's answer on the contract, due
Friday. So far: 1 step. Take it?", with the history and the mail that would go from Leo's own
mailbox on the same sheet. Taken, Sam hears "Leo took it. Dana hears from Leo now. I tell you
when it is done." Later: "Done. Dana answered. Leo closed it." Or Sam says "ask Leo for Dana's
answer back".

109. **It is the giver's until it is taken.** Offered, nothing changes: the giver's chase goes
    on. A no, or no answer, changes nothing.
110. **One owner at a time.** It stops for the giver when the other says it is taken, and it is
    said to be taken only when the taker's first mail has gone. Handed back, it stops there
    before the giver is told.
111. **Nobody's mail is written in a name unseen.** What the taker's chase sends is on the sheet
    the taker says yes to, to whom, and the follow-up in full with when it goes, as for a chase
    they start. Since 26 November 2026 the taker's yes burns the chase's fuse of five seconds
    before the first mail goes: Esc in it takes nothing, and the giver is told nothing. When Send
    was pressed on that mail and nothing confirmed it, the job is taken all the same, so that one
    person has it: the taker is told the mail may have gone, and their chase asks about it next
    and looks in the mailbox before it sends anything again.
112. **The history that travels is what the notch wrote down**, step by step, the newest twelve.
    It arrives as text, is shown as text, and is kept as the other person's: "Sam: Nudged Dana
    by email."
113. **Who it is got from travels with it**: their name and their address. An address that is not
    one is no job.
114. **A taker who is on that person already cannot take it**, and is offered only the no.
115. **Whoever took it tells the giver once when it ends**: done, or let go.
116. **Asked for back, the taker chooses.** Handed back, what they did comes with it, and the
    giver's chase asks what now: send the follow-up, wait until Monday, or let it go. Nothing of
    it is sent until the giver has said (26 November 2026; it used to be under way again at
    once, a whole wait from its next step, and the follow-up went with nobody having said so
    since it left). Kept, the giver hears so.
117. **An answer counts only from the one it was handed to.**
118. **It hands over what was named, and never picks.** With several under way and none named
    it asks which. Only "hand", or a word that says job, hands a job: "give Leo the deck" is a
    file.

### Where it stops

- A job is a chase. Something that waits on the notch for a yes (a question, an approval) is not
  handed over yet, and neither is a job that is only words.
- The stand-in for the mailbox in the rehearsal writes "its first mail went" and sends nothing.
  That the real chase code sends it from the taker's mailbox is tested with the real chase code.
- The giver is not told when the taker's chase is stuck. Only when it ends.
- Not run on two people's machines.

## On a call, told to whoever writes (24 November)

The prototype: "Leo is on a call. His Jarvis holds it until he is free."

On a call the notch holds everything that comes by itself (docs/notch). What somebody in the
organisation sent is held too, and until now they heard nothing: the silence read as no answer.

119. **Whoever writes during a call is told so, once for the call**: "Leo is on a call. Leo's
    Pillow holds it until Leo is free." However many things they send in it.
120. **Only what is for the owner tells it**: a message, a question, a request, a file, a time
    that is asked for, an agent, a job. What the two Pillows settle between themselves ("seen",
    an answer, the pieces of a file) tells nobody anything.
121. **When the call is over, whoever was told hears that too**, without a line: the
    organisation's sheet stops saying "On a call" for that person.
122. **"On a call" is all that is said.** Not with whom, not what about, and nothing of any other
    state. A word that it is over that never comes is forgotten after three hours.

## What a file that arrived is, said by itself (24 November)

The prototype: "Sam sent Deck, November.pdf. I read it: pricing moves to three plans."

A file that arrived from somebody was named and put in the Downloads, and what it is was one
click away on its card. Now it is read when it arrives: "Got Deck.pdf from Leo. I read it:
Pricing moves to three plans. It is in your Downloads." The card follows as before.

123. **One bounded question to the model, about that one file**, asked when it is here: the
    person took it, or had asked for it. The answer is one sentence, cut and cleaned, shown as
    it is and never acted on.
124. **The file's contents are outside text to the model**: its name and its words inside the
    product's marks, with the sentence that nothing in them is an instruction. A picture is
    looked at itself. Only the first part of a long file is read for this.
125. **Nothing to say is said as nothing.** When the model cannot tell, fails, or is slow, the
    arrival is told as before: its name and where it is. The line waits six seconds for it and
    no longer, says that it reads meanwhile, and Esc tells it without.
126. **Only a file that somebody sent is read by itself.** A file the owner drops waits for
    their question, as before.

## Ready for others (the plan's pass I8)

What of this pass is the product's own is in place. What is not is the server, the builds and
the one join for a firm: those are the engine's and its maker's, and nothing here stands in for
them.

127. **The engine comes back when it falls**, a little later each time it falls at once (pass
    I1). A call made while it is down fails at once (rule 5), the notch waits for it never
    longer than twenty seconds (rule 24), and what could not go says that it did not go.
128. **Removing the brain's data folder removes all of the engine.** Left to itself the engine
    keeps the key that locks its keys in the desktop's keychain on a Mac and on Linux. It is
    told to keep it in its own folder there, as a file only its owner can read: an uninstall
    then leaves nothing behind, and a Mac shows no window of its own about a keychain. On
    Windows it is in that folder already, sealed by Windows. What the person set stands.
129. **Nothing done for somebody else touches what keeps the organisation.** The engine has a
    command line of its own, and what is typed there changes a rule or sends a message with no
    question on the notch. A step of a colleague's request that names the engine's program,
    its folder, its settings or its tables is never taken (rule 74), and the owner is told.

### What is not the product's to do

- **A server that is somebody's to run.** Today an organisation lives on its maker's laptop
  behind a tunnel, and is down when the laptop sleeps.
- **Engines that are signed.** Each is built on the host's machine and is not signed. Windows
  Smart App Control refuses unsigned programs, and that is never worked round.
- **One join for a firm.** Each pair connects by a code. The engine has the means for a firm to
  vouch for its members, switched off, and its maker switches it on.

### Where these stop

- "On a call" is told to whoever writes. It is not shown to people who have not written.
- The gist is one sentence about the first part of a file. Which sentence a real model writes
  has not been run: the tests script it and the rehearsal stands in for it.
- The agent's own tools are not kept from the engine's folder in general: only a step done for
  somebody else is. Keeping every tool of the product out of that folder is not built.
- An engine that already kept its key in a keychain (a Mac or a Linux desktop that ran it
  without `COLLAB_KEYSTORE=file`) would not find it in its folder, and would be a new device.
  No machine that is known to have run this did.

## Two loose ends, closed (25 November)

The owner: "You fix the two loose ends, and I'll test." Both were in the list of what the files
could not do.

### One file, to several people

"Send Leo and Anna the deck", "send the deck to Leo, Anna and Dana", "share the roadmap with Leo
and with Anna".

130. **One look, one pick, one line.** The laptop is looked through once and the file is picked
     once (rules 62 to 65). The line names all of them: "Offering Leo and Anna the file Pillow
     v30.pdf, in your Documents, in Pitch › Decks, 4.2 MB…". It burns five seconds, and taking it
     back takes it back for all of them: nothing has gone to anybody before the line is out.
131. **Each of them gets an offer of their own.** Each is asked "Take it?" on their own notch and
     takes it or not by themselves. One person's no changes nothing for another, and nobody is
     told who else it was offered to.
132. **The line after says to whom it was offered, and to whom it could not be.** "Offered to
     Leo. It could not be offered to Anna now." Never "offered" for somebody it did not reach,
     and nothing of the file is kept for them.
133. **Everybody in the list is somebody here.** A name that is nobody of the organisation, "or"
     in place of "and", or a list that ends in a name that is not known: it goes to nobody. A
     person who is named twice is one person. A file that is about somebody ("send the Anna
     contract to Leo") is not for them.

### An asking for a file that nobody answers

134. **After ten minutes of silence the asker is told, once.** "Leo has not answered about the Q3
     numbers. Ask again, or take it back?", as a question that was asked says it. The
     asking itself waits as long as it takes: only the silence is said.
135. **"Wait" is an answer.** It is not brought up again, and nothing is said to the other.
136. **"Take it back" takes it off their notch.** They read that it was taken back. A yes that
     comes after sends nothing, and a file they then send is an offer like any other, not the
     answer.
137. **"Ask again" takes the first asking back and asks once more.** One asking stands on their
     notch, not two.
138. **Only the one who asked can take an asking back**, as with a question.
139. **An answer that comes while the silence is on the notch takes it away.** The file, or the
     no, is what is said.

### Where these stop

- After a restart of the brain, a silence that was said and not answered is not said again. The
  asking still stands, and its answer still arrives.
- A Pillow from before this day does not know an asking can be taken back: there it stays on the
  notch, and "Ask again" puts a second one beside it.
- An offer to several people is several offers. The sender is not told as one thing who took
  it: each taking is said as it is for one person.

## Any way of saying it (25 November)

The owner: "the keywords to make the pillow perform a certain action or do pillow talk are very
specific [...] if I say, can you get me X from [a colleague], it wouldn't do it [...] we need to
make it be able to be very, very flexible." And: "if I say tell [him] I love him [...] [he]
doesn't see I love you because it sees I love him. So it's literal."

Until this day every sentence about a person was matched against fixed words, and what came after
"tell Leo" went out letter for letter. The fixed words stay: they need no model and take no time.
Under them the model now reads what they leave (`src/notch/people-read.ts`).

### Rules

140. **The fixed words first.** A sentence they fit is done at once, as before, with no model.
     "Tell Leo hi" asks nothing of anybody.
141. **What they leave, and names somebody here, is read by the model.** One question, with the
     sentence and the people it names: is it a word for them, a question, a file of theirs, a
     file for them, something for their Pillow to do, a time with them, something off the
     screen, or none of these. A sentence that names nobody of the organisation is not read and
     waits for nothing. Nor is "remember that Leo ...": that is something to keep. Nor is a reply
     to a question the assistant asked back ("tell Anna instead"): it is the answer, and neither
     the fixed words nor the model take it (docs/notch/README.md, 257). Nor is an entry for the
     owner's own calendar ("put a meeting with Leo on my calendar"), nor a sentence that begins
     as the words for a job that was shown ("continue with the draft to Leo").
142. **A reading does one of the things the fixed words do, and nothing else.** It is done by the
     same code: the same line on the notch, the same moment to take it back, the same yes on the
     other side. The model starts nothing by itself and there is no kind of its own.
143. **It can only go to somebody the sentence names.** The model is shown those people and
     nobody else, by number. A number that is not in its list, a word for several people at
     once, or a name beside them that is nobody here ("send Leo and Bob the deck"): no reading,
     and it goes to nobody.
144. **"None" is an answer.** "What did Leo say in his last email", "email Leo the invoice",
     "remind me to call Leo": the sentence is an instruction like any other and runs as one.
145. **Words about the reader are turned to the reader.** "Tell Leo I love him" reaches Leo as "I
     love you". "Tell Leo to call me": "Call me." "Ask Leo if he is coming": "Are you coming?"
     This is asked of the model only when the words need it: a "he", "his" or "her", or words
     that begin with "to", "if", "whether" or "about". "Hi" and "the review moved" go as said.
146. **Still the owner's words.** The model is told to keep them and their order, to change only
     what makes them read as said to that person, and to add nothing: no greeting, no reason, no
     politeness. Words that are more than 30 letters longer than the whole sentence are not
     taken. And the line shows the words as they will go, for its three seconds, before they do:
     "Telling Leo: I love you…".
147. **A question that one key cannot answer is told.** "Ask Leo how he is" reaches him as a word,
     "How are you?", that he reads and answers in his own words. Only what yes, no or a pick
     answers is a question with keys.
148. **No model, a slow one, or an answer that is no reading: as before.** A word the fixed words
     found goes as it was said. Any other sentence runs as an instruction. The model has eight
     seconds; from 0.4 seconds on the notch says "One moment…".
149. **A word to Leo stays a word to Leo.** When the fixed words found "tell Leo ..." and the
     model makes something else of it, only three things are taken: a word, a question, or a
     file of his ("tell Leo to send me the deck"). Something done on his laptop is never made
     out of "tell Leo".
150. **Esc while it reads turns it away.** Nothing was started. While the model reads spoken
     words they are still on the notch, and Esc there is a no.
151. **What is told is in no log.** The log says which kind the model read a sentence as, never
     its words, and never what a provider said when it failed.
152. **A name that is exactly somebody here is not read back as somebody else's.** A spoken
     name that is close to one of the people the owner writes with is asked about before
     anything runs ("Is that Lea Rossi?"). When somebody of the organisation has that very
     name, that is who was named, and nothing is asked. Two people the owner writes with who
     both have the name are still asked about.
153. **One model for one sentence** (26 November 2026). Every sentence the fixed words miss is
     now read once, by one question that asks what it is of everything the notch does itself
     (docs/notch/README.md, 263). When it names somebody here, the question of 141 is part of
     that one, word for word (`NOTCH_PEOPLE_READ_KINDS`, `reads` in `src/notch/people.ts`): the
     same people by number, the same parse, the same doing (142 to 147), the same eight seconds
     and the same middle tier (148), counted as `notch_intent_people`. It is never asked as
     well: `read` alone is asked only where there is no reader of every sentence. Turning the
     words of "tell Leo I love him" to the reader (145) is still its own question: those are
     fixed words, which no reader is asked about.

### Where it stops

- Handing over a job, sending an agent, the rule for a person and opening the organisation are
  still understood by their fixed words only.
- A word for several people at once ("tell Leo and Anna hi") is still not sent to anybody.
- A name that speech wrote down wrongly is not recognised. The reading starts from a name that
  is one of theirs.
- A name beside the others that is nobody here is told by its capital letter. Typed small ("send
  leo and bob the deck"), it is left to the model, which is told to answer none, and to the line
  that names who it goes to before it does.
- The turning is asked of the model by a list of English words. In another language the fixed
  words do not fit at all, so the whole sentence is read by the model, which answers in that
  language.
- How long the model takes to read a sentence was not measured on a real one.

## Limits

- The engine answers a tool call in prose. Reading an id out of a sentence is done by the shape of
  the id, never by the words around it, and a newer engine may still word things differently. The
  engine's version is pinned by whoever sets its path.
- The engine's command line is reachable by anything that runs as the same user, including a shell
  the model was given. This is the engine's own limit and holds under a coding agent too. Nothing
  here widens it; nothing here closes it.
- **The tests here do not use the engine's server.** Signing in, the code, a message between two
  machines: in this repository all of it is tested against a model of the engine written from
  its code (`src/peers/testing/fake-engines.ts`), and that model can be wrong where the reading
  was. The engine layer itself is tested against the real engine with no network
  (`src/peers/engine-real.test.ts`, run only when `JARVIS_TEST_PEERS_ENGINE` names the program).
  The real server and engine have been run with it outside this repository: by two people on
  20 November 2026, and in a rehearsal of two notches on one machine.
- An organisation is a name and the people this machine was joined with. There is no list kept
  anywhere else, no admin, no invitation by mail, and joining is two machines at a time.
- Signing in needs the browser on the machine the brain runs on (the engine waits for the
  browser on its own machine's loopback address). A hosted brain cannot be signed in this way.
- A request's answer is text. "Get the deck from Leo's laptop" gives what Leo's Jarvis can say
  about it, not the file. A file crosses only when its owner drops it on the notch for somebody
  (see "A file, from one Pillow to another").
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
