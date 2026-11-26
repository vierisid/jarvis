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
    `xargs -0`), after a variable (`FOO=1 rm`), a forced `git push`, a
    method that removes (`.unlink()`, `.rmdir()`, `.Delete()`), and the
    command key with backspace;
  - a raw click (`desktop_click`, `desktop_pointer`) whose look at the
    screen failed is asked once more, then asked of the owner with its own
    reason ("the screen could not be read..."). "Failed" is: no answer in
    time, an error, or a Windows desktop app that said nothing about the
    place (told apart by the machine's reported system: only the Windows app
    can say what is at a place). Where it cannot look by its making (screen
    awareness off, a Mac or Linux desktop app, no machine) the click goes
    ahead as before, and so does a place it looked at and had no name for.
- C6. README 44 and the header of `owner-word.ts`, with a dated decision.

Correction to the review (review-01 F5): an accepted Noticing offer does not
get owner standing. Its id is `notch-offered-...`, which never matched, and
README 193 says a yes runs "with the same approvals for what needs one".
Nothing to fix there under this point.

Still not read as a delete after C5 (the price README 44 already names):
`mv x /tmp/gone` or `mv x /dev/null`, a quoted program name (`"/bin/rm" x`),
`$(which rm) x`, a script file that removes things, `gio trash`, an
AppleScript delete, lowercase `.delete()`, ctrl+D in Explorer, Enter on a
focused Delete button, a button with no name.

## Owner decisions

- 2026-11-26, decision 1: after outside content, ask only for unasked sends,
  commands, installs and settings (the third option above).
- 2026-11-26, coordinator: a click that cannot be looked at by its making
  is not asked about in C5. Asking there would put a question on every raw
  click on a Mac, on Linux and with screen awareness off, against README 44.
  C3 makes that case ask only in a turn that has read outside content, once
  `ownerWord` knows the turn's taint (`notchPressReads` needs a fourth
  answer for it then).
- Open: a code-written question as a guarded turn or a tool-less read; a
  fuse line for a send he asked for; an offer starting as tainted.

## Status

- C1 standing on the turn: pending
- C2 who wrote the words: pending
- C3 the boundary after outside content: pending
- C4 what the words cover, fuse line: pending
- C5 delete reader and click check: done in "notch: a delete by its path,
  behind a wrapper or by the command key is read, and a click is not pressed
  blind". Not done under C5: Enter on a focused button is not looked at
  (needs the desktop app to say what has focus), and the other things the
  screen says about a click (a send) are still dropped until C3. Narrowed
  in "notch: a click is asked about when the look failed, not where nothing
  can look".
- C6 README 44 and header: pending. README 44 does not yet say that a click
  whose look failed is asked about; the header of `owner-word.ts` does.
