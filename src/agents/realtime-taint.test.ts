import { test, expect, describe } from 'bun:test';
import { RealtimeTaint, MAX_PENDING_UTTERANCES, echoesAssistant, isBareAffirmation } from './realtime-taint.ts';

describe('RealtimeTaint (#1007)', () => {
  test('a VAD start alone clears nothing', () => {
    const t = new RealtimeTaint();
    t.marks.add('browser_snapshot');
    t.userTurnStarted('u1');
    t.userTurnStarted('u2');
    t.userTurnStarted();
    expect([...t.marks]).toEqual(['browser_snapshot']);
  });

  test('a transcript clears what was read before its utterance began, and nothing after', () => {
    const t = new RealtimeTaint();
    t.marks.add('browser_snapshot');
    t.userTurnStarted('u1');
    t.marks.add('read_email');
    expect(t.userTranscript('u1', 'what did it say')).toBe(true);
    expect([...t.marks]).toEqual(['read_email']);
  });

  test('a source read again after the utterance began stays, though it was read before too', () => {
    const t = new RealtimeTaint();
    t.marks.add('browser_snapshot');
    t.userTurnStarted('u1');
    t.marks.add('browser_snapshot');
    t.userTranscript('u1', 'and the next page');
    expect([...t.marks]).toEqual(['browser_snapshot']);
  });

  test('no words, no item id, or an unseen utterance is no boundary', () => {
    const t = new RealtimeTaint();
    t.marks.add('browser_snapshot');
    t.userTurnStarted('u1');
    expect(t.userTranscript('u1', '')).toBe(false);
    expect(t.userTranscript('u1', ' \n\t')).toBe(false);
    expect(t.userTranscript('u1', '?!...')).toBe(false);
    expect(t.userTranscript(undefined, 'run it')).toBe(false);
    expect(t.userTranscript('u9', 'run it')).toBe(false);
    expect([...t.marks]).toEqual(['browser_snapshot']);
    // Any script counts as words. (Was 'ok', which since the owner's #1156
    // decision is a bare yes and clears nothing while a mark is held.)
    expect(t.userTranscript('u1', '\u6253\u5f00\u8bbe\u7f6e')).toBe(true);
    expect([...t.marks]).toEqual([]);
  });

  test('a repeated start for an utterance keeps where it first began', () => {
    const t = new RealtimeTaint();
    t.userTurnStarted('u1');
    t.marks.add('browser_snapshot');
    t.userTurnStarted('u1');
    t.userTranscript('u1', 'what did it say');
    expect([...t.marks]).toEqual(['browser_snapshot']);
  });

  test('a transcript answers once: a repeat clears nothing read since', () => {
    const t = new RealtimeTaint();
    t.userTurnStarted('u1');
    t.userTranscript('u1', 'read the page');
    t.marks.add('browser_snapshot');
    expect(t.userTranscript('u1', 'read the page')).toBe(false);
    expect([...t.marks]).toEqual(['browser_snapshot']);
  });

  test('pending utterance starts are bounded; a dropped one clears nothing', () => {
    const t = new RealtimeTaint();
    t.marks.add('browser_snapshot');
    t.userTurnStarted('first');
    for (let i = 0; i < MAX_PENDING_UTTERANCES; i++) t.userTurnStarted(`cough-${i}`);
    expect(t.userTranscript('first', 'hello')).toBe(false);
    expect([...t.marks]).toEqual(['browser_snapshot']);
    // The newest are still answered.
    expect(t.userTranscript(`cough-${MAX_PENDING_UTTERANCES - 1}`, 'hello')).toBe(true);
    expect([...t.marks]).toEqual([]);
  });
});

