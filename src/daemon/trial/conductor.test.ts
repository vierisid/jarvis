import { afterEach, describe, expect, test } from 'bun:test';
import { closeDb, initDatabase } from '../../vault/schema.ts';
import { findEntities } from '../../vault/entities.ts';
import { findFacts } from '../../vault/facts.ts';
import { getUserProfile } from '../../vault/user-profile.ts';
import {
  concludeResultMessage,
  CONDUCTOR_TOOLS,
  FUEL_AREA_KEYS,
  TRIAL_OPENING_LINE,
  TRIAL_FILES_SOURCE,
  TRIAL_VAULT_SOURCE,
  buildConductorInstructions,
  createConductorSession,
  executeConductorTool,
  type CapturedFuel,
  type LandedEntity,
  type TrialOpeningHandoff,
} from './conductor.ts';

describe('the opening line (D10, D11)', () => {
  test('introduces Jarvis, claims the co-founder frame, and hands the floor over', () => {
    expect(TRIAL_OPENING_LINE).toContain('Jarvis');
    expect(TRIAL_OPENING_LINE).toContain('co-founder');
    expect(TRIAL_OPENING_LINE.toLowerCase()).toContain('understand the company');
    // It ends by giving them the floor, not by asking permission to begin.
    expect(TRIAL_OPENING_LINE.toLowerCase()).toContain('tell me about it');
  });

  test('it is not a welcome screen read aloud', () => {
    const lower = TRIAL_OPENING_LINE.toLowerCase();
    for (const banned of ['welcome to', 'get started', 'set up', 'onboarding', 'a few questions']) {
      expect(lower).not.toContain(banned);
    }
  });
});

describe('the conductor is a role, not a script (D12)', () => {
  const prompt = buildConductorInstructions({ now: '2026-08-22T09:00:00.000Z' });

  test('it frames Jarvis as their co-founder and names the target feeling (D11)', () => {
    expect(prompt).toContain('co-founder');
    expect(prompt).toContain('I will work with this guy');
  });

  test('it forbids the vocabulary of a wizard', () => {
    // The words are IN the prompt, as prohibitions. What matters is that the
    // prohibition is there at all.
    for (const banned of ['onboarding', 'wizard', 'next question', 'a few quick questions']) {
      expect(prompt).toContain(banned);
    }
    expect(prompt).toContain('Do NOT run an interview');
    expect(prompt).toContain('There is no list of questions here');
  });

  test('it forbids announcing length or progress (D20)', () => {
    expect(prompt).toContain('how long this takes');
    expect(prompt).toContain('There is no progress here');
  });

  test('the five targets are described as things to KNOW, never an agenda', () => {
    for (const area of FUEL_AREA_KEYS) expect(prompt).toContain(area);
    expect(prompt).toContain('These are things to KNOW by the end, not things to ask in order');
  });

  test('every target says which later beat needs it (D13 works backwards)', () => {
    for (const marker of ['vault', 'goals beat', 'workflows beat', 'tasks and calendar beats', 'research agent']) {
      expect(prompt).toContain(marker);
    }
  });

  test('recording is continuous and silent, not batched at the end (D22)', () => {
    expect(prompt).toContain('DURING the conversation and never in a batch at the end');
    expect(prompt).toContain('never mention them');
  });

  test('the exit does not hand the founder to anything (D17)', () => {
    expect(prompt).toContain('does NOT end the conversation');
    expect(prompt).toContain('You keep talking');
  });

  test('the founder name is used when known and absent when not', () => {
    expect(buildConductorInstructions({ founderName: 'Vieri' })).toContain('Their name is Vieri');
    expect(buildConductorInstructions({})).not.toContain('Their name is');
  });
});

