# Point 5: what the notch sends outside the approval and audit path

Working note for the notch fixes. It is removed before the feature merges.
Design: `.claude/notch-fixes/fix-05-approval-audit.md`. Rules: `docs/notch/README.md`.

## Original issue

What the owner sees, case by case:

- Anna asks to move Thursday. The notch offers three times. The owner picks
  "Tue 10:00", sees "Offering Tue 10:00 to Anna", and five seconds later a
  letter a model wrote goes out. The owner never saw the letter.
- "Get Sam's answer by Friday", yes: the first mail went the moment yes was
  pressed. No fuse, nothing to take back. The follow-up was never shown: the
  sheet only said that one would go.
- Leo took a chase and handed it back. It was under way again by itself, and
  a wait later the follow-up went from the owner's mailbox.
- A chase that was stuck when the brain restarted asked nothing afterwards,
  could not be answered, and every new chase of that person got "I am
  already on that".
- The owner had a half-written reply in a thread, with other people on it.
  A yes on the notch for the same thread threw that draft away.
- A nudge or a new mail was written down as sent because the page said
  "message sent" somewhere, or because the reply closed. And a send the page
  had refused was reported as "Gmail did not confirm it went".
- Every instruction that ended with an approval unanswered was written in
  the audit as the owner saying no on the notch.
- Nothing lists what went out in the owner's name. Mail replies, chase
  mails, call follow-ups, jobs and "put it here" leave no audit row.

## Impact

- Text nobody read is sent in the owner's name (slot pick). A mail to the
  owner can carry hidden text that the model reads.
- Mail goes with no way back (chase), or with nobody having said so since
  the chase left (hand-back).
- The owner's own words are lost (draft).
- "Sent" is wrong in both directions: called sent when it was not, and sent
  twice when it was.
- The audit says things that did not happen, and misses things that did.

## Possible solutions

Record keeping:

- Approval rows for every notch action. Rejected: a pending row shows on the
  dashboard, is toasted, and can be approved from Telegram with no fuse and
  nobody watching. It would use the table as a log and none of its engine.
- One `notch_actions` log that also writes the audit. Chosen.

Slot pick:

- A fixed template in place of the model's letter. Rejected: loses the
  letter's language and tone.
- Only cut hidden text out of what the model reads. Rejected as the whole
  fix: it cannot catch white on white.
- A full second yes. Rejected: one key more for every offer.
- The letter on paper, the picked time lit, the fuse burning on it. Chosen.

Hand-back:

- Keep sending, because the count of two mails allows it. Rejected: the yes
  was given before the chase left, and whoever had it may have just written.
- Ask what now. Chosen.

Sent:

- Trust Gmail's words. Rejected: README 62 already says no for replies.
- Ask the thread, or the Sent folder for a new mail. Chosen.

## Chosen solution

1. `page/reply.js`: a reply that is open before Reply is pressed is
   somebody's draft, said before who it goes to is looked at. The reply the
   script opens is marked on the page. Discard removes a marked reply
   whatever it holds, in its own frame, and never an unmarked one.
2. Sent: Gmail saying so after Send was pressed counts on its own for a
   nudge and a new mail (the choice of 17 November, kept). The page counts
   the words before and after, and the reply closing is not it. When Gmail
   is silent the thread is asked, or the Sent folder, by how the mail
   begins. A mail that was pressed and not confirmed "may have gone": that
   is kept with the chase or the call, and every way of sending it again
   looks in the mailbox first.
3. One `sendMail` protocol for reply, nudge and call follow-up.
4. Slot pick: the letter on paper under an 8 s fuse. Hidden text cut from
   what the model reads. README 199 reworded.
5. Chase: a 5 s fuse after yes and on every later yes to a mail, both mails
   shown in full, the mail on the "What now?" sheet, a hand-back asks, a
   stuck chase asks again after a restart (`stuck_why`).
6. A turn-end withdrawal is closed as the system, not as the notch, and
   does not reset the learner's run of approvals.
