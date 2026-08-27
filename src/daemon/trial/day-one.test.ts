import { describe, expect, test } from 'bun:test';
import {
  AMBIENT_BASE_ALLOWANCE,
  AMBIENT_MAX_ALLOWANCE,
  AMBIENT_MIN_GAP_MS,
  AMBIENT_SETTLE_MS,
  ambientAllowance,
  ambientSubject,
  ambientVerdict,
  composeAgentReturn,
  composeDayOneClose,
  dayOneCloseAt,
  emptyAmbientState,
  emptyFoundation,
  floorOffers,
  nearestKeyResult,
  tidyFinding,
  type AmbientCandidate,
  type DayOneFoundation,
} from './day-one.ts';
import { researchAgentName, READER_AGENT_NAME } from './agent-names.ts';
import { classifyAgentFailure } from '../../agents/task-failure.ts';

const HOUR = 60 * 60_000;

/** The hour Vieri's own walked arcs produce, so the tests are about a real
 *  founder's vault rather than about placeholders. */
function foundation(over: Partial<DayOneFoundation> = {}): DayOneFoundation {
  return {
    ...emptyFoundation(),
    handedOverAt: 1_000_000,
    objective: {
      id: 'obj1',
      title: '40 paying customers by the end of Q3',
      keyResults: [
        { id: 'kr1', title: 'Paying customers 11 to 40' },
        { id: 'kr2', title: 'Booked demos a month 4 to 12' },
      ],
    },
    board: [
      { id: 't1', what: 'Northwind deliverable due 14/09', first: true },
      { id: 't2', what: 'Send the September invoices', first: false },
    ],
    workflows: ['Monthly investor update', 'Weekly KR check'],
    workspace: { destination: '/mnt/c/Users/v/Company organised', says: 'C:\\Users\\v\\Company organised' },
    landed: ['Northwind', 'Bowman & Co', 'Ana'],
    authorityLevel: 5,
    agent: {
      agentId: 'a1', taskId: 'task-1',
      agentName: 'What do the other studio schedulers charge',
      question: 'What do the other studio schedulers charge a seat?',
    },
    eveningHour: 19,
    ...over,
  };
}

/* ────────────────────────── D27, the offer ────────────────────────── */

describe('D27: the finding is always followed by an offer', () => {
  test('there is always at least one, even on the emptiest foundation', () => {
    const offers = floorOffers('anything at all', emptyFoundation());
    expect(offers.length).toBeGreaterThan(0);
    expect(offers.some((o) => o.direction === 'inward')).toBe(true);
  });

  test('the inward one points at a key result when the finding is near one', () => {
    const offers = floorOffers('Their paying customers number is behind where the plan has it', foundation());
    const toward = offers.find((o) => o.kind === 'toward');
    expect(toward).toBeDefined();
    expect(toward!.target!.title).toBe('Paying customers 11 to 40');
  });

  test('and at the objective when it is near nothing in particular', () => {
    const offers = floorOffers('Somebody rebranded their homepage typeface', foundation());
    expect(offers.find((o) => o.kind === 'task')!.target!.title).toBe('40 paying customers by the end of Q3');
  });

  test('the outward one is only offered where it can actually be done', () => {
    // Level 5 and a workspace: offered.
    expect(floorOffers('x', foundation()).some((o) => o.direction === 'outward')).toBe(true);
    // Level 3: the spec puts changing the thing at 5, so it is not offered.
    expect(floorOffers('x', foundation({ authorityLevel: 3 })).some((o) => o.direction === 'outward')).toBe(false);
    // No organised folder: nowhere to write that is not one of their originals.
    expect(floorOffers('x', foundation({ workspace: null })).some((o) => o.direction === 'outward')).toBe(false);
  });

  test('the outward offer names their own spelling of the folder, not the daemon\'s', () => {
    const write = floorOffers('x', foundation()).find((o) => o.kind === 'workspace_write')!;
    expect(write.where).toContain('C:\\Users\\v\\Company organised');
    expect(write.where).not.toContain('/mnt/c');
  });

  test('no offer hands the founder a job, and none of them lands on their own list', () => {
    const all = [
      ...floorOffers('pricing', foundation()),
      ...floorOffers('anything', emptyFoundation()),
    ];
    for (const o of all) {
      const text = `${o.label} ${o.where}`.toLowerCase();
      expect(o.label.startsWith('I will')).toBe(true);
      for (const bad of ['you could', 'you should', 'in the meantime', 'why not', 'consider ', 'make sure']) {
        expect(text).not.toContain(bad);
      }
      expect(text).not.toContain('—');
    }
    // The inward one says out loud whose name it goes under, because the
    // failure mode here is a task board that fills up with the founder's
    // homework.
    const inward = floorOffers('pricing', foundation()).find((o) => o.direction === 'inward')!;
    expect(inward.where.toLowerCase()).toContain('my name');
  });

  test('offer ids are stable within a composition, so an accept can find one', () => {
    const a = floorOffers('pricing', foundation(), 'back');
    const b = floorOffers('pricing', foundation(), 'back');
    expect(a.map((o) => o.id)).toEqual(b.map((o) => o.id));
    expect(new Set(a.map((o) => o.id)).size).toBe(a.length);
  });
});

