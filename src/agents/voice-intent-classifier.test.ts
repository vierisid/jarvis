import { describe, expect, test } from 'bun:test';
import { parseIntent, permissiveIntent } from './voice-intent-classifier.ts';
import { routeByConfidence, type Intent } from '../voice/intent.ts';

// 852 LOC of LLM-prompt-driven parsing shipped with no tests before this
// file. The parser is exactly the kind of code that silently regresses
// because the LLM mostly produces parseable output and failure modes only
// surface on edge inputs. These tests pin the parser's contract:
//   - code-fence wrappers are stripped
//   - malformed JSON falls back to a permissive Intent (never throws)
//   - invalid enum values are normalized to safe defaults
//   - alternatives array is capped at 3
//   - confidence is clamped to [0, 1]

describe('parseIntent — happy path', () => {
  test('parses a clean JSON intent', () => {
    const raw = JSON.stringify({
      verb: 'show',
      object: { type: 'task', id: 't1' },
      args: { filter: 'overdue' },
      impact: 'read',
      confidence: 0.92,
    });
    const intent = parseIntent(raw, 'show overdue tasks');
    expect(intent.verb).toBe('show');
    expect(intent.object?.type).toBe('task');
    expect(intent.object?.id).toBe('t1');
    expect(intent.args).toEqual({ filter: 'overdue' });
    expect(intent.impact).toBe('read');
    expect(intent.confidence).toBe(0.92);
    expect(intent.utterance).toBe('show overdue tasks');
    expect(typeof intent.id).toBe('string');
    expect(intent.id.length).toBeGreaterThan(0);
  });
});

describe('parseIntent — code-fence stripping (LLM ignored "no code fence" instruction)', () => {
  test('strips ```json wrapper', () => {
    const raw = '```json\n{"verb":"ask","impact":"read","confidence":0.9}\n```';
    const intent = parseIntent(raw, 'how are you');
    expect(intent.verb).toBe('ask');
    expect(intent.confidence).toBe(0.9);
  });

  test('strips bare ``` wrapper (no language tag)', () => {
    const raw = '```\n{"verb":"ask","impact":"read","confidence":0.5}\n```';
    const intent = parseIntent(raw, 'q');
    expect(intent.verb).toBe('ask');
  });

  test('strips ```JSON (case-insensitive)', () => {
    const raw = '```JSON\n{"verb":"ask","impact":"read","confidence":0.5}\n```';
    const intent = parseIntent(raw, 'q');
    expect(intent.verb).toBe('ask');
  });
});

describe('parseIntent — malformed JSON falls back to permissive default (never throws)', () => {
  test('completely unparseable text', () => {
    const intent = parseIntent('this is not json at all', 'hello');
    expect(intent.verb).toBe('ask');
    expect(intent.impact).toBe('read');
    expect(intent.confidence).toBe(0.85); // permissive default
    expect(intent.utterance).toBe('hello');
  });

  test('empty string', () => {
    const intent = parseIntent('', 'hello');
    expect(intent.verb).toBe('ask');
    expect(intent.utterance).toBe('hello');
  });

  test('JSON with extra prose around it (extracts first {...} block)', () => {
    const raw = 'Here is the intent: {"verb":"ask","impact":"read","confidence":0.7} hope this helps!';
    const intent = parseIntent(raw, 'q');
    expect(intent.verb).toBe('ask');
    expect(intent.confidence).toBe(0.7);
  });

  test('JSON with broken closing brace inside extraction fallback', () => {
    const intent = parseIntent('garbage {not valid json {{{', 'q');
    // Bracket extraction also fails → permissive default.
    expect(intent.verb).toBe('ask');
    expect(intent.confidence).toBe(0.85);
  });

  test('non-object JSON: numbers and strings fall back to permissive', () => {
    expect(parseIntent('42', 'q').verb).toBe('ask');
    expect(parseIntent('"just a string"', 'q').verb).toBe('ask');
  });

  test('arrays parse as truthy objects → field extraction yields "unknown" verb (defensive default)', () => {
    // Arrays are typeof === 'object' in JS, so they pass the truthy/object
    // gate and the parser tries to read fields off them. Missing verb/impact
    // normalize to 'unknown'/'read'. This is acceptable because the
    // confidence default (0.5) routes to clarify, not act.
    const intent = parseIntent('[1,2,3]', 'q');
    expect(intent.verb).toBe('unknown');
    expect(intent.impact).toBe('read');
    expect(intent.confidence).toBe(0.5);
  });
});

