import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { setCronTimezone } from '../../lib/cron-scheduler';
import type { FlowTriggerNode } from '../../workflows/db/repos/flow-version';
import { checkJobContract, JobContractError, scheduleTimeZone, validateJobContract, type JobContract } from './job-contract';

const NOTIFY = '@jarvispieces/piece-jarvis-notify', TOOL = '@jarvispieces/piece-jarvis-tool', AGENT = '@jarvispieces/piece-jarvis-agent';
const GMAIL = '@activepieces/piece-gmail';
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
const check = (trigger: FlowTriggerNode, contract: JobContract) => checkJobContract(trigger, validateJobContract(contract));
const last = () => `step_${n}`;

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
beforeAll(() => setCronTimezone('Europe/Rome'));
afterAll(() => setCronTimezone(null));

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
  });

  test('a contract that cannot be read is refused before anything is composed', () => {
    const refuse = (value: unknown) => { try { validateJobContract(value); return null; } catch (e) { expect(e).toBeInstanceOf(JobContractError); return (e as Error).message; } };
    expect(refuse({})).toBe('Invalid job contract: it states nothing');
    expect(refuse({ trigger: { kind: 'schedule', cron: '0 9 * *' } })).toContain('5 fields');
    expect(refuse({ trigger: { kind: 'manual', cron: '0 9 * * 1' } })).toContain('only a schedule trigger');
    expect(refuse({ trigger: { kind: 'hourly' } })).toContain('trigger.kind');
    expect(refuse({ trigger: { kind: 'piece' } })).toContain('must name its piece');
    expect(refuse({ trigger: { kind: 'event', piece: 'gmail' } })).toContain('only a piece trigger names a piece');
    expect(refuse({ trigger: { kind: 'schedule', timezone: 'Mars/Olympus' } })).toContain('not a known time zone');
    expect(refuse({ forbidden: { effects: ['send_fax'] } })).toContain('unknown effect send_fax');
    expect(refuse({ sources: [{ notify: { channels: ['dashboard'] } }] })).toContain('cannot be a notification');
    expect(refuse({ outputs: [{ piece: 'jarvis-notify', target: { channels: ['dashboard'] } }] })).toContain('state it as {notify: {channels}}');
    expect(refuse({ outputs: [{ piece: 'gmail', target: { receiver: '{{x}}' } }], frequency: 'weekly' })).toContain('unknown field frequency');
    expect(refuse({ recipients: Array.from({ length: 21 }, (_, i) => `r${i}`) })).toContain('1 to 20');
  });

  test('a contract that can never be met is refused, naming why', () => {
    const refuse = (value: unknown) => { try { validateJobContract(value); return null; } catch (e) { return (e as Error).message; } };
    expect(refuse({ outputs: [{ tool: 'write_file' }], forbidden: { tools: ['write_file'] } }))
      .toBe('Job contract cannot be met: it both requires and forbids the tool write_file');
    expect(refuse({ outputs: [{ notify: { channels: ['telegram'] } }], recipients: ['dashboard'] })).toContain('which recipients do not allow');
    expect(refuse({ outputs: [{ piece: 'gmail', action: 'send_email' }], forbidden: { effects: ['send_email'] } }))
      .toBe('Job contract cannot be met: it requires gmail send_email, which would send email, and forbids send_email');
    expect(refuse({ outputs: [{ notify: { channels: ['dashboard'] } }], forbidden: { effects: ['send_message'] } })).toContain('which would send message');
    // Every schedule runs in Jarvis's time zone, so a job set in another one would run at the wrong hour.
    expect(scheduleTimeZone()).toBe('Europe/Rome');
    expect(refuse({ trigger: { kind: 'schedule', cron: '0 9 * * 1', timezone: 'America/New_York' } }))
      .toBe("Job contract cannot be met: schedules run in Europe/Rome, Jarvis's time zone; the job asks for America/New_York");
  });
});

