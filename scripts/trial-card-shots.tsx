/**
 * Renders the REAL TrialProposal component to a static page, so the approval
 * card can be photographed at 1280 and at 390 without driving an hour-long
 * voice conversation to get one on screen.
 *
 * The markup is the component's own output (react-dom/server) and the CSS is
 * the file that ships, so what is photographed is what a founder sees.
 *
 *   bun run scripts/trial-card-shots.tsx <out.html>
 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { TrialProposal } from '../ui/src/v2/trial/TrialProposal.tsx';

const UI = new URL('../ui/src', import.meta.url).pathname;
const tokens = readFileSync(`${UI}/styles/tokens.css`, 'utf-8');
const trial = readFileSync(`${UI}/v2/trial/TrialConductor.css`, 'utf-8');

/* The largest thing each beat can actually produce. A toy tree proves
   nothing: the complaint was specifically about a card with real content. */
const GOALS: any = {
  beat: 'goals',
  objective: 'Get to 40 paying studios on the annual plan before the Series A conversation opens in October',
  measure: 'Annual contracts signed, not trials started, and not letters of intent',
  deadline: Date.parse('2026-09-30'),
  deadlineLabel: 'by 30 Sep',
  keyResults: [
    { title: 'Booked demos with studios over twenty seats, every month', measure: 'demos a month', target: '12 a month', today: '4 a month' },
    { title: 'Month three churn on the annual plan', measure: 'percent', target: 'under 4%', today: 'about 9%' },
    { title: 'One repeatable onboarding package, sold at the same price five times', measure: 'sales at list price', target: '5', today: '0' },
    { title: 'Revenue from the two named accounts that renew in October', measure: 'GBP', target: '48,000', today: '19,400' },
  ],
  firstMove: {
    what: 'Rewrite the pricing page around the onboarding package rather than the seat count',
    under: 'Booked demos with studios over twenty seats, every month',
    due: Date.parse('2026-08-28'),
    dueLabel: 'Fri 28 Aug',
  },
};

const TASKS: any = {
  beat: 'tasks',
  tasks: [
    { what: 'File the Q2 VAT return, which was due on Saturday', due: Date.parse('2026-08-22'), dueLabel: 'Sat 22 Aug', late: true, first: false, toward: null, priority: 'critical' },
    { what: 'Send Bowman & Co the revised quote with the onboarding package in it', due: Date.parse('2026-08-26'), dueLabel: 'today', late: false, first: true, toward: 'Booked demos with studios over twenty seats', priority: 'high' },
    { what: 'Rewrite the pricing page around the package', due: Date.parse('2026-08-28'), dueLabel: 'Fri', late: false, first: false, toward: 'Booked demos with studios over twenty seats', priority: 'high' },
    { what: 'Write the launch page for the September release', due: Date.parse('2026-08-27'), dueLabel: 'Thu', late: false, first: false, toward: null, priority: 'normal' },
    { what: 'Chase the two studios that went quiet after the July demo', due: Date.parse('2026-08-31'), dueLabel: 'Mon', late: false, first: false, toward: 'Month three churn on the annual plan', priority: 'normal' },
    { what: 'The investor update you have pushed three weeks running', due: Date.parse('2026-09-01'), dueLabel: 'Tue', late: false, first: false, toward: null, priority: 'high' },
  ],
};

const CALENDAR: any = { beat: 'calendar', hour: 7, minute: 30, eveningHour: 19, because: 'You said you are at your desk by half seven and you stop when the school run happens, so the brief is waiting for you and the review catches you before you go.' };

const WORKFLOW: any = {
  beat: 'workflows',
  name: 'Monday pipeline review',
  runsWhen: 'Mondays at 08:00',
  steps: [
    'Pull every studio that booked a demo in the last fourteen days out of the CRM',
    'Match each one against the notes in your vault and flag the ones with no follow-up since the call',
    'Draft the follow-up message for each of them in your voice, with the onboarding package priced',
    'Put the drafts in front of you in one list, with the two you should send first at the top',
  ],
  never: 'Never send anything to a studio without you reading it first, and never quote a price that is not on the pricing page',
};

const AUTHORITY: any = { beat: 'authority', level: 5, alwaysAsk: ['send_message', 'execute_command'] };