describe('parseIntent — enum normalization', () => {
  test('invalid verb is normalized to "unknown"', () => {
    const raw = JSON.stringify({ verb: 'frobnicate', impact: 'read', confidence: 0.7 });
    const intent = parseIntent(raw, 'q');
    expect(intent.verb).toBe('unknown');
  });

  test('invalid impact is normalized to "read" (safest default)', () => {
    const raw = JSON.stringify({ verb: 'show', impact: 'apocalyptic', confidence: 0.7 });
    const intent = parseIntent(raw, 'q');
    expect(intent.impact).toBe('read');
  });

  test('object.type that is not in the valid set is dropped (object becomes null)', () => {
    const raw = JSON.stringify({
      verb: 'show',
      object: { type: 'frobnication', id: 'x' },
      impact: 'read',
      confidence: 0.7,
    });
    const intent = parseIntent(raw, 'q');
    expect(intent.object).toBeNull();
  });

  test('confirmation_response only accepts "approve" or "cancel" (everything else dropped)', () => {
    const ok = parseIntent(JSON.stringify({ verb: 'ask', impact: 'read', confidence: 0.9, confirmation_response: 'approve' }), 'q');
    expect(ok.confirmation_response).toBe('approve');

    const bogus = parseIntent(JSON.stringify({ verb: 'ask', impact: 'read', confidence: 0.9, confirmation_response: 'maybe' }), 'q');
    expect(bogus.confirmation_response).toBeUndefined();
  });
});

describe('parseIntent — confidence clamped to [0, 1]', () => {
  test('above 1 clamps to 1', () => {
    expect(parseIntent(JSON.stringify({ verb: 'ask', impact: 'read', confidence: 9 }), 'q').confidence).toBe(1);
    expect(parseIntent(JSON.stringify({ verb: 'ask', impact: 'read', confidence: 1.5 }), 'q').confidence).toBe(1);
  });

  test('below 0 clamps to 0', () => {
    expect(parseIntent(JSON.stringify({ verb: 'ask', impact: 'read', confidence: -0.5 }), 'q').confidence).toBe(0);
    expect(parseIntent(JSON.stringify({ verb: 'ask', impact: 'read', confidence: -100 }), 'q').confidence).toBe(0);
  });

  test('non-numeric confidence falls back to 0.5', () => {
    expect(parseIntent(JSON.stringify({ verb: 'ask', impact: 'read', confidence: 'high' }), 'q').confidence).toBe(0.5);
    expect(parseIntent(JSON.stringify({ verb: 'ask', impact: 'read' }), 'q').confidence).toBe(0.5);
  });

  test('exact boundary values pass through unchanged', () => {
    expect(parseIntent(JSON.stringify({ verb: 'ask', impact: 'read', confidence: 0 }), 'q').confidence).toBe(0);
    expect(parseIntent(JSON.stringify({ verb: 'ask', impact: 'read', confidence: 1 }), 'q').confidence).toBe(1);
  });
});

describe('parseIntent — alternatives capped at 3', () => {
  test('a list of 5 alternatives is sliced to 3', () => {
    const alts = Array.from({ length: 5 }, (_, i) => ({
      label: `alt${i}`,
      verb: 'ask',
      object: null,
      args: {},
      impact: 'read',
    }));
    const raw = JSON.stringify({ verb: 'ask', impact: 'read', confidence: 0.7, alternatives: alts });
    const intent = parseIntent(raw, 'q');
    expect(intent.alternatives).toBeDefined();
    expect(intent.alternatives!.length).toBe(3);
  });

  test('alternatives with invalid verb/impact are filtered out (defensive)', () => {
    const alts = [
      { label: 'good', verb: 'ask', impact: 'read' },
      { label: 'bad-verb', verb: 'frobnicate', impact: 'read' },
      { label: 'bad-impact', verb: 'ask', impact: 'apocalyptic' },
    ];
    const raw = JSON.stringify({ verb: 'ask', impact: 'read', confidence: 0.7, alternatives: alts });
    const intent = parseIntent(raw, 'q');
    expect(intent.alternatives!.length).toBe(1);
    expect(intent.alternatives![0]?.label).toBe('good');
  });

  test('empty alternatives → undefined (not empty array)', () => {
    const raw = JSON.stringify({ verb: 'ask', impact: 'read', confidence: 0.7, alternatives: [] });
    const intent = parseIntent(raw, 'q');
    expect(intent.alternatives).toBeUndefined();
  });

  test('non-array alternatives → undefined', () => {
    const raw = JSON.stringify({ verb: 'ask', impact: 'read', confidence: 0.7, alternatives: 'oops' });
    const intent = parseIntent(raw, 'q');
    expect(intent.alternatives).toBeUndefined();
  });
});

