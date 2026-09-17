/**
 * Seed skills: hand-authored to validate the Skill schema and the run_skill
 * path before the recorder generates them.
 *
 * These reference elements by role+name with an EMPTY sig: a durable sig only
 * exists after a live snapshot, so hand-authored skills rely on the resolver's
 * name/ordinal/path rungs instead. They are web apps, so every step runs on
 * the browser surface (CDP accessibility tree, ARIA roles). Accessible names
 * on real web apps drift (locale, A/B tests, redesigns), so treat these as
 * starting points to be tuned during on-machine validation, or re-recorded
 * by demonstration, which captures real sigs.
 *
 * Steps that reach beyond the app declare their `effect`, so the authority
 * gate names it on the approval card even if the classifier's heuristics
 * were to miss it.
 */

import { upsertSkill, getSkillByName } from '../vault/skills.ts';
import type { SemanticRef } from '../structural/types.ts';
import type { SkillStep } from './types.ts';

/** Build a name-addressed ref (empty sig; resolved by role+name at run time). */
function nameRef(role: string, name: string): SemanticRef {
  return { role, name, path: [], ordinal: 0, sig: '' };
}

type SeedSkill = {
  name: string;
  app: string;
  description: string;
  match: { domains?: string[]; processNames?: string[]; keywords?: string[] };
  params: Array<{ name: string; type: 'string'; description: string; required: boolean }>;
  steps: SkillStep[];
};

const SEEDS: SeedSkill[] = [
  {
    name: 'gmail-compose',
    app: 'Gmail',
    description: 'Compose and send an email in Gmail (web)',
    match: { domains: ['mail.google.com'], keywords: ['email', 'compose', 'gmail', 'send mail'] },
    params: [
      { name: 'to', type: 'string', description: 'Recipient email address', required: true },
      { name: 'subject', type: 'string', description: 'Email subject', required: true },
      { name: 'body', type: 'string', description: 'Email body text', required: true },
    ],
    steps: [
      { action: 'click', ref: nameRef('button', 'Compose'), postcondition: { kind: 'element_present' }, note: 'open the compose window' },
      { action: 'set_value', ref: nameRef('textbox', 'To recipients'), value: '{{to}}' },
      { action: 'set_value', ref: nameRef('textbox', 'Subject'), value: '{{subject}}', postcondition: { kind: 'value_equals', value: '{{subject}}' } },
      { action: 'set_value', ref: nameRef('textbox', 'Message Body'), value: '{{body}}' },
      { action: 'click', ref: nameRef('button', 'Send'), effect: 'send_email', postcondition: { kind: 'element_gone' }, note: 'send closes the compose window' },
    ],
  },
  {
    name: 'gcal-create-event',
    app: 'Google Calendar',
    description: 'Create a calendar event with a title',
    match: { domains: ['calendar.google.com'], keywords: ['calendar', 'event', 'meeting', 'schedule'] },
    params: [
      { name: 'title', type: 'string', description: 'Event title', required: true },
    ],
    steps: [
      { action: 'click', ref: nameRef('button', 'Create'), postcondition: { kind: 'element_present' } },
      { action: 'click', ref: nameRef('menuitem', 'Event') },
      { action: 'set_value', ref: nameRef('textbox', 'Add title'), value: '{{title}}', postcondition: { kind: 'value_equals', value: '{{title}}' } },
      { action: 'click', ref: nameRef('button', 'Save'), effect: 'write_data', postcondition: { kind: 'element_gone' } },
    ],
  },
  {
    name: 'notion-new-page',
    app: 'Notion',
    description: 'Create a new Notion page with a title and body',
    match: { domains: ['notion.so'], processNames: ['notion'], keywords: ['notion', 'new page', 'note'] },
    params: [
      { name: 'title', type: 'string', description: 'Page title', required: true },
      { name: 'body', type: 'string', description: 'First line of body text', required: false },
    ],
    steps: [
      { action: 'click', ref: nameRef('button', 'New page'), postcondition: { kind: 'element_present' } },
      { action: 'set_value', ref: nameRef('textbox', 'Untitled'), value: '{{title}}' },
      { action: 'press_keys', value: 'enter' },
      { action: 'set_value', ref: nameRef('textbox', 'Type to continue'), value: '{{body}}', fallback: 'skip' },
    ],
  },
  {
    name: 'sheets-append-row',
    app: 'Google Sheets',
    description: 'Type a value into the active cell of a Google Sheet',
    match: { domains: ['docs.google.com/spreadsheets'], keywords: ['sheet', 'spreadsheet', 'row', 'cell'] },
    params: [
      { name: 'value', type: 'string', description: 'Value to enter in the active cell', required: true },
    ],
    steps: [
      { action: 'set_value', ref: nameRef('textbox', 'Cell input'), value: '{{value}}' },
      { action: 'press_keys', value: 'enter' },
    ],
  },
  {
    name: 'slack-send-message',
    app: 'Slack',
    description: 'Send a message in the currently open Slack channel/DM',
    match: { domains: ['app.slack.com'], processNames: ['slack'], keywords: ['slack', 'message', 'dm', 'channel'] },
    params: [
      { name: 'text', type: 'string', description: 'Message text to send', required: true },
    ],
    steps: [
      { action: 'set_value', ref: nameRef('textbox', 'Message input'), value: '{{text}}' },
      // The ref on a press_keys step is for verification only: sending
      // clears the composer.
      { action: 'press_keys', value: 'enter', ref: nameRef('textbox', 'Message input'), effect: 'send_message', postcondition: { kind: 'value_equals', value: '' }, note: 'sending clears the composer' },
    ],
  },
];

/**
 * Seed the starter skills. Only fills a name that is absent, so a skill the
 * user recorded under the same name is preserved. A seed row whose integrity
 * check fails is re-written from the shipped content: nothing user-made is
 * lost, because an unsigned or tampered row is never run anyway.
 */
export function seedSkills(): void {
  for (const seed of SEEDS) {
    const existing = getSkillByName(seed.name);
    if (existing && (existing.integrity === 'ok' || existing.provenance !== 'authored')) continue;
    upsertSkill({
      ...seed,
      steps: seed.steps.map((s) => ({ ...s, surface: s.surface ?? 'browser' })),
      provenance: 'authored',
    });
  }
}
