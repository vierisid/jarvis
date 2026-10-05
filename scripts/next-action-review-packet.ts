#!/usr/bin/env bun
/**
 * Print the founder review packet for the next-action planner (Q-18): each
 * scenario's situation, the planner's actual answer with its reasons and the
 * alternatives it weighed, the proposed expectation, and the rubric to mark.
 *
 *   bun run scripts/next-action-review-packet.ts [--out FILE]
 */
import { writeFileSync } from 'node:fs';
import rubric from '../src/goals/next-action-rubric.json' with { type: 'json' };
import { planNextAction, PLANNER, type NextActionPlan } from '../src/goals/next-action.ts';
import { SCENARIO_SET, scenarioMisses, scenarioSnapshot } from '../src/goals/next-action-scenarios.ts';

function answer(plan: NextActionPlan): string[] {
  if (plan.outcome === 'recommend') {
    return [`**Recommends:** ${plan.action.title}`, '', 'Why, as the planner gives it:', ...plan.action.rationale.map(r => `- ${r}`)];
  }
  if (plan.outcome === 'ask') return [`**Asks:** ${plan.question}`];
  return [`**Recommends nothing new:** ${plan.reason}`];
}

const lines = [
  `# What's next? review packet`,
  '',
  `Planner \`${PLANNER}\`, rubric \`${rubric.id}\` (${rubric.status}), ${SCENARIO_SET.scenarios.length} scenarios (${SCENARIO_SET.status}).`,
  '',
  'For each scenario, read the situation and the planner\'s answer, then mark every criterion yes or no. Edit the proposed expectation where you disagree.',
  '',
  '## Criteria',
  '',
  ...rubric.criteria.map(c => `- **${c.id}**: ${c.question}`),
  '',
  `Pass: ${rubric.pass}`,
  '',
];
SCENARIO_SET.scenarios.forEach((scenario, index) => {
  const plan = planNextAction(scenarioSnapshot(scenario));
  const misses = scenarioMisses(scenario, plan);
  lines.push(`## ${index + 1}. ${scenario.id}`, '', `**Situation:** ${scenario.situation}`, '', ...answer(plan), '',
    'Alternatives weighed:', ...plan.considered.filter(c => c.outcome !== 'chosen').map(c => `- ${c.outcome.replace('_', ' ')}: ${c.title}. ${c.why}`), '',
    `**Proposed expectation:** ${scenario.expect.outcome}${scenario.expect.kind ? `, ${scenario.expect.kind}` : ''}. ${scenario.why}`,
    `**Planner meets it:** ${misses.length ? `no (${misses.join('; ')})` : 'yes'}`, '',
    `Review: ${rubric.criteria.map(c => `${c.id} [ ]`).join('  ')}`, '', 'Notes:', '');
});

const out = process.argv.indexOf('--out');
const text = lines.join('\n');
if (out > 0 && process.argv[out + 1]) writeFileSync(process.argv[out + 1]!, text);
else console.log(text);
