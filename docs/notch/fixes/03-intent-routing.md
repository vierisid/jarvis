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
  control word, whether control and open intents rank above an open mail draft, what the classifier may see
  of the screen beyond the app's name, what a sentence that could not be read in time may do.

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

## Status

- C1 corpus: done in "notch: pin what every sentence means today in a corpus, wrong rows marked"
  (src/notch/intents-corpus.test.ts, src/notch/intents-corpus.txt; 242 routing rows, 80 time values, 87 marked
  wrong). Decision 5 rows are marked but cannot flip yet: the corpus sees who takes a sentence, not whether
  it acts at once or shows a line. C2 adds that to the table, and the corpus should print it from then on.
- C2 table: pending.
- C3 precedence, reply rule, control words: pending.
- C4 classifier: pending.
- C5 one When: pending.
- C6 page sends raw text: pending.
