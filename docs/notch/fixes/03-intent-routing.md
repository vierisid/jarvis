# Point 3: what a sentence means (intent routing)

This file is removed before the feature merge. It is the short record of one point of the notch review.

## Original issue

A sentence typed or said to the notch is offered to thirteen routers in a fixed order (src/notch/real.ts,
`side`): dayOne, mail, put, teach, people, standing, agents, memory, calls, prefs, moves, canDo, saidLine. The
first that takes it wins. Behind them come three more deciders in src/notch/asks.ts: the reading of words that
name somebody, the memory, and the pointing at the screen. Each router has its own regexes and nobody owns the
whole. What the owner saw, and what the corpus now pins:

- After one job was ever taught, "do it" replays that job for good. Said as the reply to the assistant's
  "Shall I send it?", it replays the recorded clicks and keys on whatever is in front. So do "do it by email",
  "continue with the draft to Sam", "finish it by Friday", "repeat that please, I did not hear".
- "every weekday at 9" is read as every day. "every morning at 6" as 18:00. "every night at 11" as 11:00.
  "every 2 weeks on tuesday at 14:30" as every day at 14:30. A second time ("and friday at 4pm") lands in the job.
- "put a meeting with Sam on my calendar for Friday" starts a comparing of calendars with Sam's machine.
- "how do I cook rice" reads the window in front and sends its list of elements, or a picture of it, to the
  model before the question runs.
- Italian commands ("tienimi d'occhio la risposta di Sam", "impostazioni", "fallo") are no intent at all: they
  go to the assistant as a general turn. A few Italian words are fixed words ("guardami", "annulla").
- "pause", typed or said, is an instruction to the assistant, not a pause.
- A value typed into a lit word is parsed by the page: "month" becomes Monday, and characters are stripped.

## Impact

- Safety: a reply to a question can act on the screen at once. The language of a sentence picks the path it
  takes, and so which checks it meets.
- Privacy: window content leaves the machine for questions that are not about the screen.
- Trust: a schedule is rewritten without a word, and the line that shows it has one button, "make agent".
- Upkeep: every new feature adds regexes to a chain where order is the only precedence rule.

## Possible solutions

1. Patch the regexes again. Rejected: it is how the chain got here; each patch moves the capture elsewhere.
2. Reuse the dashboard's voice classifier. Rejected: a 10k token prompt with a room schema, 14 to 23 s locally.
3. A `notch_intent` tool for the assistant's general turn. Rejected: it is the failure of 17 November (an agent
   built by the assistant, switched off and unnamed), and it runs under the approval waiver.
4. A classifier on every sentence, fixed words gone. Rejected: "undo" would wait for a model, nothing would
   work without one, and rule 140 of docs/peers/README.md says the fixed words come first.
5. One table of intents with preconditions and ranks, the fixed words kept as its fast path, and one small
   classifier under them for what they miss. Chosen.

## Chosen solution

The policy already exists for people (docs/peers/README.md, rules 140 to 151): fixed words first, with no
model; under them a closed reading that can only pick one of the things the fixed words do. The fix makes
that the rule for every feature. In steps:

