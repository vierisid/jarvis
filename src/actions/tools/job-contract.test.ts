import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { getCronTimezone, setCronTimezone } from '../../lib/cron-scheduler';
import type { FlowTriggerNode } from '../../workflows/db/repos/flow-version';
import { checkJobContract, JobContractError, recheckJobContract, scheduleTimeZone, validateJobContract, type JobContract } from './job-contract';

const NOTIFY = '@jarvispieces/piece-jarvis-notify', TOOL = '@jarvispieces/piece-jarvis-tool', AGENT = '@jarvispieces/piece-jarvis-agent';
const WORKFLOW = '@jarvispieces/piece-jarvis-trigger', GMAIL = '@activepieces/piece-gmail';
let n = 0;
const step = (pieceName: string, actionName: string, input: Record<string, unknown>, next?: FlowTriggerNode): FlowTriggerNode =>
  ({ name: `step_${++n}`, type: 'PIECE', settings: { pieceName, actionName, input }, ...(next ? { nextAction: next } : {}) });
const notify = (channels: unknown, next?: FlowTriggerNode) => step(NOTIFY, 'notify', { message: 'Weekly summary', channels }, next);
const send = (receiver: unknown, next?: FlowTriggerNode) => step(GMAIL, 'send_email', { receiver, subject: 'Invoices', body: 'Hi' }, next);
const draft = (receiver: unknown, next?: FlowTriggerNode) => step(GMAIL, 'gmail_create_draft', { receiver, subject: 'Invoices', body: 'Hi' }, next);
const tool = (toolName: unknown, params: unknown = {}, next?: FlowTriggerNode) => step(TOOL, 'invoke', { toolName, params }, next);
const agent = (next?: FlowTriggerNode) => step(AGENT, 'delegate', { goal: 'Find the overdue invoices', role: 'researcher' }, next);
const schedule = (cron: string, next?: FlowTriggerNode): FlowTriggerNode =>
  ({ name: 'trigger', type: 'PIECE_TRIGGER', settings: { pieceName: 'schedule', input: { cron_expression: cron } }, ...(next ? { nextAction: next } : {}) });
const manual = (next?: FlowTriggerNode): FlowTriggerNode => ({ name: 'trigger', type: 'EMPTY', ...(next ? { nextAction: next } : {}) });
const pieceTrigger = (pieceName: string, triggerName: string, next?: FlowTriggerNode): FlowTriggerNode =>
  ({ name: 'trigger', type: 'PIECE_TRIGGER', settings: { pieceName, triggerName, input: {} }, ...(next ? { nextAction: next } : {}) });
const check = (trigger: FlowTriggerNode, contract: JobContract) => checkJobContract(trigger, validateJobContract(contract));
const refuse = (value: unknown) => {
  try { validateJobContract(value); return null; } catch (e) { expect(e).toBeInstanceOf(JobContractError); return (e as Error).message; }
};

/** Every Monday at 09:00 Rome time: draft the invoice reminder to ana@example.com and tell me on the dashboard; never send email. */
const CONTRACT: JobContract = {
  trigger: { kind: 'schedule', cron: '0 9 * * 1', timezone: 'Europe/Rome' },
  outputs: [{ piece: 'gmail', action: 'gmail_create_draft', target: { receiver: ['ana@example.com'] } }, { notify: { channels: ['dashboard'] } }],
  recipients: ['ana@example.com', 'dashboard'],
  forbidden: { effects: ['send_email', 'delete_data'] },
  review: ['The reminder is polite and names the overdue invoices.'],
};
const good = () => schedule('0 9 * * 1', draft(['ana@example.com'], notify(['dashboard'])));

// Schedules run in Jarvis's configured time zone; the contract above is set in Rome.
let previousZone: string | null = null;
beforeAll(() => { previousZone = getCronTimezone(); setCronTimezone('Europe/Rome'); });
afterAll(() => setCronTimezone(previousZone));