describe('the tool surface', () => {
  test('is exactly three tools, nothing that drives a room during the opening', () => {
    expect(CONDUCTOR_TOOLS.map((t) => t.name)).toEqual(['remember', 'capture_fuel', 'conclude_opening']);
  });

  test('capture_fuel accepts only the five fuel areas', () => {
    const tool = CONDUCTOR_TOOLS.find((t) => t.name === 'capture_fuel')!;
    const props = tool.parameters.properties as Record<string, { enum?: string[] }>;
    expect(props.area?.enum).toEqual(FUEL_AREA_KEYS);
  });

  test('remember offers only the entity types the vault will actually accept', () => {
    const tool = CONDUCTOR_TOOLS.find((t) => t.name === 'remember')!;
    const props = tool.parameters.properties as Record<string, any>;
    expect(props.entities.items.properties.type.enum)
      .toEqual(['person', 'project', 'tool', 'place', 'concept', 'event']);
  });
});

describe('remember, the vault fills while they talk (D22)', () => {
  afterEach(() => closeDb());

  function landed(): LandedEntity[][] {
    return pushes;
  }
  let pushes: LandedEntity[][] = [];

  function run(args: Record<string, unknown>) {
    pushes = [];
    const session = createConductorSession(1000);
    const result = executeConductorTool(session, 'remember', args, {
      onEntitiesLanded: (l) => pushes.push(l),
    }, 1000);
    return { session, result };
  }

  test('entities and their facts reach the vault, tagged as the trial\'s', () => {
    initDatabase(':memory:');
    run({
      entities: [
        { name: 'Kestrel', type: 'concept', role: 'company', note: 'their company' },
        { name: 'Ana', type: 'person', role: 'contractor' },
      ],
      facts: [
        { about: 'Ana', detail: 'Does the front end, two days a week.' },
        { about: 'Kestrel', detail: 'Solo founder, no other staff.' },
      ],
    });

    const ana = findEntities({ name: 'Ana' })[0]!;
    expect(ana.type).toBe('person');
    expect(ana.source).toBe(TRIAL_VAULT_SOURCE);
    expect(ana.properties?.role).toBe('contractor');
    expect(findFacts({ subject_id: ana.id })[0]?.object).toBe('Does the front end, two days a week.');
  });

  test('the push happens in the same tick as the write, with the new ones marked', () => {
    initDatabase(':memory:');
    const { result } = run({ entities: [{ name: 'Bowman & Co', type: 'project', role: 'client' }] });
    expect(landed()).toHaveLength(1);
    expect(landed()[0]![0]).toMatchObject({ name: 'Bowman & Co', role: 'client', isNew: true });
    expect(result?.message).toContain('1 new');
  });

  test('a second mention updates rather than duplicating', () => {
    initDatabase(':memory:');
    run({ entities: [{ name: 'Ana', type: 'person' }] });
    run({ entities: [{ name: 'Ana', type: 'person', role: 'contractor' }] });
    expect(findEntities({ name: 'Ana' })).toHaveLength(1);
    expect(findEntities({ name: 'Ana' })[0]?.properties?.role).toBe('contractor');
    expect(landed()[0]![0]!.isNew).toBe(false);
  });

  test('the same fact said twice lands once, the founder is watching this list', () => {
    initDatabase(':memory:');
    run({
      entities: [{ name: 'Bowman', type: 'project' }],
      facts: [{ about: 'Bowman', detail: 'Renews in October.' }],
    });
    run({ facts: [{ about: 'Bowman', detail: 'renews in october.' }] });
    const bowman = findEntities({ name: 'Bowman' })[0]!;
    expect(findFacts({ subject_id: bowman.id })).toHaveLength(1);
  });

  test('a fact about something never landed still keeps what the founder said', () => {
    initDatabase(':memory:');
    run({ facts: [{ about: 'month three churn', detail: 'Customers leave around month three.' }] });
    const e = findEntities({ name: 'month three churn' })[0];
    expect(e?.type).toBe('concept');
    expect(findFacts({ subject_id: e!.id })).toHaveLength(1);
  });

  test('an entity type the model invented is filed, not dropped', () => {
    initDatabase(':memory:');
    run({ entities: [{ name: 'Kestrel', type: 'company' }] });
    expect(findEntities({ name: 'Kestrel' })[0]?.type).toBe('concept');
  });

  test('nameless junk is ignored without taking the call down', () => {
    initDatabase(':memory:');
    const { result } = run({ entities: [{ name: '  ', type: 'person' }, 'nonsense', null] });
    expect(result?.message).toContain('0 new');
    expect(findEntities({})).toHaveLength(0);
  });
});

