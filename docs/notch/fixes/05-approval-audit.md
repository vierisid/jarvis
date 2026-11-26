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
8. `NotchActions`: the log, 90 days, also writing the audit. Today reads it.
9. `NotchDecidable` and `playDecidable`, questions first.
10. Approvals, mail reply, chase, call follow-up and promises move onto it.

## Owner decisions

26 November 2026:

- The slot reply is shown with the time lit under an 8 s fuse. This bends
  README 199 and restores 61 and 116.
- One `notch_actions` log that also writes audit. No approval rows.

17 November 2026, kept: a nudge Gmail says went is sent. It is not called
"not confirmed" and sent again.

Still open: whether a silent follow-up is also said the next morning
(recommended: no), and whether the log keeps the sent text or only a hash
(recommended: a hash).

## Status

1. done in "notch: a draft that was already in a thread is never thrown away"
   and "notch: Gmail's word after the press counts as sent, a mail that may have gone is looked for first, and only the reply it opened is thrown away"
2. done in "notch: a mail is called sent when the thread or the Sent folder shows it"
   and the second commit named under 1
3. pending
4. pending, phase 2 (the slot reply under an 8 s fuse; README 199 is untouched until then)
5. done in "notch: a chase burns a fuse, shows its follow-up, asks when handed back, and asks again after a restart"
   and the second commit named under 1
6. done in "notch: an approval closed because its instruction ended is not audited as the owner's no"
   and "notch: a request the system closed does not break the owner's run of approvals"
7. pending
8. pending
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
- That a mail may have gone was first kept with why the chase was stuck. A
  chase handed over and back, or told to wait until Monday, then sent it
  again without looking. It is kept with the chase now, with the mail as it
  was sent, and the clock looks before every such send.

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