describe('validating a contract', () => {
  test('a stated contract is kept, normalized and copied', () => {
    const given = structuredClone(CONTRACT);
    given.trigger!.cron = '  0  9 * *   1 ';
    const contract = validateJobContract(given);
    expect(contract.trigger).toEqual({ kind: 'schedule', cron: '0 9 * * 1', timezone: 'Europe/Rome' });
    given.recipients!.push('mallory@example.com');
    expect(contract.recipients).toEqual(['ana@example.com', 'dashboard']);
    expect(validateJobContract({ trigger: { kind: 'piece', piece: 'gmail', trigger: 'gmail_new_email_received' } }).trigger)
      .toEqual({ kind: 'piece', piece: 'gmail', trigger: 'gmail_new_email_received' });
    expect(validateJobContract({ trigger: { kind: 'schedule', cron: '0 9 * * 1', every: 'week' } }).trigger)
      .toEqual({ kind: 'schedule', cron: '0 9 * * 1', every: 'week' });
  });

  test('a contract that cannot be read is refused before anything is composed', () => {
    expect(refuse({})).toBe('Invalid job contract: it states nothing');
    expect(refuse({ trigger: { kind: 'schedule', cron: '0 9 * *' } })).toContain('5 fields');
    expect(refuse({ trigger: { kind: 'manual', cron: '0 9 * * 1' } })).toContain('only a schedule trigger');
    expect(refuse({ trigger: { kind: 'webhook', every: 'day' } })).toContain('only a schedule trigger has a cron, cadence or timezone');
    expect(refuse({ trigger: { kind: 'schedule', every: 'fortnight' } })).toContain('trigger.every must be hour, day, week or month');
    expect(refuse({ trigger: { kind: 'hourly' } })).toContain('trigger.kind');
    expect(refuse({ trigger: { kind: 'piece' } })).toContain('must name its piece');
    expect(refuse({ trigger: { kind: 'event', piece: 'gmail' } })).toContain('only a piece trigger names a piece');
    expect(refuse({ trigger: { kind: 'schedule', timezone: 'Mars/Olympus' } })).toContain('not a known time zone');
    expect(refuse({ forbidden: { effects: ['send_fax'] } })).toContain('unknown effect send_fax');
    expect(refuse({ sources: [{ notify: { channels: ['dashboard'] } }] })).toContain('cannot be a notification');
    expect(refuse({ outputs: [{ notify: { channels: ['auto'] } }] })).toContain('auto is decided at run time');
    expect(refuse({ outputs: [{ piece: 'jarvis-notify', target: { channels: ['dashboard'] } }] })).toContain('state it as {notify: {channels}}');
    expect(refuse({ outputs: [{ piece: 'gmail', target: { receiver: '{{x}}' } }], frequency: 'weekly' })).toContain('unknown field frequency');
    expect(refuse({ recipients: Array.from({ length: 21 }, (_, i) => `r${i}`) })).toContain('1 to 20');
  });

  test('a contract no graph can keep is refused, naming why', () => {
    const unmet = (value: unknown) => expect(refuse(value)).toStartWith('Job contract cannot be met: ');
    expect(refuse({ outputs: [{ tool: 'write_file' }], forbidden: { tools: ['write_file'] } }))
      .toBe('Job contract cannot be met: it both requires and forbids the tool write_file');
    expect(refuse({ outputs: [{ notify: { channels: ['telegram'] } }], recipients: ['dashboard'] })).toContain('which recipients do not allow');
    expect(refuse({ outputs: [{ piece: 'gmail', action: 'send_email' }], forbidden: { effects: ['send_email'] } }))
      .toBe('Job contract cannot be met: it requires gmail send_email, which would send email, and forbids send_email');
    expect(refuse({ outputs: [{ notify: { channels: ['dashboard'] } }], forbidden: { effects: ['send_message'] } })).toContain('which would send message');
    // A required step whose effects are decided when it runs cannot keep what the job forbids.
    expect(refuse({ outputs: [{ piece: 'sendgrid', action: 'send_email' }], forbidden: { effects: ['delete_data'] } }))
      .toBe('Job contract cannot be met: it requires sendgrid send_email, whose effects are decided when it runs, and forbids delete_data');
    expect(refuse({ outputs: [{ tool: 'run_skill', params: { name: 'Send invoices' } }], forbidden: { tools: ['write_file'] } }))
      .toContain('it requires the run_skill tool, whose effects are decided when it runs, and forbids tool write_file');
    expect(refuse({ outputs: [{ piece: 'jarvis-agent', action: 'delegate' }], forbidden: { agents: true } }))
      .toBe('Job contract cannot be met: it both requires and forbids an agent');
    // An output addressed outside the recipients, a source that does not read, and a send that cannot name its recipient.
    expect(refuse({ outputs: [{ piece: 'gmail', action: 'gmail_create_draft', target: { receiver: 'bob@example.com' } }], recipients: ['ana@example.com'] }))
      .toBe('Job contract cannot be met: it requires gmail gmail_create_draft addressed to bob@example.com, which recipients do not allow');
    unmet({ outputs: [{ piece: 'gmail', action: 'gmail_create_draft', target: { receiver: 'bob@example.com' } }], forbidden: { channels: ['bob@example.com'] } });
    expect(refuse({ sources: [{ tool: 'write_file' }] })).toBe('Job contract cannot be met: it requires reading from the write_file tool, which does not read');
    expect(refuse({ outputs: [{ piece: 'gmail', action: 'gmail_send_draft' }], recipients: ['ana@example.com'] }))
      .toBe('Job contract cannot be met: it requires gmail gmail_send_draft, which does not state who receives it, and limits recipients');
    expect(refuse({ trigger: { kind: 'schedule', cron: '0 9 * * *', every: 'week' } })).toBe('Job contract cannot be met: its cron "0 9 * * *" does not run once every week');
    // Every schedule runs in Jarvis's time zone, so a job set in another one would run at the wrong hour.
    expect(scheduleTimeZone()).toBe('Europe/Rome');
    expect(refuse({ trigger: { kind: 'schedule', cron: '0 9 * * 1', timezone: 'America/New_York' } }))
      .toBe("Job contract cannot be met: schedules run in Europe/Rome, Jarvis's time zone; the job asks for America/New_York");
  });

  test('a contract some graph can keep is accepted', () => {
    // The trigger may read the feed, and a piece acting only through its own service cannot use a Jarvis tool.
    expect(refuse({ sources: [{ piece: 'rss' }], forbidden: { effects: ['send_email'] } })).toBeNull();
    expect(refuse({ outputs: [{ piece: 'sendgrid', action: 'send_email' }], forbidden: { tools: ['write_file'] } })).toBeNull();
    expect(refuse({ outputs: [{ piece: 'gmail', action: 'gmail_send_email' }], recipients: ['ana@example.com'] })).toBeNull();
  });
});