describe('nearestKeyResult refuses to claim a connection it has not got', () => {
  test('one shared word is a coincidence, not a match', () => {
    expect(nearestKeyResult('a month of good weather', foundation())).toBeNull();
  });
  test('two is enough', () => {
    expect(nearestKeyResult('booked demos are the bottleneck', foundation())?.id).toBe('kr2');
  });
  test('no objective, no claim', () => {
    expect(nearestKeyResult('paying customers', foundation({ objective: null }))).toBeNull();
  });
});

/* ────────────────── D25/D26/D27: the agent coming back ────────────────── */

describe('beat 14 keeps its shape however the agent went', () => {
  test('an answer comes back as a finding plus an offer', () => {
    const r = composeAgentReturn({
      question: 'What do the other studio schedulers charge a seat?',
      agentName: 'What do the other studio schedulers charge',
      taskId: 'task-1',
      response: '**Findings**\n\nThey charge between 180 and 320 a seat, and two of them bundle onboarding.',
      failure: null,
      foundation: foundation(),
    });
    expect(r.answered).toBe(true);
    expect(r.finding).toContain('180 and 320');
    // The markdown scaffolding is gone: this is read out loud and shown small.
    expect(r.finding).not.toContain('**');
    expect(r.offers.length).toBeGreaterThan(0);
    expect(r.failure).toBeNull();
  });

  test('a billing death says it was billing, and STILL arrives with an offer', () => {
    const r = composeAgentReturn({
      question: 'What do the other studio schedulers charge a seat?',
      agentName: 'x', taskId: 'task-1', response: null,
      failure: classifyAgentFailure('429 credit_balance_exhausted'),
      foundation: foundation(),
    });
    expect(r.answered).toBe(false);
    expect(r.failure!.kind).toBe('billing');
    expect(r.says).toContain('billing');
    // The two things that make this survivable: it says the question was not
    // the problem, and it keeps the question.
    expect(r.says).toContain('not the question');
    expect(r.says).toContain('run it again');
    expect(r.offers.length).toBeGreaterThan(0);
  });

  test('an empty answer is a failure of the run, said as one, not passed off as a finding', () => {
    const r = composeAgentReturn({
      question: 'q', agentName: 'x', taskId: 't', response: '   ', failure: null, foundation: foundation(),
    });
    expect(r.answered).toBe(false);
    expect(r.finding).toBeNull();
    expect(r.offers.length).toBeGreaterThan(0);
  });

  test('nothing it says to the founder hands them work', () => {
    for (const failure of [null, classifyAgentFailure('401 invalid_api_key')]) {
      const r = composeAgentReturn({
        question: 'q', agentName: 'x', taskId: 't',
        response: failure ? null : 'A real finding about their pricing.',
        failure, foundation: foundation(),
      });
      const says = r.says.toLowerCase();
      for (const bad of ['you could', 'you should', 'try again yourself', 'in the meantime', 'check your']) {
        expect(says).not.toContain(bad);
      }
      expect(r.says).not.toContain('—');
    }
  });
});

describe('tidyFinding', () => {
  test('drops the markdown a research agent writes in', () => {
    expect(tidyFinding('## Summary\n\n**Bold** and `code`')).toBe('Summary\n\nBold and code');
  });
  test('a report is cut at a sentence, not mid-word', () => {
    const long = `${'A real sentence about their pricing. '.repeat(60)}`;
    const out = tidyFinding(long)!;
    expect(out.length).toBeLessThan(760);
    expect(out.endsWith('…')).toBe(true);
  });
  test('nothing substantial comes back as nothing, rather than as a finding', () => {
    expect(tidyFinding('')).toBeNull();
    expect(tidyFinding('ok')).toBeNull();
  });
});

/* ─────────────────────── D29: the ambient governor ─────────────────────── */

function candidate(over: Partial<AmbientCandidate> = {}): AmbientCandidate {
  return {
    type: 'error',
    title: 'Fix for error in Cursor',
    body: 'Their Northwind deliverable script is throwing on a missing column, and here is the fix.',
    appName: 'Cursor',
    wouldDo: 'apply the fix',
    ...over,
  };
}

const LATER = 1_000_000 + AMBIENT_SETTLE_MS + 1;