const FILES: any = {
  beat: 'files',
  folder: '/mnt/c/Users/vbalb/Documents/Kestrel',
  says: 'C:\\Users\\vbalb\\Documents\\Kestrel',
  what: '84 files in 12 folders, of which the 40 most recent of 61 would be read; 14 PDF or document files can be seen but not opened',
  sample: [
    'pitch/Kestrel deck v14 - notes.md',
    'money/pricing-2026.md',
    'clients/Bowman & Co/renewal-october.md',
    'product/README.md',
    'notes/2026-08-19 investor call.md',
    'money/runway.csv',
  ],
  willRead: 40,
  total: 84,
};

const WORKSPACE: any = {
  beat: 'workspace',
  kind: 'workspace',
  title: 'Kestrel',
  source: '/mnt/c/Users/vbalb/Documents/Kestrel',
  destination: '/mnt/c/Users/vbalb/Documents/Kestrel (organised by Jarvis)',
  saysSource: 'C:\\Users\\vbalb\\Documents\\Kestrel',
  saysDestination: 'C:\\Users\\vbalb\\Documents\\Kestrel (organised by Jarvis)',
  sections: [
    { name: 'the pitch', about: 'Everything you show someone who might invest', files: ['a', 'b', 'c', 'd'] },
    { name: 'money', about: 'Pricing, runway, the numbers you quote', files: ['a', 'b', 'c', 'd', 'e', 'f'] },
    { name: 'clients', about: 'The studios, one folder each', files: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'] },
    { name: 'the product', about: 'What it does and what is next', files: ['a', 'b', 'c'] },
  ],
};

const EDIT: any = {
  beat: 'workspace',
  kind: 'edit',
  file: 'pitch/Kestrel deck v14 - notes.md',
  change: 'The problem slide says scheduling is hard, which is a category, not a problem. Your own client notes say studios lose a day a week to rescheduling and that is the sentence that should be on it.',
  as: 'Kestrel deck v14 - notes - rewritten.md',
};

const AGENT: any = {
  beat: 'agents',
  question: 'How the three closest competitors price their onboarding, and whether any of them charge for it separately',
  brief: 'Compare the published prices, ignore the enterprise "contact us" tiers, and say whether charging separately for onboarding is normal in this market or whether it would make Kestrel look expensive.',
  agentName: null,
  running: false,
};

const CARDS: [string, any, any][] = [
  ['goals · the largest tree a beat can produce', GOALS, null],
  ['tasks · six, one late, one first', TASKS, null],
  ['calendar · both ends of the day', CALENDAR, null],
  ['workflows · four steps and a never line', WORKFLOW, null],
  ['authority · level 5 with a carve-out', AUTHORITY, null],
  ['files · what it would read', FILES, null],
  ['files · reading, mid-flight', { ...FILES, reading: true, found: 17 }, null],
  ['workspace · the organised copy', WORKSPACE, null],
  ['workspace · one real piece of work', EDIT, null],
  ['agents · what it is being sent to find', AGENT, null],
  ['agents · running', { ...AGENT, running: true, agentName: 'Scout' }, null],
  ['landed · the frame after yes', null, { beat: 'goals', summary: 'Get to 40 paying studios on the annual plan · 4 key results, first move set' }],
];

const body = CARDS.map(([label, proposal, landed]) => `
  <section class="shot">
    <div class="shot-label">${label}</div>
    <div class="shot-stage">
      ${renderToStaticMarkup(React.createElement(TrialProposal as never, { proposal, landed } as never))}
    </div>
  </section>`).join('\n');

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>trial approval cards</title>
<style>${tokens}</style>
<style>${trial}</style>
<style>
  body { margin: 0; background: var(--bg); font-family: var(--sans); }
  .shot { border-bottom: 1px solid var(--rule); }
  .shot-label { font-family: var(--mono); font-size: 10px; letter-spacing: .14em; text-transform: uppercase;
                color: var(--ink3); padding: 14px 20px 0; }
  /* The card is absolutely positioned against the room surface, so the stage
     stands in for that surface at whatever width the window is. */
  .shot-stage { position: relative; height: var(--stage-h, 560px); }
  .shot-stage .tc-prop { animation: none; }
</style>
</head><body>${body}</body></html>`;

const out = process.argv[2] ?? '/tmp/cards.html';
await Bun.write(out, html);
console.log(out);
