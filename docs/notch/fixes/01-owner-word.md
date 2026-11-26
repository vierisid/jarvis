# Point 1: "Saying it is the approval" reaches beyond what the owner said

Working document for the fix. It is removed before the feature merges.
Rule concerned: README 44 (`src/authority/owner-word.ts`).

## Original issue

The owner decided on 13 November 2026: "If I ask something, it should do it.
Everything apart from deleting and payments." In a turn he starts on the
notch, nothing is asked about except a delete and a payment. The review found
five places where the product does more than that sentence says.

1. Nothing was said, yet it counts as said. Circling a paragraph without a
   word, or clicking "Summarise it" on a file a colleague sent, starts a turn
   with a question the code wrote, and that turn has the owner's standing.
2. Real words, but the content asks for more. "Summarise this" on a dropped
   PDF: text hidden in the PDF can get a mail sent or a command run in the
   same turn, with no question.
3. The standing is a naming convention. A turn has it when its request id
   starts with `notch-typed-` or `notch-spoken-`. Any code inside the brain
   that names its id that way gets the widest waiver in the product.
4. A delete that is not read as one. `rm x` was asked about; `/bin/rm -rf x`,
   `env rm x`, `FOO=1 rm x`, `git push --force` and cmd+backspace in Finder
   were not.
5. The click check said "go" when it could not look. With screen awareness
   off, an older desktop app or no answer in 3 seconds, a raw click on
   "Delete" or "Buy now" went ahead unasked.

## Impact

1 and 2: a page, a PDF or a colleague's document can drive the machine
(send, run, install, change settings) while the owner sees only a summary.
It needs hostile content and a model that follows it; high when it happens.
3: nothing is seen today; the risk grows with every new in-brain caller.
4 and 5: the two things he said must always be asked were not always asked,
in ordinary forms and with an ordinary setting.

## Possible solutions

Standing (3): a tighter pattern or a second guard on the id (still a
convention, rejected); a signed id (more machinery, same result, rejected);
an object on the turn, made in one place (chosen).

Code-written questions (1): a bounded call with no tools (safer, but loses
the follow-up and the ledger row, rejected for now); the turn records who
wrote the words, and "shown" words carry no standing (chosen).

After outside content in a turn with real words (2):
- ask again about everything the guard governs. Opening an app counts as
  outside content, so "open Notepad and write a poem" would stop at every
  step again. This is what he rejected on 13 November. Rejected.
- ask only for what reaches out or runs code: a send, a command, an install,
  a change of settings. Clicks, typing, pages and file writes stay free.
- the same, minus what his own words asked for ("reply to this" sends,
  "summarise this" cannot). Chosen, see Owner decisions.

Delete reader (4): chase every form a shell allows (unwinnable, rejected);
ask about every command (undoes his decision, rejected); keep it a reader of
ordinary forms and repair it (chosen). Hostile forms matter less once a
command after outside content is asked about as a command.

Click check (5): tell "could not look" from "looked and nothing is there",
ask once more on a failure, then ask the owner (chosen).

## Chosen solution

- C1. Standing becomes an object on the turn (`TurnStanding`), made only by
  the notch wiring. The id keeps its format and stops meaning anything.
- C2. The standing says who wrote the words: typed, spoken, or shown. A
  shown question (silent circle, a suggestion button, an arrived file) has
  no owner word; its attachment taints the turn and the ordinary guard asks.
- C3. The boundary: in a turn with real words that holds outside content, a
  send, a command, an install or a settings change he did not ask for is
  asked about. One shared function for the main agent, a helper and
  `request_approval`.
- C4. What his words cover (a closed set: send, run, install, settings),
  read once from his sentence, using point 3's intent table.
- C5. Repairs, independent of the rest:
  - the delete reader also sees a command named by its path (`/bin/rm`),
    past an alias (`\rm`), behind a word that only runs what follows (`env`,
    `command`, `nohup`, `time`, `nice`, `timeout`, `busybox`, `sudo -u x`,
    `xargs -0`, also by its path and past `--`), after a variable
    (`FOO=1 rm`), a `git push` that forces, deletes, mirrors or prunes, a
    method that removes (`.unlink()`, `.rmdir()`, `.Delete()`), and on the
    desktop the command key with backspace (not in a page). The same reader
    decides what a peer may not do on this machine (`peerStep` in
    `daemon/notch-peers.ts`), so that is wider too;
  - a raw click (`desktop_click`, `desktop_pointer`) whose look at the
    screen failed is asked once more, then asked of the owner with its own
    reason ("the screen could not be read..."). "Failed" is: no answer in
    time, an error, or a Windows desktop app that said nothing about the
    place (told apart by the machine's reported system: only the Windows app
    can say what is at a place). Where it cannot look by its making (screen
    awareness off, a Mac or Linux desktop app, no machine) the click goes
    ahead as before, and so does a thing it read the kind of and had no name
    for (a Pane in a game). A window named with nothing read in it is a look
    that failed. An element id the Windows app no longer knows cannot be
    told from a read that broke, so it asks.