describe('D29: the exact bar for speaking', () => {
  test('a real candidate about their own work, with an action, clears it', () => {
    const v = ambientVerdict({
      state: emptyAmbientState(), candidate: candidate(), foundation: foundation(),
      now: LATER, dayOneRunning: true,
    });
    expect(v.speak).toBe(true);
  });

  test('outside day one the governor has no opinion at all', () => {
    const v = ambientVerdict({
      state: emptyAmbientState(), candidate: candidate(), foundation: foundation(),
      now: LATER, dayOneRunning: false,
    });
    expect(v).toEqual({ speak: false, why: 'not_day_one' });
  });

  test('twice is the budget, and the third is refused', () => {
    const state = { ...emptyAmbientState(), spoken: AMBIENT_BASE_ALLOWANCE, lastSpokenAt: null };
    const v = ambientVerdict({ state, candidate: candidate(), foundation: foundation(), now: LATER, dayOneRunning: true });
    expect(v).toEqual({ speak: false, why: 'budget_spent' });
  });

  test('the first ten minutes after the handover are silent, whatever it sees', () => {
    const v = ambientVerdict({
      state: emptyAmbientState(), candidate: candidate(), foundation: foundation(),
      now: 1_000_000 + AMBIENT_SETTLE_MS - 1, dayOneRunning: true,
    });
    expect(v).toEqual({ speak: false, why: 'too_soon_after_handover' });
  });

  test('two interruptions cannot land in the same ten minutes', () => {
    const state = { ...emptyAmbientState(), spoken: 1, lastSpokenAt: LATER };
    expect(ambientVerdict({
      state, candidate: candidate(), foundation: foundation(),
      now: LATER + AMBIENT_MIN_GAP_MS - 1, dayOneRunning: true,
    })).toEqual({ speak: false, why: 'too_soon_after_last' });
    expect(ambientVerdict({
      state, candidate: candidate(), foundation: foundation(),
      now: LATER + AMBIENT_MIN_GAP_MS + 1, dayOneRunning: true,
    }).speak).toBe(true);
  });

  test('a break reminder never speaks, at any hour, on any budget', () => {
    const v = ambientVerdict({
      state: emptyAmbientState(),
      candidate: candidate({ type: 'break', title: 'Time for a break?', body: 'Northwind Q3 customers demos' }),
      foundation: foundation(), now: LATER, dayOneRunning: true,
    });
    expect(v).toEqual({ speak: false, why: 'type_never_speaks' });
  });

  test('a remark about their machine that names nothing of theirs is dropped', () => {
    const v = ambientVerdict({
      state: emptyAmbientState(),
      candidate: candidate({ title: 'Repetitive pattern: Slack and Chrome', body: 'You switched between Slack and Chrome 6 times.', appName: 'Slack' }),
      foundation: foundation(), now: LATER, dayOneRunning: true,
    });
    expect(v).toEqual({ speak: false, why: 'not_about_their_work' });
  });

  test('a candidate with nothing on offer is dropped rather than softened', () => {
    const v = ambientVerdict({
      state: emptyAmbientState(), candidate: candidate({ wouldDo: '' }),
      foundation: foundation(), now: LATER, dayOneRunning: true,
    });
    expect(v).toEqual({ speak: false, why: 'nothing_offered' });
  });

  test('the same subject is never raised twice in a day', () => {
    const first = ambientVerdict({
      state: emptyAmbientState(), candidate: candidate(), foundation: foundation(), now: LATER, dayOneRunning: true,
    });
    expect(first.speak).toBe(true);
    const state = {
      spoken: 1, lastSpokenAt: LATER,
      subjects: new Set([(first as { subject: string }).subject]),
      engagement: 0,
    };
    expect(ambientVerdict({
      state, candidate: candidate(), foundation: foundation(),
      now: LATER + 3 * HOUR, dayOneRunning: true,
    })).toEqual({ speak: false, why: 'already_said' });
  });

  test('a founder using it heavily buys more, up to a ceiling', () => {
    expect(ambientAllowance(emptyAmbientState())).toBe(AMBIENT_BASE_ALLOWANCE);
    expect(ambientAllowance({ ...emptyAmbientState(), engagement: 12 })).toBe(3);
    expect(ambientAllowance({ ...emptyAmbientState(), engagement: 24 })).toBe(4);
    expect(ambientAllowance({ ...emptyAmbientState(), engagement: 500 })).toBe(AMBIENT_MAX_ALLOWANCE);
  });
});