describe('echoesAssistant (#1156)', () => {
  test('words of the assistant\'s speech, in order and adjacent, are an echo', () => {
    expect(echoesAssistant('shall I run it', ['Done. Shall I run it?'])).toBe(true);
    expect(echoesAssistant('Shall I RUN it?!', ['Shall I run it?'])).toBe(true);
    expect(echoesAssistant("it's done", ["Okay, it's done."])).toBe(true);
  });

  test('the user\'s own words are not', () => {
    expect(echoesAssistant('run it', ['Shall I send it?'])).toBe(false);
    expect(echoesAssistant('shall run it', ['Shall I run it?'])).toBe(false);
    expect(echoesAssistant('yes', [])).toBe(false);
    expect(echoesAssistant('...', ['...'])).toBe(false);
  });
});

describe('a bare yes after outside content clears nothing (owner decision, #1156)', () => {
  test('isBareAffirmation matches any reply that only agrees', () => {
    for (const t of [
      'yes', 'Yes.', 'OK!', 'okay', 'sure', 'do it', 'Jarvis, yes', 'hey jarvis go ahead', 'Yes, do it.',
      // #1156 review: the ones a whole-phrase list missed.
      'Yeah, go ahead', 'yeah do it', 'alright do it', 'all right go ahead', 'yes, please do', 'yes do', 'kk',
      'yes yes', 'yes, yes', 'ok ok', 'uh yes', 'um, okay', 'Mm-hmm, yes', 'yes sir', 'just do it', 'do it now',
      "let's do it", 'proceed', 'yes proceed', 'affirmative', 'correct', 'right', 'fine', "that's fine",
      'Sure thing', 'yes thank you', 'ok thanks', 'approve it', 'confirm it', 'O.K.', 'Yes, Jarvis.', 'ok jarvis do it',
      '\uff59\uff45\uff53', "'yes'", 's\u00ec', 'si, procedi', 'va bene', 'certo', 'Yes\u2026', 'yes\u3002',
    ]) {
      expect([t, isBareAffirmation(t)]).toEqual([t, true]);
    }
    for (const t of ['yes, run the build', 'run it', 'okay send the email to bob', 'no', 'yesterday', 'turn right',
      'open settings', 'do it in the terminal', '']) {
      expect([t, isBareAffirmation(t)]).toEqual([t, false]);
    }
  });

  test('with marks, a bare yes is no boundary; the person\'s own words are', () => {
    const t = new RealtimeTaint();
    t.marks.add('browser_snapshot');
    t.userTurnStarted('u1');
    expect(t.userTranscript('u1', 'Yes.')).toBe(false);
    expect([...t.marks]).toEqual(['browser_snapshot']);
    t.userTurnStarted('u2');
    expect(t.userTranscript('u2', 'yes, run the build')).toBe(true);
    expect([...t.marks]).toEqual([]);
  });

  test('a declined intent alone holds too: a spoken yes does not walk around a denied card', () => {
    const t = new RealtimeTaint();
    t.marks.add('declined-intent:send_email');
    t.userTurnStarted('u1');
    expect(t.userTranscript('u1', 'yes')).toBe(false);
    expect([...t.marks]).toEqual(['declined-intent:send_email']);
  });

  test('after a held yes, the person\'s own next words clear, and the held utterance with them', () => {
    const t = new RealtimeTaint();
    t.marks.add('browser_snapshot');
    t.userTurnStarted('u1');
    t.userTurnStarted('u2');
    expect(t.userTranscript('u1', 'yeah go ahead')).toBe(false);
    expect(t.userTranscript('u2', 'run the build')).toBe(true);
    expect([...t.marks]).toEqual([]);
    // u1 was pruned with u2: its transcript, should it come again, clears nothing new.
    t.marks.add('browser_snapshot');
    expect(t.userTranscript('u1', 'run the build')).toBe(false);
    expect([...t.marks]).toEqual(['browser_snapshot']);
  });

  test('with no marks a yes is an ordinary boundary', () => {
    const t = new RealtimeTaint();
    t.userTurnStarted('u1');
    expect(t.userTranscript('u1', 'yes')).toBe(true);
  });
});