7. Put: cell guard, idempotent copy step, pays check for caught rounds.
8. `NotchActions`: the log, also writing the audit. Today reads it. Kept
   as long as the audit trail is: nothing is cleared.
9. `NotchDecidable` and `playDecidable`, questions first.
10. Approvals, mail reply, chase, call follow-up and promises move onto it.

## Owner decisions

26 November 2026:

- The slot reply is shown with the time lit under an 8 s fuse. This bends
  README 199 and restores 61 and 116.
- One `notch_actions` log that also writes audit. No approval rows.

17 November 2026, kept: a nudge Gmail says went is sent. It is not called
"not confirmed" and sent again.

26 November 2026, with step 8: the log keeps neither the text of a mail or
a message nor a hash of it, as the audit trail keeps none for a send
approved on the dashboard. It is kept as long as the audit trail is.

Still open (owner to confirm):

- Whether a silent follow-up is also said the next morning (recommended:
  no; it is a row of Today now).
- Whether a row that may have gone counts in "Today: 3 things done" and in
  the morning's count (it does now; the review proposes "3 done, 1 may have
  gone").
- Whether `notch_*` audit rows are kept out of the dashboard's 20-row
  widget (NowRoom), so approvals are not pushed out. Not changed.

## Status

1. done in "notch: a draft that was already in a thread is never thrown away"
   and "notch: Gmail's word after the press counts as sent, a mail that may have gone is looked for first, and only the reply it opened is thrown away"
2. done in "notch: a mail is called sent when the thread or the Sent folder shows it"
   and the second commit named under 1
3. done in "notch: a reply and a nudge are sent in a thread by one way, and a notch taken right after Send still remembers the mail may have gone"
   (`sendMail` in `src/notch/mail/send.ts`; the reply, the picked time and
   `sendNudge` use it, and the chase and the call follow-up through `sendNudge`)
4. done in "notch: a fuse can carry the letter that goes out, on paper while it burns, and vouches only for one seen to its end",
   "notch: a picked time shows its letter under an 8 s fuse before it goes, and Esc brings the times back"
   and "notch: text a sender hid from the eye is not read to the model that drafts the reply"
   (README 199 rewritten, 61 and 62 added to).
   After review: "notch: a wait for time fails when its stage ends, as every other wait does",
   "notch: a draft already in a thread that holds the reply's own words is told apart, and since is pinned before the press",
   "notch: a letter goes only on a page's word that it was seen, the notch stays in sight for it, and a pick taken back is remembered of the reply"
   and "notch: words with no size or not visible are left out where they stand, and what is inside them and shown again is read"
5. done in "notch: a chase burns a fuse, shows its follow-up, asks when handed back, and asks again after a restart"
   and the second commit named under 1
6. done in "notch: an approval closed because its instruction ended is not audited as the owner's no"
   and "notch: a request the system closed does not break the owner's run of approvals"
7. pending
8. done in "notch: one list of what the notch did, written where what came of a thing is known, in the audit trail too, and in Today"
   (`src/notch/actions.ts`; README 262 to 268). After review:
   "notch: an answer, a time and a yes that go to somebody in the owner's name are written down too",
   "notch: a yes to send a chase's mail again is spent once that mail is found or the chase asks again",
   "notch: a thing put or an approval that may have happened is a row of Today, as rule 266 says",
   "notch: a job that failed half way is done in part, nothing tried or never shown is not written, and taken back is the audit's last word",
   "notch: a reply that broke off while Send was pressed is pinned as may have gone, and so is whether an audit row says it ran"
   and "notch: a job a restart cut off may have happened, a found reply is written once, and a list that cannot be made does not stop the notch"
9. pending
10. pending

Steps 1, 2 and 5 were tightened after a second review in
"notch: a mail that may have gone is looked for before every way of sending it again, across a hand-over and a wait".

## What the work proved wrong

- A row of Gmail's list has no time, so "in Sent since then" cannot be read
  from a search alone. The matching thread is read for the time and words.