describe('capture_fuel, the soft targets (D13)', () => {
  afterEach(() => closeDb());

  test('records into the profile the rest of the product already reads', () => {
    initDatabase(':memory:');
    const session = createConductorSession(1000);
    const captured: CapturedFuel[] = [];
    executeConductorTool(session, 'capture_fuel', {
      area: 'goal',
      summary: 'Forty paying customers by the end of Q3.',
      quote: 'forty by the end of Q3, or we are in trouble',
    }, { onFuelCaptured: (f) => captured.push(f) }, 2000);

    expect(session.coveredFuel.get('goal')?.summary).toBe('Forty paying customers by the end of Q3.');
    expect(captured).toHaveLength(1);
    const fact = getUserProfile()?.interview_facts?.[0];
    expect(fact?.theme).toBe('trial_goal');
    expect(fact?.raw_quote).toBe('forty by the end of Q3, or we are in trouble');
  });

  test('the result tells the model NOTHING about what is still missing', () => {
    // A tool result that reported "3 of 5, still need the open question" would
    // turn the next turn into an agenda item. That is the failure D12 forbids.
    initDatabase(':memory:');
    const session = createConductorSession(1000);
    const r = executeConductorTool(session, 'capture_fuel', { area: 'drowning', summary: 'Invoicing by hand.' }, {}, 2000);
    expect(r?.message).toBe('Noted.');
    for (const area of FUEL_AREA_KEYS) expect(r?.message).not.toContain(area);
    expect(r?.message).not.toMatch(/[0-9]/);
  });

  test('an unknown area is refused rather than silently filed', () => {
    initDatabase(':memory:');
    const session = createConductorSession(1000);
    const r = executeConductorTool(session, 'capture_fuel', { area: 'vibes', summary: 'x' }, {}, 2000);
    expect(r?.message).toStartWith('Error');
    expect(session.coveredFuel.size).toBe(0);
  });

  test('re-capturing an area replaces it instead of stacking duplicates', () => {
    initDatabase(':memory:');
    const session = createConductorSession(1000);
    executeConductorTool(session, 'capture_fuel', { area: 'goal', summary: 'Forty customers.' }, {}, 2000);
    executeConductorTool(session, 'capture_fuel', { area: 'goal', summary: 'Forty paying customers by Q3 end.' }, {}, 3000);
    expect(session.coveredFuel.size).toBe(1);
    expect(session.coveredFuel.get('goal')?.summary).toBe('Forty paying customers by Q3 end.');
  });
});

describe('conclude_opening, the seam (D17)', () => {
  afterEach(() => closeDb());

  test('hands the room beats their fuel and everything landed, once', () => {
    initDatabase(':memory:');
    const session = createConductorSession(1000);
    const handoffs: TrialOpeningHandoff[] = [];
    const deps = { onOpeningComplete: (h: TrialOpeningHandoff) => handoffs.push(h) };

    executeConductorTool(session, 'remember', { entities: [{ name: 'Kestrel', type: 'concept' }] }, deps, 1500);
    executeConductorTool(session, 'capture_fuel', { area: 'company', summary: 'Two-person B2B SaaS.' }, deps, 1600);
    executeConductorTool(session, 'conclude_opening', { understanding: 'Solo founder, one contractor.' }, deps, 2000);

    expect(handoffs).toHaveLength(1);
    expect(handoffs[0]!.understanding).toBe('Solo founder, one contractor.');
    expect(handoffs[0]!.fuel.map((f) => f.area)).toEqual(['company']);
    expect(handoffs[0]!.entities).toHaveLength(1);
    expect(handoffs[0]!.concludedAt).toBe(2000);

    // Called twice by a model that lost track: still one handoff.
    executeConductorTool(session, 'conclude_opening', { understanding: 'again' }, deps, 3000);
    expect(handoffs).toHaveLength(1);
    expect(session.understanding).toBe('Solo founder, one contractor.');
  });

  test('the result keeps the conversation open and tells the model to say nothing', () => {
    initDatabase(':memory:');
    const session = createConductorSession(1000);
    const r = executeConductorTool(session, 'conclude_opening', { understanding: 'x' }, {}, 2000);
    expect(r?.message).toBe(concludeResultMessage(session));
    // It is a marker, not a moment: it must not read as an ending, and it must
    // hand the model straight into the first beat rather than into a pause.
    expect(r!.message).toContain('Say nothing about this');
    expect(r!.message).not.toContain('onboarding');
    expect(r!.message).toContain('propose_goals');
  });

  test('the seam carries the founder\'s own words into the first beat', () => {
    initDatabase(':memory:');
    const session = createConductorSession(1000);
    executeConductorTool(
      session,
      'capture_fuel',
      { area: 'goal', summary: 'Forty paying customers by the end of Q3.' },
      {},
      1500,
    );
    const r = executeConductorTool(session, 'conclude_opening', { understanding: 'x' }, {}, 2000);
    expect(r!.message).toContain('Forty paying customers by the end of Q3.');
  });
});