- C1. A corpus that pins today's behaviour, wrong rows marked. No production change.
- C2. One table (src/notch/intents.ts). Each feature contributes entries: id, rank, precondition over a
  snapshot of state, fast path (today's regexes, moved unchanged), examples, must-not-match, effect, and
  whether it acts at once or shows a line first. Resolved once per sentence and kept on the instruction.
- C3. Precedence and preconditions: ranks (what is up, then commands, then things that open), declared
  overlaps, a reply to the assistant's question skips every intent not open in a reply, teach.run needs a
  live context, must-not-match rows for the wrong captures, "pause" as a control word.
- C4. The classifier (src/notch/intent-read.ts): low tier, the sentence plus the intents whose precondition
  holds plus the front app's name, never window content. An answer that is not one of the offered ids is
  "none". It replaces people.read and the screen call for questions that are not about the screen.
- C5. One When (src/notch/when.ts): weekday means Monday to Friday, "morning" and "night" set the half of the
  day, every word of a schedule must be read or it is no schedule. Replaces the four parsers of a time.
- C6. The page sends the raw text of a lit word; the brain reads it and answers with an update or a refusal.

Cost: fixed words stay at 0 ms. A sentence they miss waits about 1.6 s (measured mean, cut at 2.5 s) before
the general turn.

## Owner decisions

- Decision 4 (2026-11-26): the classifier runs on every sentence the fixed words miss. Measure afterwards
  under `notch_intent`, then decide whether plain English questions with no live context may skip it.
- Decision 5 (2026-11-26): "do it again" with no fresh job acts at once only when the job's window is in
  front. Otherwise it shows a line ("Do <job> again?") and waits for the yes.
- Not decided yet, so pinned in the corpus and not marked: a bare "at 6" (afternoon or refused), "stop" as a
  control word, whether open intents and commands rank above an open mail draft ("pause" does, since C3), what
  the classifier may see of the screen beyond the app's name, what a sentence that could not be read in time
  may do.
## Owner to confirm

Each of these is how it is built now, and one line to change.

- In a reply to a question the assistant asked back, only "pause" and "undo" are still the notch's own. That
  holds after any one-line answer that ends in "?". So "watch me", "paste", "where is ...", "settings" and
  "tell Anna instead" typed or said there go to the assistant as the answer (`inReply` on an intent).
- With a mail draft open, "day one", "look around" and "show me around" are what the reply is to say, as
  "settings" already was. They used to start day one, only because day one stood first in the old order.
- "Repeat that" with a job that was shown some time ago asks "Do <the job> again?", as every way of asking for
  the job does. Whether it should mean the assistant's last answer is not settled.
- "Block an hour with Leo in my calendar" (put, add, block, note ... on my calendar) no longer finds a time
  with Leo: it goes to the assistant as an entry to make.
- An eye ("tell me when Sam replies") is kept at once with nothing asked, as it always was. It is the one
  intent that creates something with no line first and no live context (`alone` says why).


## What C1 found that the design had wrong or did not have

- The chain is asked twice per sentence, not three times: asks.ts has three call sites, and one sentence
  passes two of them (line drawn or name checked, then run).
- With a draft open, "do it" is not taken by mail (mail treats a leading "do" as a question). "settings",
  "undo", "continue", "pause" and "tell Anna I'm late" are taken and rewrite the draft.
- With an offer up and a job taught, "do it" said over the offer replays the job instead of saying yes.
- As a reply to the assistant's question, "tell Anna instead" becomes a word to Anna.
- "every day at noon" is read as 9:00 with "at noon" left in the job. "every day at 25" the same.
- In a window that lists its elements, a question that is not in the list sends the list and then a picture.
- The page reads "sunset" as Sunday, "satisfied" and "saturn" as Saturday, "money at 9" as Monday at 9:00.

## What C2 and C3 found that the design had wrong

- An eye ("tell me when Sam replies") has no line of its own: it is kept at once and then said. The table
  calls it "create" and lets it off the line-first rule by name.
- "Find" says whether a job's window is there, not whether it is in front, and it takes another window of the
  same program and size for it. Decision 5 uses the act `front`, which both desktop apps had and the brain
  never called, and takes only the very window.
- The design's must-not-match list was for the classifier. On the fast path a sentence that an intent takes
  never reaches a classifier, so the fast path itself had to stop taking them: the words for the job are now
  the whole sentence, and two narrow guards cover the calendar entry and the "daily ... should" statement.
- "Get the reply from support" (A4) is still a chase: it shows its own line, and whether a name the notch does
  not know may be chased is not settled. It is not marked.

## Status

- C1 corpus: done in "notch: pin what every sentence means today in a corpus, wrong rows marked"
  and "notch: the corpus asks the product's own resolver, and its row counts are pinned"
  (src/notch/intents-corpus.test.ts, src/notch/intents-corpus.txt; 242 routing rows, 80 time values, 91 marked
  wrong, counts pinned per section). The chain of real.ts is now one exported function, `notchSide`, that the
  notch and the corpus both call: same routers, same order, same arguments. A taught job done again is let run
  against stand-in hands, so its rows say "acts at once" today and can flip to "a line first" (decision 5).
- C2 table: done in "notch: one table of intents that every part hands its words to, asked once for an
  instruction" (src/notch/intents.ts). Every part has `intents()`, a list; `notchSide` resolves over the table
  and says which intent took the sentence; asks.ts asks once and keeps the answer (`routed`). No routing changed
  in that commit: the corpus stayed as it was but for the "asked twice" pins, now "once". Day one got no
  `noted` hook: its note is made in the one intent that is asked about every sentence.
- C3 precedence, reply rule, control words: done in "notch: a reply is the answer, a shown job asks before it
  is done again, and pause is a word" and, after review, "notch: what is said over a line keeps to its own
  place, a job just shown is still done at once, and only its very window counts as in front". Bands (control,
  up, command, open, said), `over` and `never` held by tests over the corpus, the reply rule, decision 5 with
  the states "front", "fresh" and "shown", the words for the job as the whole sentence, the calendar entry, the
  "daily ... should" statement, "pause" and "pausa". 41 routing rows and 1 time value lost their mark; 27 and
  22 are still marked (C4: 20 routing; C5: 5 routing, 13 times; C6: 9 times; C4 with C5: 2 routing).
  What the review changed: an answer over a line stands before a command only as a plain yes ("do it"), and
  everything else said over a line is asked last, as before the fix; a job shown or saved in the last three
  minutes is done at once, as before; "in front" is the very window, never a lookalike; "undo" stays the
  notch's own in a reply; "continue", "run it" and their kin are no more the owner's word than a bare yes
  when they answer a turn that had none; the model that reads names is not asked about the calendar entry
  or, with a job shown, about a sentence that begins as the job's words.
  Every intent has `act` (none, answer, screen, send, create, command, install, settings) and `first` (acts,
  yes, fuse) for point 1 to read. Nothing reads them yet.
- C4 classifier: pending.
- C5 one When: pending.
- C6 page sends raw text: pending.
