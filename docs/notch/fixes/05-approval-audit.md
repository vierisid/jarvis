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
   somebody's draft, said before who it goes to is looked at. Discard only
   in the reply's own frame, and only a reply that holds our text or no
   words.
2. Sent is the thread showing it (a nudge) or the Sent folder showing it (a
   new mail). The page says whether Send was pressed.
3. One `sendMail` protocol for reply, nudge and call follow-up.
4. Slot pick: the letter on paper under an 8 s fuse. Hidden text cut from
   what the model reads. README 199 reworded.
5. Chase: a 5 s fuse after yes, the follow-up shown in full, a hand-back
   asks, a stuck chase asks again after a restart (`stuck_why`).
6. A turn-end withdrawal is closed as the system, not as the notch.
7. Put: cell guard, idempotent copy step, pays check for caught rounds.
8. `NotchActions`: the log, 90 days, also writing the audit. Today reads it.
9. `NotchDecidable` and `playDecidable`, questions first.
10. Approvals, mail reply, chase, call follow-up and promises move onto it.

## Owner decisions

26 November 2026:

- The slot reply is shown with the time lit under an 8 s fuse. This bends
  README 199 and restores 61 and 116.
- One `notch_actions` log that also writes audit. No approval rows.

Still open: whether a silent follow-up is also said the next morning
(recommended: no), and whether the log keeps the sent text or only a hash
(recommended: a hash).

## Status

1. done in "notch: a draft that was already in a thread is never thrown away"
2. done in "notch: a mail is called sent when the thread or the Sent folder shows it"
3. pending
4. pending (README 199 is untouched until then)
5. done in "notch: a chase burns a fuse, shows its follow-up, asks when handed back, and asks again after a restart"
6. done in "notch: an approval closed because its instruction ended is not audited as the owner's no"
7. pending
8. pending
9. pending
10. pending

## What the work proved wrong, or could not prove

- Step 2: a row of Gmail's list has no time, so "in Sent since then" cannot
  be read from a search alone. The matching thread is read for the time.
- Step 2 reverses a choice of the 17 November audit ("Gmail says it went: it
  is sent, whatever the thread shows yet"). The thread is asked three times,
  1.5 s apart, and a nudge is still never sent again as a new mail.
- Step 5: the fuse is burnt with `stage.fuse` directly. `playDecidable` is
  step 9. Taking a chase from a peer sends a mail too, so it got the same
  fuse.
- Step 6: the shared decision function still tells the approval learner of
  a denial for a withdrawal (`recordDenial`). That resets an approval streak
  the owner did not break. Not changed here: it is the product's function.
- Not proven against real Gmail: that the bin sits inside the reply's frame,
  and the Sent search. Both fail safe (a draft is left, or "not confirmed").
