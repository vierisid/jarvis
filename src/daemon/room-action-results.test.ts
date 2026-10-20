/**
 * A room action the daemon announces has to have been carried out (#933).
 * These pin how an answer from a panel settles the wait, and that nothing a
 * client sends can settle it wrongly or leave entries behind.
 */

import { describe, expect, test } from 'bun:test';
import { LATE_ANSWER_LIMIT, RoomActionResults } from './room-action-results.ts';

let n = 0;
const ids = () => `r${++n}`;

describe('RoomActionResults', () => {
  test('the first answer settles the wait, in both directions', async () => {
    const results = new RoomActionResults(ids);
    const yes = results.open(1000);
    const no = results.open(1000);
    results.answer(yes.id, true);
    results.answer(no.id, false);
    expect(await yes.outcome).toBe('accepted');
    expect(await no.outcome).toBe('rejected');
    expect(results.size).toBe(0);
  });

  test('a later answer for a settled id changes nothing', async () => {
    const results = new RoomActionResults(ids);
    const w = results.open(1000);
    results.answer(w.id, false);
    results.answer(w.id, true);
    expect(await w.outcome).toBe('rejected');
  });

  test('no answer resolves no_answer after the timeout and is forgotten', async () => {
    const results = new RoomActionResults(ids);
    const w = results.open(10);
    expect(await w.outcome).toBe('no_answer');
    expect(results.size).toBe(0);
    results.answer(w.id, true); // late: ignored
    expect(results.size).toBe(0);
  });

  test('malformed answers are ignored, not taken as yes or no', async () => {
    const results = new RoomActionResults(ids);
    const w = results.open(20);
    for (const accepted of ['true', 1, null, undefined, {}]) results.answer(w.id, accepted);
    for (const id of [undefined, 42, '', 'unknown']) results.answer(id, true);
    expect(await w.outcome).toBe('no_answer');
  });

  test('with an answerer, only that client settles the wait (#965)', async () => {
    const results = new RoomActionResults(ids);
    const asked = {};
    const w = results.open(1000, asked);
    results.answer(w.id, false, {});
    results.answer(w.id, false, undefined);
    expect(results.size).toBe(1);
    results.answer(w.id, true, asked);
    expect(await w.outcome).toBe('accepted');
  });

  test('abandonAnswerer ends only that client\'s waits (#965)', async () => {
    const results = new RoomActionResults(ids);
    const gone = {};
    const mine = results.open(1000, gone);
    const theirs = results.open(1000, {});
    const panels = results.open(1000);
    results.abandonAnswerer(gone);
    expect(await mine.outcome).toBe('no_answer');
    expect(results.size).toBe(2);
    results.answer(theirs.id, true, undefined);
    results.abandonAnswerer(undefined);
    expect(results.size).toBe(2);
    results.answer(panels.id, true);
    expect(await panels.outcome).toBe('accepted');
  });

  // #1015: a room that has taken an action and is still on it says so.
  test('started changes only what a wait running out means, and only from whoever may answer', async () => {
    const results = new RoomActionResults(ids);
    const asked = {};
    const slow = results.open(10, asked);
    results.started(slow.id, asked);
    expect(results.size).toBe(1);
    expect(await slow.outcome).toBe('started');
    // An answer in time still settles it, started or not.
    const quick = results.open(1000, asked);
    results.started(quick.id, asked);
    results.answer(quick.id, false, asked);
    expect(await quick.outcome).toBe('rejected');
    // Not from another client, not for an id it does not know, not after the end.
    const other = results.open(10, asked);
    results.started(other.id, {});
    results.started('no-such-id', asked);
    results.started(7, asked);
    expect(await other.outcome).toBe('no_answer');
    results.started(slow.id, asked);
    expect(results.size).toBe(0);
    // With no answerer, as for the pebble's panels, anyone may say it.
    const panels = results.open(10);
    results.started(panels.id, {});
    expect(await panels.outcome).toBe('started');
  });

  test('a started wait whose dashboard goes is no answer, not started', async () => {
    // The page that was working on it has gone, and its request with it may
    // have been cut off: nothing says the work goes on.
    const results = new RoomActionResults(ids);
    const gone = {};
    const w = results.open(1000, gone);
    results.started(w.id, gone);
    results.abandonAnswerer(gone);
    expect(await w.outcome).toBe('no_answer');
  });

  // #1034: a late answer used to be dropped, so a started action that then
  // failed stayed recorded as run.
  test('a late answer from the client asked is passed on once, with what the wait reported', async () => {
    const results = new RoomActionResults(ids);
    const asked = {};
    const heard: string[] = [];
    const slow = results.open(10, asked, (answer, reported) => heard.push(`${reported}->${answer}`));
    results.started(slow.id, asked);
    expect(await slow.outcome).toBe('started');
    const silent = results.open(10, asked, (answer, reported) => heard.push(`${reported}->${answer}`));
    expect(await silent.outcome).toBe('no_answer');
    expect(results.lateSize).toBe(2);
    results.answer(slow.id, true, {}); // not the client asked
    results.answer(slow.id, 'yes', asked); // malformed
    expect(heard).toEqual([]);
    results.answer(slow.id, false, asked);
    results.answer(silent.id, false, asked, 'pending');
    results.answer(slow.id, true, asked); // once
    expect(heard).toEqual(['started->rejected', 'no_answer->pending']);
    expect(results.lateSize).toBe(0);
  });

  test('nothing is kept for a late answer without a listener or a named client, or once the client has gone', async () => {
    const results = new RoomActionResults(ids);
    const heard: string[] = [];
    await results.open(5, {}).outcome;
    await results.open(5, undefined, () => heard.push('panels')).outcome;
    expect(results.lateSize).toBe(0);
    const gone = {};
    const w = results.open(5, gone, () => heard.push('gone'));
    expect(await w.outcome).toBe('no_answer');
    expect(results.lateSize).toBe(1);
    results.abandonAnswerer(gone);
    expect(results.lateSize).toBe(0);
    results.answer(w.id, true, gone);
    expect(heard).toEqual([]);
  });

  test('an answer in time is not also heard as late', async () => {
    const results = new RoomActionResults(ids);
    const asked = {};
    const heard: string[] = [];
    const w = results.open(1000, asked, () => heard.push('late'));
    results.answer(w.id, true, asked);
    expect(await w.outcome).toBe('accepted');
    results.answer(w.id, false, asked);
    expect(heard).toEqual([]);
    expect(results.lateSize).toBe(0);
  });

  test('past the limit the oldest wait is forgotten first', async () => {
    const results = new RoomActionResults(ids);
    const asked = {};
    const heard: string[] = [];
    const waits = Array.from({ length: LATE_ANSWER_LIMIT + 1 }, (_, i) => results.open(1, asked, () => heard.push(String(i))));
    await Promise.all(waits.map((w) => w.outcome));
    expect(results.lateSize).toBe(LATE_ANSWER_LIMIT);
    results.answer(waits[0]!.id, true, asked);
    results.answer(waits[1]!.id, true, asked);
    results.answer(waits[LATE_ANSWER_LIMIT]!.id, true, asked);
    expect(heard).toEqual(['1', String(LATE_ANSWER_LIMIT)]);
  });

  // #1025: the answerer asks to go ahead, and is let only while the wait is on.
  test('a claim is granted only to the client asked, only while waiting, and then means the action is under way', async () => {
    const results = new RoomActionResults(ids);
    const asked = {};
    const w = results.open(10, asked);
    expect(results.claim(w.id, {})).toBe(false);
    expect(results.claim(7, asked)).toBe(false);
    expect(results.claim(w.id, asked)).toBe(true);
    expect(await w.outcome).toBe('started');
    expect(results.claim(w.id, asked)).toBe(false);
    // Unclaimed and unanswered stays no_answer; a broadcast has nobody to claim it.
    const silent = results.open(10, asked);
    expect(await silent.outcome).toBe('no_answer');
    expect(results.claim(silent.id, asked)).toBe(false);
    const panels = results.open(10);
    expect(results.claim(panels.id, undefined)).toBe(false);
    expect(await panels.outcome).toBe('no_answer');
  });

  test('a started wait whose client goes before answering is told so, once; an unanswered one is not', async () => {
    const results = new RoomActionResults(ids);
    const gone = {};
    const heard: string[] = [];
    const started = results.open(5, gone, (answer, reported) => heard.push(`${reported}->${answer}`));
    results.started(started.id, gone);
    expect(await started.outcome).toBe('started');
    const silent = results.open(5, gone, (answer, reported) => heard.push(`${reported}->${answer}`));
    expect(await silent.outcome).toBe('no_answer');
    results.abandonAnswerer(gone);
    results.abandonAnswerer(gone);
    expect(heard).toEqual(['started->disconnected']);
    expect(results.lateSize).toBe(0);
  });
});