- The first cut of step 2 asked the thread even when Gmail had said the
  mail went. A thread that lags then read as "not confirmed", and the mail
  could go twice. Reverted to the 17 November choice.
- The first cut told our own draft by how it begins. A draft that begins
  with our words and goes on with the owner's would have been thrown away,
  and a write that failed half way would have been kept. Replaced by the
  mark.
- Step 5: the fuse is burnt with `stage.fuse` directly. `playDecidable` is
  step 9.
- Step 8: the design had `begin()` at the yes and `settle()` after, and at
  attach every entry left `going` became `unsure`. Nothing is written at
  the yes: one call, where what came of it is known. A brain that stops in
  between writes nothing. A yes taken back with Esc, and a fuse nobody saw
  burn out, write nothing either: nothing was decided and nothing done.
- Step 8: the design kept a hash of the text, and cleared after 90 days.
  Neither: see the owner's decisions.
- Step 8: the design had Today read approvals, promises and the log, and
  nothing else. The rows that were there are left as they are: the log
  adds the rows nothing else has, and whatever may have gone.
- Step 8: an approval said yes to on the notch gets an entry in the log
  (what was before the owner, the fuse) and no audit row from it: the
  decision function has written that one. Run by whoever waited for the
  answer, its outcome is `handed`: what came of it is the approval's own.
- Step 8: answering a workflow's question is written by nobody else in
  the audit, so it is written from here. The design had left it open.
- That a mail may have gone was first kept with why the chase was stuck. A
  chase handed over and back, or told to wait until Monday, then sent it
  again without looking. It is kept with the chase now, with the mail as it
  was sent, and the clock looks before every such send.

- Step 3: the design put "hold" and "still waits" inside `sendMail`. They
  are the reply's own (the watcher), and a chase has others: they stay with
  who calls. `sendMail` is the steps in the thread and nothing else. A mail
  of its own (`Mailbox.write`) is another page and is not in it.
- Step 3: a wait on the stage never comes back once the stage has ended.
  Between the two looks after Send that kept the tab's turn for good (no
  mail was read until a restart), never let the thread go, and forgot that
  Send had been pressed. Put right at the source after review:
  `NotchStage.wait` fails when its stage ends. Every script that waits for
  time runs under the inbox or the demo, and both catch that failure.
- Step 3: for a nudge, "since" is now the moment before the press, as its
  comment always said. It had been the moment before the write.
- Step 4: the design cut `aria-hidden` text too. Such text is on the
  screen, so the owner sees it: it is still read.
- Step 4: "fits the paper" cannot be known in the brain. It is counted
  (12 rows of 48 columns with the line of who it goes to,
  `MAIL_SLOT_PAPER_ROWS`), and the page has the last word.
- Step 4, first cut: a page saying the fuse ran out was the proof. A page
  left loaded across a brain update draws no letter and says the same
  word, and the letter went unseen. The proof is positive now: `seen`
  beside `done`, and nothing is sent without it.
- Step 4, first cut: the notch hid behind a fullscreen video on Windows
  while the letter burnt, with Esc not taken. The letter and the line
  before it are a question to the window now.
- Step 4, first cut: font-size 0 or "not visible" on an element cut all
  that was in it. Mail layouts set font-size 0 on a cell and a size on
  what is inside: such a mail read as empty. Only the words standing
  there are left out now.
- Step 4, first cut: that a pick was taken back was known to one line
  only. It is kept of the reply.
- Step 4: a click away from a sheet is an Esc. For a letter under its fuse
  that would have taken the pick back at the owner's next click in their
  own app. A click away from a fuse answers nothing.

## Known limits

- A draft with no words that Gmail brings up only when Reply is pressed
  (the owner changed who it goes to and wrote nothing) is taken for a new
  reply. It is marked, and can be thrown away.
- A restart between Send and the count: the moment to look from is kept
  only once the send has answered. A brain that stops while Send is being
  pressed forgets that a mail may have gone, and the chase sends it again.
- The mark lives in the page. After the page is loaded again, a reply of
  ours left from before is nobody's: it is left, and the thread answers
  "there is a draft already" until the owner removes it.