describe('ambientSubject: what counts as "about their work"', () => {
  const f = foundation();
  test('a client the reader landed counts on its own name', () => {
    expect(ambientSubject({ type: 'error', title: 'x', body: 'The Northwind file will not open' }, f))
      .toBe('entity:Northwind');
  });
  test('their quarter counts on two words', () => {
    // Matched against the objective rather than the key result that also
    // contains them, because the objective is checked first and either answer
    // is the same fact: this is about their quarter.
    expect(ambientSubject({ type: 'error', title: 'paying customers', body: 'the paying customers sheet' }, f))
      .toBe('objective:obj1');
  });
  test('a key result nothing else matches is matched on its own', () => {
    expect(ambientSubject({ type: 'error', title: 'booked demos', body: 'the booked demos tracker' }, f))
      .toBe('kr:kr2');
  });
  test('a flow they published counts', () => {
    expect(ambientSubject({ type: 'automation', title: 'x', body: 'the monthly investor update again' }, f))
      .toBe('flow:Monthly investor update');
  });
  test('something with none of their words in it counts as nothing', () => {
    expect(ambientSubject({ type: 'error', title: 'Steam', body: 'shader compilation stalled' }, f)).toBeNull();
  });
  test('an empty foundation matches nothing, so day one starts silent', () => {
    expect(ambientSubject(candidate(), emptyFoundation())).toBeNull();
  });
});

/* ────────────────────── D30: the close of day one ────────────────────── */

describe('D30: a proposal, not a report', () => {
  const lines = [
    { at: 1, topic: 'Rewriting the pricing page', minutes: 95, apps: ['Cursor', 'Chrome'] },
    { at: 2, topic: 'Northwind deliverable', minutes: 40, apps: ['Notion'] },
    { at: 3, topic: 'Reading email', minutes: 3, apps: ['Chrome'] },
    { at: 4, topic: 'Slack', minutes: 22, apps: ['Slack'] },
  ];

  test('it summarises at most three stretches and drops the noise', () => {
    const close = composeDayOneClose({ lines, foundation: foundation(), now: 0 });
    expect(close.summary.length).toBe(3);
    expect(close.summary.join(' ')).not.toContain('Reading email');
    expect(close.thin).toBe(false);
  });

  test('the longest stretch is what it offers to take off them', () => {
    const close = composeDayOneClose({ lines, foundation: foundation(), now: 0 });
    expect(close.summary[0]).toContain('Rewriting the pricing page');
    expect(close.offers.length).toBeGreaterThan(0);
  });

  test('a day it barely saw says so rather than inventing one, and still offers', () => {
    const close = composeDayOneClose({ lines: [], foundation: foundation(), now: 0 });
    expect(close.thin).toBe(true);
    expect(close.summary[0]).toContain('not pretend');
    expect(close.offers.length).toBeGreaterThan(0);
  });

  test('the offers are the part that cannot be empty, on any input', () => {
    for (const f of [foundation(), emptyFoundation(), foundation({ objective: null, workspace: null })]) {
      expect(composeDayOneClose({ lines: [], foundation: f, now: 0 }).offers.length).toBeGreaterThan(0);
      expect(composeDayOneClose({ lines, foundation: f, now: 0 }).offers.length).toBeGreaterThan(0);
    }
  });
});

describe('when day one closes', () => {
  test('at the evening hour the founder themselves chose', () => {
    const handover = new Date(2026, 7, 27, 11, 30).getTime();
    const at = new Date(dayOneCloseAt(foundation(), handover));
    expect(at.getHours()).toBe(19);
    expect(at.getDate()).toBe(27);
  });

  test('nine hours later when they never set one', () => {
    const handover = new Date(2026, 7, 27, 11, 30).getTime();
    expect(dayOneCloseAt(foundation({ eveningHour: null }), handover)).toBe(handover + 9 * HOUR);
  });

  test('a handover that is already past their evening hour still closes the same day', () => {
    const handover = new Date(2026, 7, 27, 21, 0).getTime();
    const at = dayOneCloseAt(foundation(), handover);
    // Not yesterday, and not tomorrow: day one is one day.
    expect(at).toBe(handover + 9 * HOUR);
  });
});

/* ────────────────────────── the two agents ────────────────────────── */

describe('two Research Analysts are told apart', () => {
  test('the finale carries the founder\'s own question', () => {
    expect(researchAgentName('What do the other studio schedulers charge a seat?'))
      .toBe('What do the other studio schedulers charge a seat');
  });
  test('a long question is cut at a word, not mid-word', () => {
    const name = researchAgentName(
      'What do the other studio scheduling platforms charge per seat per month in Europe?',
    );
    expect(name.endsWith('…')).toBe(true);
    expect(name).not.toContain('schedu…');
    expect(name.length).toBeLessThanOrEqual(58);
  });
  test('an empty question still gets a name', () => {
    expect(researchAgentName('   ')).toBe('Your question');
  });
  test('and the reader is named for its job, so the two rows never read the same', () => {
    expect(READER_AGENT_NAME).not.toBe(researchAgentName('anything'));
    expect(READER_AGENT_NAME).not.toContain('Research Analyst');
  });
});