describe('checking a graph against the contract', () => {
  test('a graph that keeps the contract passes, and says what it proved and what a person must confirm', () => {
    const { violations, report } = check(good(), CONTRACT);
    expect(violations).toEqual([]);
    expect(report.verified).toEqual([
      'starts with a schedule on "0 9 * * 1" in Europe/Rome',
      'produces gmail gmail_create_draft',
      'produces a notification to dashboard',
      'sends nothing beyond the requested outputs',
      'messages reach only ana@example.com, dashboard',
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
      .toEqual([`job contract: step "${last()}" notifies telegram, which the job did not ask for`]);
    // A draft to the wrong person is caught by the output's target; a send, by the recipients too.
    expect(check(schedule('0 9 * * 1', draft(['bob@example.com'], notify(['dashboard']))), CONTRACT).violations)
      .toEqual([expect.stringMatching(/has receiver bob@example.com; the job asks for ana@example.com$/)]);
    const sendContract: JobContract = { outputs: [{ piece: 'gmail', action: 'send_email' }], recipients: ['ana@example.com'] };
    expect(check(manual(send(['bob@example.com'])), sendContract).violations)
      .toEqual([`job contract: step "${last()}" sends to bob@example.com, which the job does not allow`]);
    expect(check(manual(step(GMAIL, 'send_email', { receiver: ['ana@example.com'], cc: ['bob@example.com'], subject: 's', body: 'b' })), sendContract).violations)
      .toEqual([`job contract: step "${last()}" sends to bob@example.com, which the job does not allow`]);
  });

  test('an unwanted send is rejected, even hidden in a router branch', () => {
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
    // A notification nobody asked for is a send too.
    const unasked = notify(['dashboard']);
    expect(check(manual(draft(['ana@example.com'], unasked)), { outputs: [{ piece: 'gmail', action: 'gmail_create_draft' }] }).violations)
      .toEqual([`job contract: step "${unasked.name}" sends a notification the job did not ask for`]);
  });

  test('a recipient decided at run time, or missing, is a blocker', () => {
    expect(check(schedule('0 9 * * 1', draft('{{trigger.payload.email}}', notify(['dashboard']))), CONTRACT).violations)
      .toEqual([expect.stringMatching(/decides its receiver at run time \(\{\{trigger\.payload\.email\}\}\); the job needs ana@example.com$/)]);
    expect(check(manual(send('{{trigger.payload.email}}')), { outputs: [{ piece: 'gmail', action: 'send_email' }] }).violations)
      .toEqual([expect.stringMatching(/decides its receiver at run time \(\{\{trigger\.payload\.email\}\}\); the job needs it stated$/)]);
    for (const channels of [[], ['auto']]) {
      const connected = notify(channels);
      expect(check(schedule('0 9 * * 1', draft(['ana@example.com'], connected)), CONTRACT).violations)
        .toContain(`job contract: step "${connected.name}" decides its channels at run time (the connected channels); the job needs it stated`);
    }
    const noReceiver = { outputs: [{ piece: 'gmail', action: 'gmail_send_email' }] } as JobContract;
    expect(check(manual(step(GMAIL, 'gmail_send_email', { subject: 'x', body: 'y' })), noReceiver).violations)
      .toEqual([`job contract: step "${last()}" sends without stating who receives it; the job needs it stated`]);
    // A tool chosen at run time is an unresolved binding whenever the job states where messages go or what it forbids.
    expect(check(manual(tool('{{trigger.payload.tool}}')), { recipients: ['dashboard'] }).violations)
      .toEqual([`job contract: step "${last()}" chooses its tool at run time; the job needs it stated`]);
  });

  test('the trigger and its schedule are what the job states', () => {
    expect(check(manual(draft(['ana@example.com'], notify(['dashboard']))), CONTRACT).violations)
      .toContain('job contract: the flow starts with a manual trigger; the job asks for a schedule');
    expect(check(schedule('0 8 * * 1', draft(['ana@example.com'], notify(['dashboard']))), CONTRACT).violations)
      .toContain('job contract: the schedule is "0 8 * * 1"; the job asks for "0 9 * * 1"');
    // The trigger manager also reads cronExpression.
    const camel: FlowTriggerNode = { name: 'trigger', type: 'PIECE_TRIGGER', settings: { pieceName: 'schedule', input: { cronExpression: '0 9 * * 1' } } };
    expect(check(camel, { trigger: { kind: 'schedule', cron: '0 9 * * 1' } }).violations).toEqual([]);
    const event: FlowTriggerNode = { name: 'trigger', type: 'PIECE_TRIGGER', settings: { pieceName: '@jarvispieces/piece-jarvis-trigger', triggerName: 'on_event', input: { eventType: 'goal.completed' } } };
    expect(check(event, { trigger: { kind: 'event', eventType: 'commitment.due' } }).violations)
      .toEqual(['job contract: the flow listens for goal.completed; the job asks for commitment.due']);
    const mail = (pieceName: string, triggerName: string): FlowTriggerNode => ({ name: 'trigger', type: 'PIECE_TRIGGER', settings: { pieceName, triggerName, input: {} } });
    const onMail: JobContract = { trigger: { kind: 'piece', piece: 'gmail', trigger: 'gmail_new_email_received' } };
    expect(check(mail(GMAIL, 'gmail_new_email_received'), onMail).report.verified)
      .toEqual(["starts with a piece's own trigger: gmail gmail_new_email_received"]);
    expect(check(mail(GMAIL, 'new_labeled_email'), onMail).violations)
      .toEqual(['job contract: the flow starts on @activepieces/piece-gmail new_labeled_email; the job asks for gmail_new_email_received']);
    expect(check(mail('@activepieces/piece-slack', 'new-message'), onMail).violations)
      .toEqual(['job contract: the flow starts on @activepieces/piece-slack; the job asks for gmail']);
    expect(check(event, onMail).violations).toEqual(["job contract: the flow starts with a Jarvis event; the job asks for a piece's own trigger"]);
  });

  test('sources must be read with their stated values', () => {
    const contract: JobContract = { sources: [{ tool: 'read_file', params: { path: '/Users/me/invoices.csv' } }] };
    expect(check(manual(tool('read_file', { path: '/Users/me/invoices.csv' })), contract).violations).toEqual([]);
    // Tool params may arrive as JSON text.
    expect(check(manual(tool('read_file', '{"path":"/Users/me/invoices.csv"}')), contract).violations).toEqual([]);
    expect(check(manual(tool('read_file', { path: '/tmp/other.csv' })), contract).violations)
      .toEqual([`job contract: step "${last()}" has path /tmp/other.csv; the job asks for /Users/me/invoices.csv`]);
    expect(check(manual(notify(['dashboard'])), contract).violations).toEqual(['job contract: no step reads from the read_file tool']);
  });

  test('forbidden pieces, actions, tools, channels and agents are refused', () => {
    const forbid = (forbidden: JobContract['forbidden'], graph: FlowTriggerNode) => check(graph, { forbidden }).violations;
    expect(forbid({ pieces: ['gmail'] }, manual(draft(['a@b.c'])))).toEqual([expect.stringMatching(/uses @activepieces\/piece-gmail, which the job forbids$/)]);
    expect(forbid({ actions: ['gmail_create_draft'] }, manual(draft(['a@b.c'])))).toEqual([expect.stringMatching(/runs gmail_create_draft, which the job forbids$/)]);
    expect(forbid({ tools: ['write_file'] }, manual(tool('write_file')))).toEqual([expect.stringMatching(/calls write_file, which the job forbids$/)]);
    expect(forbid({ channels: ['telegram'] }, manual(notify(['telegram'])))).toEqual([expect.stringMatching(/sends to telegram, which the job forbids$/)]);
    expect(forbid({ channels: ['telegram'] }, manual(notify('auto'))))
      .toEqual([`job contract: step "${last()}" decides its channels at run time (the connected channels), so it cannot be shown to avoid telegram`]);
    expect(forbid({ agents: true }, manual(agent()))).toEqual([expect.stringMatching(/delegates to an agent, which the job forbids$/)]);
  });

  test('a step whose effect is decided when it runs cannot pass a forbidden effect', () => {
    const forbid = (effects: JobContract['forbidden'] & {}, graph: FlowTriggerNode) => check(graph, { forbidden: effects }).violations;
    const avoid = (what: string, graph: FlowTriggerNode, effects = ['send_email']) =>
      expect(forbid({ effects: effects as any }, graph)).toEqual([`job contract: step "${last()}" ${what}, so it cannot be shown to avoid ${effects.join(', ')}`]);
    avoid('uses @acme/piece-unknown blast, which Jarvis does not govern', manual(step('@acme/piece-unknown', 'blast', {})));
    avoid('delegates to an agent, which chooses its own tools when it runs', manual(agent()));
    avoid('starts another workflow, whose steps this check does not see', manual(step('@jarvispieces/piece-jarvis-trigger', 'run_workflow', { flow: 'flow_1' })));
    avoid('calls mystery_tool, which Jarvis cannot bound before it runs', manual(tool('mystery_tool')), ['delete_data']);
    // A tool outside the bounded set does what the call asks: run_skill replays whatever the skill holds.
    avoid('calls run_skill, which Jarvis cannot bound before it runs', manual(tool('run_skill', { name: 'Send invoices' })));
    expect(forbid({ effects: ['delete_data'] }, manual(tool('{{trigger.payload.tool}}'))))
      .toEqual([`job contract: step "${last()}" chooses its tool at run time; the job needs it stated`]);
    expect(forbid({ effects: ['spawn_agent'] }, manual(agent()))).toEqual([`job contract: step "${last()}" would spawn agent, which the job forbids`]);
    // Reading, asking and bounded tools are known: a contract that forbids sends accepts them.
    expect(forbid({ effects: ['send_email', 'send_message'] }, manual(step('@jarvispieces/piece-jarvis-ask', 'ask', { prompt: 'Summarize' },
      tool('read_file', { path: '/Users/me/invoices.csv' }))))).toEqual([]);
  });

  test('without a forbidden effect, a step that decides at run time is left for a person, never verified', () => {
    const { forbidden: _, ...noForbidden } = CONTRACT;
    const graph = schedule('0 9 * * 1', agent(draft(['ana@example.com'], notify(['dashboard']))));
    const agentStep = graph.nextAction!.name;
    const { violations, report } = check(graph, noForbidden);
    expect(violations).toEqual([]);
    expect(report.verified).not.toContain('sends nothing beyond the requested outputs');
    expect(report.verified).not.toContain('messages reach only ana@example.com, dashboard');
    expect(report.review).toEqual(['The reminder is polite and names the overdue invoices.',
      `confirm step "${agentStep}" sends nothing the job did not ask for and reaches only ana@example.com, dashboard: it delegates to an agent, which chooses its own tools when it runs`]);
    // A step the job names is asked for; who it reaches is still for a person to confirm.
    const rss = manual(step('@activepieces/piece-rss', 'rss_read_feed', { url: 'https://example.com/feed' }, notify(['dashboard'])));
    const named = check(rss, { sources: [{ piece: 'rss' }], outputs: [{ notify: { channels: ['dashboard'] } }], recipients: ['dashboard'] }).report;
    expect(named.verified).toContain('sends nothing beyond the requested outputs');
    expect(named.review).toEqual([`confirm step "${rss.nextAction!.name}" reaches only dashboard: it uses @activepieces/piece-rss rss_read_feed, which Jarvis does not govern`]);
  });
});
