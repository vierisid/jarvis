// Recorded model doubles for editable tasks; never used by a production binding.
import type { ComposedFlow } from '../../actions/tools/workflow-composer';
export const examples = [
  { name: 'Meeting follow-up', prompt: 'After a meeting, use the notes I provide to draft a follow-up and a list of actions for me to review.',
    notes: 'We agreed to ship the prototype on Friday. Alex owns the test plan.', cron: null },
  { name: 'Weekly update', prompt: 'Every Friday, turn the notes I provide into a weekly company update with progress, blockers and next steps.',
    notes: 'For investors: prototype delivered, hiring blocked, next milestone is the pilot.', cron: '0 9 * * 5' },
  { name: 'Competitor brief', prompt: 'Each week, check the competitor sources I provide and prepare a brief of what changed and what matters to my company.',
    notes: 'Approved source snapshot: Competitor A introduced team exports on 14 October.', cron: '0 9 * * 1' },
];
export function recordedGraph(example = examples[0]!): ComposedFlow {
  return { displayName: example.name, trigger: {
    name: 'trigger', type: example.cron ? 'PIECE_TRIGGER' : 'EMPTY',
    ...(example.cron ? { settings: { pieceName: 'schedule', input: { cron_expression: example.cron } } } : {}),
    nextAction: { name: 'draft', type: 'PIECE', settings: { pieceName: 'jarvis-ask', actionName: 'ask', input: {
      prompt: `Prepare a draft for review from these supplied notes. Do not send it.\n${example.notes}`,
    } }, nextAction: { name: 'review', type: 'PIECE', settings: { pieceName: 'jarvis-notify', actionName: 'notify',
      input: { message: '{{draft}}', channels: ['dashboard'] } } } },
  } };
}