- C6. README 44 and the header of `owner-word.ts`, with a dated decision.

Correction to the review (review-01 F5): an accepted Noticing offer does not
get owner standing. Its id is `notch-offered-...`, which never matched, and
README 193 says a yes runs "with the same approvals for what needs one".
Nothing to fix there under this point.

Still not read as a delete after C5 (the price README 44 already names):
`mv x /tmp/gone` or `mv x /dev/null`, a quoted program name (`"/bin/rm" x`),
`$(which rm) x`, `{ rm -rf x; }`, `eval rm x`, `bash -c "./rm x"`, a script
file that removes things, `npx rimraf` / `bunx rimraf`, `trash-empty`,
`gio trash`, `aws s3 rm`, `curl -X DELETE`, `gh repo delete`, `git tag -d`,
`truncate` other than `-s 0`, a push handed to another machine
(`ssh host "git push -f"`), an AppleScript delete, lowercase `.delete()`,
ctrl+D in Explorer, the command key with backspace in a page, Enter on a
focused Delete button, a button with no name.

Read as a delete though it is none, and left so (each costs one question):
a bare verb after a closing quote or a `-c` (`grep "x" rm`, `wc -c del`, as
before C5), `tar -c /usr/bin/rm x`, `sudo -v rm`, `exec -a rm ls`, the
command key with backspace in a text field on the desktop.

## Owner decisions

- 2026-11-26, decision 1: after outside content, ask only for unasked sends,
  commands, installs and settings (the third option above).
- 2026-11-26, coordinator: a click that cannot be looked at by its making
  is not asked about in C5. Asking there would put a question on every raw
  click on a Mac, on Linux and with screen awareness off, against README 44.
  C3 makes that case ask only in a turn that has read outside content, once
  `ownerWord` knows the turn's taint (`notchPressReads` needs a fourth
  answer for it then).
- 2026-11-26, after C3 (the coordinator, against the owner's 13 November
  rule): on a machine that cannot say what a click lands on, a raw click
  is asked about only after outside content of another kind than an app
  the turn opened and its windows (`onlyTheOpenedApp`); and a bare yes
  holds outside content only when the turn that asked held some.