- The slot pick: the letter is first seen when the fuse starts. Putting it
  in the thread comes before that and takes a few seconds, with only
  "Putting it in the thread..." on the notch.
- Eight seconds is about thirty words read with care. A letter of twelve
  rows is more than that. Both numbers are the owner's to tune.
- While any fuse burns, Esc is the notch's: for eight seconds an Esc meant
  for the app in front takes the pick back.
- The log (step 8): what is sent to somebody is written as "said", also
  when it was a press on a card. Answers the engine carries ("Yes, I took
  it", "Seen", the pieces of a file), a file that arrived, and what is
  done for somebody who asked are not in it. After a restart a reply that
  may have gone and is sent again is one entry, also if both went.
- A brain that stops in the middle of the fuse leaves the draft in the
  thread. Nothing is sent. The brain that comes up asks the question
  again, and a pick says that this reply is already in the thread as a
  draft, until the owner sends or removes it. It is not cleaned up.
- Hidden text: only the inline style of the element itself is looked at.
  White on white, and anything a style sheet or a class hides, is still
  read by the model. The owner seeing the letter is the wall.
- A Mac: the notch that hides for a fullscreen video does not come back
  for a question (`platformNotchAsking` does nothing there). Whether the
  page then knows it is hidden is not known. If it does, it does not
  vouch and nothing is sent. If it does not, the letter burns unseen and
  goes. Point 10's host controller owns this.
- Windows: a hidden notch still reads "visible" to its page
  (`sidecar/panels_reveal.go`), so the page cannot tell. The fix there is
  that the window is not hidden for the letter. The sidecar looks every
  so often: a video that goes fullscreen in the middle of the fuse can
  hide the notch for that long.
- A page left loaded across a brain update shows the bare line and no
  letter. Nothing is sent, and the letter is opened as a draft.
- That a pick was taken back is forgotten with the brain.
- A reply that may have gone is remembered only while the brain runs.
  After a restart the second yes is guarded by the thread's last word
  alone, as it was before.
- A Gmail that is not in English presses nothing: the labels and the words
  the scripts look for are English only (so it was before). Nothing is
  sent, and a draft may be left.
- The question of a mail that may have gone is put up by the chase clock
  when the notch is busy: up to 30 s after the line that announces it.

Only a real Gmail session can settle:

- Undo Send: for its window the mail is neither in the print view nor in
  `in:sent`, so a look in that window says "not there".
- A send-as alias: the mail is from another address than the owner's, and
  "the owner's mail" does not match it.
- The account's time zone against the computer's: the print view's times
  are read as local, and "since then" may be off by the difference.
- Where the bin and the "Message sent" words live: the bin is looked for
  inside the reply's frame, the words in `[role=alert]` and `[aria-live]`
  and on the whole page.
- When a kept draft opens: with the thread, or only when Reply is pressed.
- Whether Gmail keeps an attribute the script sets on the reply's text
  (the mark) for as long as the reply is open. The mark is on the text
  alone, not on its frame: a frame may outlive the reply it held. If Gmail
  drops it, our own half-written reply is left in the thread and said so.
- Whether fifteen hours back is the right reach for the later look.
- The letter under its fuse on a real notch: that twelve rows fit the
  paper without scrolling (also under a camera housing), that the fuse
  draws round a sheet, that the lit time reads as lit, and that the owner
  can read it in eight seconds. Also on a short screen, and with
  right-to-left text.
- The notch hidden over a fullscreen video in the middle of a fuse, on
  both systems: whether it comes back, what the page's timers do while
  its window is hidden, and whether `document.visibilityState` says so.
- A page that survives a brain update: that it shows the bare line, that
  nothing goes, and that the draft opens.
- Whether the page Gmail makes for printing keeps a mail's own `style`
  and `hidden` attributes as they were sent. If Gmail rewrites them, the
  cut of hidden text finds nothing, or Gmail has already cut it.
- How long "Putting it in the thread" takes before the letter is seen.