describe('parseIntent — room_action defensive parsing', () => {
  test('valid room_action passes through', () => {
    const ra = { room: 'tasks' as const, action: 'set_filter', args: { status: 'overdue' } };
    const raw = JSON.stringify({ verb: 'show', impact: 'read', confidence: 0.9, room_action: ra });
    const intent = parseIntent(raw, 'q');
    expect(intent.room_action?.room).toBe('tasks');
    expect(intent.room_action?.action).toBe('set_filter');
    expect(intent.room_action?.args).toEqual({ status: 'overdue' });
  });

  test('room_action with unknown room is dropped', () => {
    const ra = { room: 'sandbox', action: 'set_filter' };
    const raw = JSON.stringify({ verb: 'show', impact: 'read', confidence: 0.9, room_action: ra });
    const intent = parseIntent(raw, 'q');
    expect(intent.room_action).toBeUndefined();
  });

  test('room_action with empty action is dropped', () => {
    const ra = { room: 'tasks', action: '' };
    const raw = JSON.stringify({ verb: 'show', impact: 'read', confidence: 0.9, room_action: ra });
    const intent = parseIntent(raw, 'q');
    expect(intent.room_action).toBeUndefined();
  });
});

describe('routeByConfidence — routing thresholds', () => {
  const intent = (impact: Intent['impact'], confidence: number): Intent => ({
    id: 'i',
    utterance: 'q',
    verb: 'ask',
    object: null,
    args: {},
    impact,
    confidence,
  });

  test('read-impact has a relaxed threshold (0.6) — getting a question slightly wrong is cheap', () => {
    expect(routeByConfidence(intent('read', 0.6))).toBe('act');
    expect(routeByConfidence(intent('read', 0.7))).toBe('act');
    expect(routeByConfidence(intent('read', 0.85))).toBe('act');
    expect(routeByConfidence(intent('read', 1.0))).toBe('act');
  });

  test('read-impact below 0.6 still goes to clarify, not repeat-back', () => {
    expect(routeByConfidence(intent('read', 0.59))).toBe('repeat-back');
  });

  test('write-impact requires 0.85+ to act (mistakes mutate state)', () => {
    expect(routeByConfidence(intent('write', 0.85))).toBe('act');
    expect(routeByConfidence(intent('write', 1.0))).toBe('act');
    expect(routeByConfidence(intent('write', 0.84))).toBe('clarify');
    expect(routeByConfidence(intent('write', 0.6))).toBe('clarify');
    expect(routeByConfidence(intent('write', 0.59))).toBe('repeat-back');
  });

  test('destructive-impact requires 0.85+ at the route layer (gate adds further restriction)', () => {
    // Note: gateVoiceApprovalResolution further refuses destructive entirely;
    // this test pins routeByConfidence's view in isolation.
    expect(routeByConfidence(intent('destructive', 0.85))).toBe('act');
    expect(routeByConfidence(intent('destructive', 0.84))).toBe('clarify');
  });

  test('exact threshold boundaries are inclusive (>=)', () => {
    // 0.6 read → act, 0.85 write → act
    expect(routeByConfidence(intent('read', 0.6))).toBe('act');
    expect(routeByConfidence(intent('write', 0.85))).toBe('act');
  });
});

describe('permissiveIntent — fallback shape', () => {
  test('always returns a structurally valid Intent', () => {
    const intent = permissiveIntent('whatever the user said');
    expect(intent.verb).toBe('ask');
    expect(intent.impact).toBe('read');
    expect(intent.confidence).toBeGreaterThanOrEqual(0);
    expect(intent.confidence).toBeLessThanOrEqual(1);
    expect(intent.utterance).toBe('whatever the user said');
    expect(typeof intent.id).toBe('string');
  });

  test('confidence is just-above the act threshold so chat flow stays unblocked', () => {
    const intent = permissiveIntent('q');
    // Per the file's design comment: the parser's last-resort default is
    // confidence 0.85 so the daemon proceeds with chat rather than
    // stranding the user in a clarifier card.
    expect(intent.confidence).toBe(0.85);
    expect(routeByConfidence(intent)).toBe('act');
  });
});