- For the owner to confirm, taken while building C3:
  - recipients fail closed: a send to somebody his words do not name is
    asked about (one constant, `RECIPIENTS_MUST_BE_NAMED`);
  - the unasked act is asked about also when `authority.taint_gating` is
    off (or does not govern that category): the boundary is the owner's
    word, not the ordinary guard;
  - the turn note for the model (`NOTCH_TURN_NOTE`, pinned by hash) does
    not mention the new questions; it still says "do not call
    request_approval" for sends, commands and installs he asked for, and
    the questions for what he did not ask for come from the gate alone;
  - where the line for a blind click falls (narrowed after the security
    review): the turn opened an app that is no browser, mail or chat
    client or document viewer (an editor such as Word counts as the
    owner's), every window it read is of that app's processes, and no
    picture of the whole screen was taken. The list of windows is taken as
    the app's (titles only). A send made by a raw click on such a machine
    after a dropped file is asked about;
  - coverage is per kind for the whole turn: "run the tests" covers every
    command in that turn, "reply to this" every send (to whoever wrote the
    thing), "install ..." every command that only installs;
  - the history of the shared notch conversation can carry quoted injected
    text into a later turn, which starts clean;
  - "email Anna the log" does not cover a mail program run as a command
    (asked);
  - every file read and every command's output counts as outside content
    for this boundary, wherever the file is (nothing here can tell the
    owner's files from a download), so "run the build and email Leo" asks
    about the mail if the words did not ask for one;
  - recipients are matched on the address only, so "send Anna Rossi the
    file" to "Anna Rossi <a.rossi@...>" is matched by "rossi", and
    "send Anna the file" to it is asked;
  - keys: Win alone, Win+R, Cmd+Space and Alt+F2 open a run place, and an
    app named there (as `plainAppOpen` reads a name) is an app opened;
    Ctrl+Alt+T is a command; Enter alone on a page that is no chat, a
    nameless button, and a click on a remote browser's element after its
    snapshot named it go by what it says; before such a snapshot, or on an
    element it did not list, a browser click after outside content is
    blind (asked when the content is of another kind than an opened app,
    which a page always is).
- Open: a code-written question as a guarded turn or a tool-less read; a
  fuse line for a send he asked for; an offer starting as tainted.

## Status

- C1 standing on the turn: done in "notch: a turn's standing is an object
  the notch makes, and a question the notch wrote is not the owner's word",
  and after review in "notch: a turn's standing is taken back when the turn
  ends, a shown turn always holds outside content, and a bare yes to its
  question is not the owner's word". How it is carried and where it stops
  is in README 41. Two things the design had differently: nothing is
  "resumed after a restart" (a restart fails every running turn, and a
  notch attached again in the same process finds the turn's standing still
  in the turn store), and the standing has only `origin` so far (`words`
  and `covers` belong to C3 and C4).
  Still a way in, by its making: any code in the brain can import
  `mintStanding` and call the turn store's `submit` (the sites test names
  the five files that name the module, in `src` and `bin`), code that runs
  inside a live owner turn has that turn's standing, and the script route
  (`/api/notch/script`, behind the demo token) types and speaks as the
  owner on purpose.
- C2 who wrote the words: done in the same two commits, as a guarded turn
  (the open decision below was taken that way for now). A shown question
  is its own kind of row in the ledger ("Asked for you").
  The interim bare-yes rule of this step was replaced by C3 (below).
  Limits that remain: what a turn's words covered, and that a turn was
  itself a bare yes to a shown turn, are kept in memory only. For an
  answer brought back after a restart, a bare yes to it covers what its
  question asks and no more, and after a shown turn's yes it is the
  owner's word again (held by the boundary now, no longer free). An
  answer with any word of its own ("the second one") is judged by its own
  words in a turn that starts clean, whatever the question proposed.
- C3 the boundary after outside content: done in "notch: after outside
  content, a send, a command, an install or a change of settings the owner
  did not ask for is asked about". One function (`ownerWord`) for the main
  agent, a helper and `request_approval`; which kind a call is comes from
  the gate's categories (`callActs`), no list of tools. What the turn has
  read is the tool loop's own live set (`withOutsideContent`), so content
  that arrives mid-turn counts from the next call. The interim bare-yes
  rule is replaced: a bare yes to an owner's-word turn covers what the
  question asked and what the words before it covered, and holds the
  question as outside content (narrowed in the follow-up below); to a
  turn with no owner's word (shown, an offer that was taken) it stays a shown turn, which is stronger than the
  boundary. The offer case fell out of the same rule. A blind click
  (`notchPressReads` answers `blind`) asks only after outside content
  (narrowed in the follow-up below).
  Design claims that did not hold: nothing is "resumed after a restart";
  the product has no send tool with a recipient field (sends are clicks,
  commands and skills), so the recipient rule guards tools that may come;
  an install or a settings change done by a command arrives as
  `execute_command`, so "install ..." and "turn on ..." also cover the
  command that does it and no other.
- C4 what the words cover: done in the same commit
  (`authority/words-cover.ts`). No fixed intent's sentence becomes a turn
  today, so the intent table's `act` is read through `actsOfIntent` only by
  the seam; sentences are read by the deterministic reader until point 3's
  classifier passes its acts as `read` (a set: "install vite and email Anna
  the log" asks for two). The fuse line for a send he asked
  for (open decision) is not built.
- C5 delete reader and click check: done in "notch: a delete by its path,
  behind a wrapper or by the command key is read, and a click is not pressed
  blind". Not done under C5: Enter on a focused button is not looked at
  (needs the desktop app to say what has focus), and the other things the
  screen says about a click (a send) are still dropped until C3. Narrowed
  in "notch: a click is asked about when the look failed, not where nothing
  can look" and, after review, in "notch: the delete reader past a wrapper's
  path and a push's other forms, in linear time, and a window alone is not a
  look".
- C6 README 40, 41, 44 and the header of `owner-word.ts`: done in the same
  commit, dated 26 November 2026.
- Follow-up to C3 (blind click and bare yes, above; `read` is a set of
  acts): done in "notch: opening an app brings no question at a blind
  click, and a yes to a turn that read nothing is a clean turn". What a
  turn read is kept by its id, in memory, for the last 300 turns
  (`turnOutsideRead`); not known (a restart, an older turn) is taken as
  read.
- Security review of the branch (fix first, eight findings): done in
  "notch: install and turn-on words cover each command in the line only
  when it installs or sets, a guarding setting needs naming, and an upload
  or a push is a send", "notch: a send is named by its address and by the
  place in his words that says who it goes to, and reply in a question he
  said yes to names nobody", "notch: a file read, a command's output, a
  window the turn did not open, an app that shows what others wrote and a
  whole-screen picture count as outside content for the owner's word",
  "notch: a bare yes with no question known to answer is a yes to a turn
  that read anything" and "notch: after outside content a send or a
  command made by a browser click, a key or typed text is read from where
  it lands, and Enter where nothing can look is asked like a blind
  click". Not read: a send typed into a mail window and sent by a click on
  a nameless button; Enter on a web form that is no chat; the local
  browser's page title (only its address is kept).