describe("the reader's findings are told apart from what they said (D42)", () => {
  afterEach(() => closeDb());

  test("the opening's own remember is unchanged: it still stamps trial_conductor", () => {
    initDatabase(':memory:');
    const session = createConductorSession(1000);
    executeConductorTool(session, 'remember', {
      entities: [{ name: 'Ana', type: 'person', role: 'co-founder' }],
      facts: [{ about: 'Ana', detail: 'Does the front end.' }],
    }, {}, 1500);
    const ana = findEntities({ name: 'Ana' })[0]!;
    expect(ana.source).toBe(TRIAL_VAULT_SOURCE);
    expect(findFacts({ subject_id: ana.id })[0]!.source).toBe(TRIAL_VAULT_SOURCE);
  });

  test('a source can be overridden, and then everything it writes carries it', () => {
    initDatabase(':memory:');
    const session = createConductorSession(1000);
    executeConductorTool(session, 'remember', {
      entities: [{ name: 'Bowman & Co', type: 'project', role: 'client' }],
      facts: [{ about: 'Bowman & Co', detail: 'Renews in October.' }],
      // A fact about something never landed as an entity: the implied entity
      // has to carry the override too, or half a reading is filed as speech.
    }, { source: TRIAL_FILES_SOURCE }, 1500);
    executeConductorTool(session, 'remember', {
      facts: [{ about: 'Kestrel', detail: 'Priced at 40 a seat.' }],
    }, { source: TRIAL_FILES_SOURCE }, 1600);

    for (const name of ['Bowman & Co', 'Kestrel']) {
      const e = findEntities({ name })[0]!;
      expect(e.source).toBe(TRIAL_FILES_SOURCE);
      expect(findFacts({ subject_id: e.id })[0]!.source).toBe(TRIAL_FILES_SOURCE);
    }
  });

  test('the two sources coexist, so the debrief can tell them apart', () => {
    initDatabase(':memory:');
    const session = createConductorSession(1000);
    executeConductorTool(session, 'remember', { entities: [{ name: 'Ana', type: 'person' }] }, {}, 1500);
    executeConductorTool(session, 'remember', {
      entities: [{ name: 'Bowman & Co', type: 'project' }],
    }, { source: TRIAL_FILES_SOURCE }, 1600);
    expect(findEntities({ name: 'Ana' })[0]!.source).toBe(TRIAL_VAULT_SOURCE);
    expect(findEntities({ name: 'Bowman & Co' })[0]!.source).toBe(TRIAL_FILES_SOURCE);
  });
});

describe('anything outside the three tools', () => {
  test('is not the conductor\'s to run', () => {
    const session = createConductorSession(1000);
    expect(executeConductorTool(session, 'manage_goals', {}, {}, 1000)).toBeNull();
    expect(executeConductorTool(session, 'open_dashboard_room', { room: 'memory' }, {}, 1000)).toBeNull();
  });
});