describe('checking a graph against the contract', () => {
  test('a graph that keeps the contract passes, and says what it proved and what a person must confirm', () => {
    const { violations, report } = check(good(), CONTRACT);
    expect(violations).toEqual([]);
    expect(report.verified).toEqual([
      'starts with a schedule on "0 9 * * 1"; schedules run in Europe/Rome, as the job asks',
      'produces gmail gmail_create_draft',
      'produces a notification to dashboard',
      'nothing beyond the requested outputs is sent or addressed',
      'reaches only ana@example.com, dashboard',
      'does nothing the job forbids (send_email, delete_data)',
    ]);
    expect(report.review).toEqual(['The reminder is polite and names the overdue invoices.']);
  });

  test('a structurally valid graph with the wrong destination is rejected', () => {
    const telegram = notify(['telegram']);
    expect(check(schedule('0 9 * * 1', draft(['ana@example.com'], telegram)), CONTRACT).violations).toEqual([
      `job contract: no notification goes to dashboard; step "${telegram.name}" notifies telegram`,
      `job contract: step "${telegram.name}" notifies telegram, which the job did not ask for`,
      `job contract: step "${telegram.name}" sends to telegram, which the job does not allow`,
    ]);
    // Each requested channel must be reached.
    const dashboardOnly = notify(['dashboard']);
    expect(check(manual(dashboardOnly), { outputs: [{ notify: { channels: ['dashboard', 'telegram'] } }] }).violations)
      .toEqual([`job contract: no notification goes to telegram; step "${dashboardOnly.name}" notifies dashboard`]);
    // A notification to the requested channel and one more is an unwanted send to that one.
    expect(check(manual(notify(['dashboard', 'telegram'])), { outputs: [{ notify: { channels: ['dashboard'] } }] }).violations)
      .toEqual([`job contract: step "step_${n}" notifies telegram, which the job did not ask for`]);
    // A draft to the wrong person misses the output's target and addresses someone the job does not allow.
    const toBob = draft(['bob@example.com']);
    expect(check(schedule('0 9 * * 1', toBob), { ...CONTRACT, outputs: [CONTRACT.outputs![0]!] }).violations).toEqual([
      `job contract: step "${toBob.name}" has receiver bob@example.com; the job asks for ana@example.com`,
      `job contract: step "${toBob.name}" addresses bob@example.com, which the job does not allow`,
    ]);
    const sendContract: JobContract = { outputs: [{ piece: 'gmail', action: 'send_email' }], recipients: ['ana@example.com'] };
    expect(check(manual(send(['bob@example.com'])), sendContract).violations)
      .toEqual([`job contract: step "step_${n}" sends to bob@example.com, which the job does not allow`]);
    expect(check(manual(step(GMAIL, 'send_email', { receiver: ['ana@example.com'], cc: ['bob@example.com'], subject: 's', body: 'b' })), sendContract).violations)
      .toEqual([`job contract: step "step_${n}" sends to bob@example.com, which the job does not allow`]);
  });

  test('a write that addresses people reaches them: calendar invitations and shares are checked like sends', () => {
    const contract: JobContract = { outputs: [{ notify: { channels: ['dashboard'] } }], recipients: ['dashboard', 'ana@example.com'] };
    const invite = step('@activepieces/piece-google-calendar', 'google_calendar_create_event',
      { title: 'Sync', attendees: ['bob@example.com'], send_notifications: true }, notify(['dashboard']));
    const { violations, report } = check(manual(invite), contract);
    expect(violations).toEqual([
      `job contract: step "${invite.name}" addresses bob@example.com, which the job did not ask for`,
      `job contract: step "${invite.name}" addresses bob@example.com, which the job does not allow`,
    ]);
    expect(report.verified).not.toContain('reaches only dashboard, ana@example.com');
    const share = step('@activepieces/piece-google-drive', 'drive_share_file', { file_id: 'f1', user_email: 'bob@example.com', role: 'reader' });
    expect(check(manual(share), { recipients: ['ana@example.com'] }).violations)
      .toEqual([`job contract: step "${share.name}" addresses bob@example.com, which the job does not allow`]);
    // A write that addresses no one reaches no one.
    const ownCalendar = step('@activepieces/piece-google-calendar', 'google_calendar_create_event', { title: 'Focus' });
    expect(check(manual(ownCalendar), { recipients: ['dashboard'] }).report.verified).toEqual(['reaches only dashboard']);
  });

  test('an unwanted send is rejected, even hidden in a router branch or a loop', () => {
    const extra = send(['ana@example.com']);
    expect(check(schedule('0 9 * * 1', draft(['ana@example.com'], notify(['dashboard'], extra))), CONTRACT).violations).toEqual([
      `job contract: step "${extra.name}" sends a message the job did not ask for`,
      `job contract: step "${extra.name}" would send email, which the job forbids`]);
    const hidden = send(['ana@example.com']);
    const branch = schedule('0 9 * * 1', draft(['ana@example.com'], notify(['dashboard'])));
    (branch.nextAction as any).nextAction.nextAction = { name: 'route', type: 'ROUTER', settings: { branches: [] }, children: [hidden, null] };
    expect(check(branch, CONTRACT).violations).toContain(`job contract: step "${hidden.name}" would send email, which the job forbids`);
    const looped = send(['ana@example.com']);
    const loop = schedule('0 9 * * 1', draft(['ana@example.com'], notify(['dashboard'])));
    (loop.nextAction as any).nextAction.nextAction = { name: 'each', type: 'LOOP_ON_ITEMS', settings: { items: '{{trigger.rows}}' }, firstLoopAction: looped };
    expect(check(loop, CONTRACT).violations).toContain(`job contract: step "${looped.name}" sends a message the job did not ask for`);
    // A notification nobody asked for is a send too, and so is a second draft to someone else.
    const unasked = notify(['dashboard']);
    expect(check(manual(draft(['ana@example.com'], unasked)), { outputs: [{ piece: 'gmail', action: 'gmail_create_draft' }] }).violations)
      .toEqual([`job contract: step "${unasked.name}" sends a notification the job did not ask for`]);
    const second = draft(['bob@example.com']);
    expect(check(manual(draft(['ana@example.com'], second)), { outputs: [CONTRACT.outputs![0]!] }).violations)
      .toEqual([`job contract: step "${second.name}" addresses bob@example.com, which the job did not ask for`]);
  });

  test('a destination the job constrains cannot be missing or decided at run time', () => {
    const later = draft('{{trigger.payload.email}}', notify(['dashboard']));
    expect(check(schedule('0 9 * * 1', later), CONTRACT).violations).toEqual([
      `job contract: step "${later.name}" decides its receiver at run time ({{trigger.payload.email}}); the job needs ana@example.com`,
      `job contract: step "${later.name}" decides its receiver at run time ({{trigger.payload.email}}); the job needs it stated`,
    ]);
    expect(check(manual(send('{{trigger.payload.email}}')), { recipients: ['ana@example.com'] }).violations)
      .toEqual([expect.stringMatching(/decides its receiver at run time \(\{\{trigger\.payload\.email\}\}\); the job needs it stated$/)]);
    for (const channels of [[], ['auto']]) {
      const connected = notify(channels);
      expect(check(schedule('0 9 * * 1', draft(['ana@example.com'], connected)), CONTRACT).violations)
        .toContain(`job contract: step "${connected.name}" decides its channels at run time (the connected channels); the job needs it stated`);
      // Notifications are outputs by channel, so outputs alone are enough to need them stated.
      expect(check(manual(connected), { outputs: [{ notify: { channels: ['dashboard'] } }] }).violations)
        .toContain(`job contract: step "${connected.name}" decides its channels at run time (the connected channels); the job needs it stated`);
    }
    const noReceiver = step(GMAIL, 'gmail_send_email', { subject: 'x', body: 'y' });
    expect(check(manual(noReceiver), { outputs: [{ piece: 'gmail', action: 'gmail_send_email' }], recipients: ['ana@example.com'] }).violations)
      .toEqual([`job contract: step "${noReceiver.name}" sends without stating who receives it; the job needs it stated`]);
    expect(check(manual(tool('{{trigger.payload.tool}}')), { recipients: ['dashboard'] }).violations)
      .toEqual([`job contract: step "step_${n}" chooses its tool at run time; the job needs it stated`]);
  });

  test('a destination the job does not constrain is not checked, and not claimed', () => {
    // Replying to whoever wrote: the job names the action, not the person.
    const { violations, report } = check(manual(send('{{trigger.payload.email}}')), { outputs: [{ piece: 'gmail', action: 'send_email' }] });
    expect(violations).toEqual([]);
    expect(report.verified).toEqual(['produces gmail send_email', 'nothing beyond the requested outputs is sent or addressed']);
  });

  test('values compare the same way on both sides: a single value is a list of one, and numbers match their text', () => {
    expect(check(manual(draft(['ana@example.com'])), { outputs: [{ piece: 'gmail', action: 'gmail_create_draft', target: { receiver: 'ana@example.com' } }] }).violations)
      .toEqual([]);
    const chat = step('@activepieces/piece-telegram-bot', 'send_text_message', { chat_id: 12345, message: 'Hi' });
    expect(check(manual(chat), { outputs: [{ piece: 'telegram-bot', action: 'send_text_message', target: { chat_id: '12345' } }] }).violations).toEqual([]);
  });

  test('the trigger, its schedule and its cadence are what the job states', () => {
    expect(check(manual(draft(['ana@example.com'], notify(['dashboard']))), CONTRACT).violations)
      .toContain('job contract: the flow starts with a manual trigger; the job asks for a schedule');
    expect(check(schedule('0 8 * * 1', draft(['ana@example.com'], notify(['dashboard']))), CONTRACT).violations)
      .toContain('job contract: the schedule is "0 8 * * 1"; the job asks for "0 9 * * 1"');
    // The trigger manager also reads cronExpression.
    const camel: FlowTriggerNode = { name: 'trigger', type: 'PIECE_TRIGGER', settings: { pieceName: 'schedule', input: { cronExpression: '0 9 * * 1' } } };
    expect(check(camel, { trigger: { kind: 'schedule', cron: '0 9 * * 1' } }).violations).toEqual([]);
    // "Weekly" is a cadence, kept without inventing a day or an hour.
    const weekly: JobContract = { trigger: { kind: 'schedule', every: 'week' } };
    expect(check(schedule('30 7 * * 5'), weekly).report.verified).toEqual(['starts with a schedule, once every week']);
    expect(check(schedule('0 9 * * *'), weekly).violations).toEqual(['job contract: the schedule "0 9 * * *" runs once every day; the job asks for once every week']);
    expect(check(schedule('*/15 * * * *'), { trigger: { kind: 'schedule', every: 'hour' } }).violations)
      .toEqual(['job contract: the schedule "*/15 * * * *" is not an hourly, daily, weekly or monthly schedule; the job asks for once every hour']);
    const event: FlowTriggerNode = { name: 'trigger', type: 'PIECE_TRIGGER', settings: { pieceName: WORKFLOW, triggerName: 'on_event', input: { eventType: 'goal.completed' } } };
    expect(check(event, { trigger: { kind: 'event', eventType: 'commitment.due' } }).violations)
      .toEqual(['job contract: the flow listens for goal.completed; the job asks for commitment.due']);
    const onMail: JobContract = { trigger: { kind: 'piece', piece: 'gmail', trigger: 'gmail_new_email_received' } };
    expect(check(pieceTrigger(GMAIL, 'gmail_new_email_received'), onMail).report.verified)
      .toEqual(["starts with a piece's own trigger: gmail gmail_new_email_received"]);
    expect(check(pieceTrigger(GMAIL, 'new_labeled_email'), onMail).violations)
      .toEqual(['job contract: the flow starts on @activepieces/piece-gmail new_labeled_email; the job asks for gmail_new_email_received']);
    expect(check(pieceTrigger('@activepieces/piece-slack', 'new-message'), onMail).violations)
      .toEqual(['job contract: the flow starts on @activepieces/piece-slack; the job asks for gmail']);
    expect(check(event, onMail).violations).toEqual(["job contract: the flow starts with a Jarvis event; the job asks for a piece's own trigger"]);
  });

  test('sources must be read, with their stated values, by a step or the trigger', () => {
    const contract: JobContract = { sources: [{ tool: 'read_file', params: { path: '/Users/me/invoices.csv' } }] };
    expect(check(manual(tool('read_file', { path: '/Users/me/invoices.csv' })), contract).violations).toEqual([]);
    // Tool params may arrive as JSON text.
    expect(check(manual(tool('read_file', '{"path":"/Users/me/invoices.csv"}')), contract).violations).toEqual([]);
    expect(check(manual(tool('read_file', { path: '/tmp/other.csv' })), contract).violations)
      .toEqual([`job contract: step "step_${n}" has path /tmp/other.csv; the job asks for /Users/me/invoices.csv`]);
    expect(check(manual(notify(['dashboard'])), contract).violations).toEqual(['job contract: no step reads from the read_file tool']);
    // The trigger reads the piece it watches; a step that only sends does not read.
    expect(check(pieceTrigger(GMAIL, 'gmail_new_email_received'), { sources: [{ piece: 'gmail' }] }).report.verified).toEqual(['reads from gmail']);
    const sends = send(['ana@example.com']);
    expect(check(manual(sends), { sources: [{ piece: 'gmail' }] }).violations)
      .toEqual([`job contract: step "${sends.name}" uses @activepieces/piece-gmail send_email, which does not read; the job reads from gmail`]);
  });

  test('forbidden pieces, actions, tools, channels and agents are refused, the trigger included', () => {
    const forbid = (forbidden: JobContract['forbidden'], graph: FlowTriggerNode) => check(graph, { forbidden }).violations;
    expect(forbid({ pieces: ['gmail'] }, manual(draft(['a@b.c'])))).toEqual([expect.stringMatching(/uses @activepieces\/piece-gmail, which the job forbids$/)]);
    expect(forbid({ pieces: ['gmail'] }, pieceTrigger(GMAIL, 'gmail_new_email_received')))
      .toEqual(['job contract: the flow starts on @activepieces/piece-gmail, which the job forbids']);
    expect(forbid({ actions: ['gmail_create_draft'] }, manual(draft(['a@b.c'])))).toEqual([expect.stringMatching(/runs gmail_create_draft, which the job forbids$/)]);
    expect(forbid({ tools: ['write_file'] }, manual(tool('write_file')))).toEqual([expect.stringMatching(/calls write_file, which the job forbids$/)]);
    expect(forbid({ channels: ['telegram'] }, manual(notify(['telegram'])))).toEqual([expect.stringMatching(/reaches telegram, which the job forbids$/)]);
    expect(forbid({ channels: ['telegram'] }, manual(notify('auto'))))
      .toEqual([`job contract: step "step_${n}" decides its channels at run time (the connected channels), so it cannot be shown to avoid telegram`]);
    expect(forbid({ agents: true }, manual(agent()))).toEqual([`job contract: step "step_${n}" delegates to an agent, which the job forbids`]);
  });

  test('a step whose effects are decided when it runs cannot pass anything the job forbids that it could reach', () => {
    const avoid = (what: string, graph: FlowTriggerNode, forbidden: JobContract['forbidden'], parts: string) =>
      expect(check(graph, { forbidden }).violations).toEqual([`job contract: step "step_${n}" ${what}, so it cannot be shown to avoid ${parts}`]);
    const effects = { effects: ['send_email' as const] };
    avoid('uses @acme/piece-unknown blast, which Jarvis does not govern', manual(step('@acme/piece-unknown', 'blast', {})), effects, 'send_email');
    avoid('delegates to an agent, which chooses its own tools when it runs', manual(agent()), effects, 'send_email');
    avoid('starts another workflow, whose steps this check does not see', manual(step(WORKFLOW, 'run_workflow', { flow: 'flow_1' })), effects, 'send_email');
    avoid('calls mystery_tool, which Jarvis cannot bound before it runs', manual(tool('mystery_tool')), { effects: ['delete_data'] }, 'delete_data');
    // A tool outside the bounded set does what the call asks: run_skill replays whatever the skill holds.
    avoid('calls run_skill, which Jarvis cannot bound before it runs', manual(tool('run_skill', { name: 'Send invoices' })), effects, 'send_email');
    // A governed piece's raw API call reaches anything its connection allows.
    avoid('uses @activepieces/piece-gmail custom_api_call, whose effect depends on the call',
      manual(step(GMAIL, 'custom_api_call', { url: '/messages/send', method: 'POST' })), effects, 'send_email');
    // Not only effects: an agent can call a forbidden tool, and another workflow can use a forbidden piece or an agent.
    avoid('delegates to an agent, which chooses its own tools when it runs', manual(agent()), { tools: ['write_file'] }, 'tool write_file');
    avoid('starts another workflow, whose steps this check does not see', manual(step(WORKFLOW, 'run_workflow', { flow: 'flow_1' })),
      { pieces: ['gmail'], agents: true }, 'piece gmail, agents');
    avoid('uses @acme/piece-unknown blast, which Jarvis does not govern', manual(step('@acme/piece-unknown', 'blast', {})), { channels: ['telegram'] }, 'channel telegram');
    // A piece acting only through its own service cannot call a Jarvis tool.
    expect(check(manual(step('@acme/piece-unknown', 'blast', {})), { forbidden: { tools: ['write_file'] } }).report.verified).toEqual(['does nothing the job forbids']);
    expect(check(manual(tool('{{trigger.payload.tool}}')), { forbidden: { effects: ['delete_data'] } }).violations)
      .toEqual([`job contract: step "step_${n}" chooses its tool at run time; the job needs it stated`]);
    expect(check(manual(agent()), { forbidden: { effects: ['spawn_agent'] } }).violations)
      .toEqual([`job contract: step "step_${n}" would spawn agent, which the job forbids`]);
    // Reading, asking and bounded tools are known: a contract that forbids sends accepts them.
    expect(check(manual(step('@jarvispieces/piece-jarvis-ask', 'ask', { prompt: 'Summarize' }, tool('read_file', { path: '/Users/me/invoices.csv' }))),
      { forbidden: { effects: ['send_email', 'send_message'] } }).violations).toEqual([]);
  });

  test('without anything forbidden, a step that decides when it runs is left for a person and never verified', () => {
    const { forbidden: _, ...noForbidden } = CONTRACT;
    const graph = schedule('0 9 * * 1', agent(draft(['ana@example.com'], notify(['dashboard']))));
    const agentStep = graph.nextAction!.name;
    const { violations, report } = check(graph, noForbidden);
    expect(violations).toEqual([]);
    expect(report.verified).not.toContain('nothing beyond the requested outputs is sent or addressed');
    expect(report.verified).not.toContain('reaches only ana@example.com, dashboard');
    expect(report.review).toEqual(['The reminder is polite and names the overdue invoices.',
      `confirm step "${agentStep}" sends nothing the job did not ask for and reaches only ana@example.com, dashboard: it delegates to an agent, which chooses its own tools when it runs`]);
  });

  test('naming an ungoverned piece as a source does not vouch for what else it does', () => {
    const outlook = '@activepieces/piece-microsoft-outlook';
    const read = step(outlook, 'read_email', { folder: 'inbox' }, step(outlook, 'send_email', { to: 'bob@example.com', body: 'Hi' }, notify(['dashboard'])));
    const reply = read.nextAction!;
    const { violations, report } = check(manual(read), { sources: [{ piece: 'microsoft-outlook' }], outputs: [{ notify: { channels: ['dashboard'] } }] });
    expect(violations).toEqual([]);
    expect(report.verified).toEqual(['reads from microsoft-outlook', 'produces a notification to dashboard']);
    expect(report.review).toEqual([
      `confirm step "${read.name}" sends nothing the job did not ask for: it uses ${outlook} read_email, which Jarvis does not govern`,
      `confirm step "${reply.name}" sends nothing the job did not ask for: it uses ${outlook} send_email, which Jarvis does not govern`,
    ]);
    // An output that pins the action and its values names what the step does; who it reaches is still for a person.
    const sendgrid = step('@activepieces/piece-sendgrid', 'send_email', { to: 'ana@example.com', subject: 'Invoices' });
    const pinned = check(manual(sendgrid), { outputs: [{ piece: 'sendgrid', action: 'send_email', target: { to: 'ana@example.com' } }], recipients: ['ana@example.com'] });
    expect(pinned.violations).toEqual([]);
    expect(pinned.report.verified).toEqual(['produces sendgrid send_email', 'nothing beyond the requested outputs is sent or addressed']);
    expect(pinned.report.review).toEqual([`confirm step "${sendgrid.name}" reaches only ana@example.com: it uses @activepieces/piece-sendgrid send_email, which Jarvis does not govern`]);
    // Naming the action without its values does not.
    const unpinned = check(manual(sendgrid), { outputs: [{ piece: 'sendgrid', action: 'send_email' }] });
    expect(unpinned.report.verified).toEqual(['produces sendgrid send_email']);
    expect(unpinned.report.review).toEqual([`confirm step "${sendgrid.name}" sends nothing the job did not ask for: it uses @activepieces/piece-sendgrid send_email, which Jarvis does not govern`]);
  });
});

describe('rechecking a stored contract', () => {
  test('a flow composed without a contract has nothing to recheck', () => {
    expect(recheckJobContract(good(), undefined)).toBeNull();
    expect(recheckJobContract(good(), null)).toBeNull();
  });

  test('an edited graph is checked again, and a contract that no longer validates is reported, not thrown', () => {
    expect(recheckJobContract(good(), CONTRACT)).toMatchObject({ violations: [], review: CONTRACT.review });
    const edited = notify(['telegram']);
    expect(recheckJobContract(schedule('0 9 * * 1', draft(['ana@example.com'], edited)), CONTRACT)!.violations)
      .toContain(`job contract: step "${edited.name}" sends to telegram, which the job does not allow`);
    setCronTimezone('America/New_York');
    try {
      expect(recheckJobContract(good(), CONTRACT)).toEqual({ verified: [], review: [],
        violations: ["Job contract cannot be met: schedules run in America/New_York, Jarvis's time zone; the job asks for Europe/Rome"] });
    } finally { setCronTimezone('Europe/Rome'); }
  });
});
