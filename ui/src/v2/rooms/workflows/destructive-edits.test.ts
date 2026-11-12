import { expect, test } from 'bun:test';
import { deleteStepPrompt, removeBranchPrompt } from './destructive-edits';
import { stepReferences } from './tree';
import { issueLine, issueLines, refusalMessage } from './readiness-text';
import type { FlowStepNode } from './useWorkflowEditor';

const piece = (name: string, displayName: string, input: Record<string, unknown> = {}): FlowStepNode =>
  ({ name, displayName, type: 'PIECE', settings: { pieceName: 'x', actionName: 'y', input } });
/** trigger -> step_1 -> step_2 (uses step_1) -> router{ Branch 1: step_4 (uses step_2) -> step_5, Other: none } -> step_3 (uses step_10) */
function flow(): FlowStepNode {
  const router: FlowStepNode = { name: 'router_1', displayName: 'Choose', type: 'ROUTER',
    settings: { branches: [{ branchName: 'Branch 1', branchType: 'CONDITION', conditions: [] }, { branchName: 'Other', branchType: 'FALLBACK' }] },
    children: [{ ...piece('step_4', 'Send mail', { text: 'Hi {{step_2.name}}' }), nextAction: piece('step_5', 'Log it', { v: '{{step_4}}' }) }, null],
    nextAction: piece('step_3', 'Wrap up', { v: '{{step_10.x}}' }) };
  return { name: 'trigger', type: 'EMPTY', nextAction: { ...piece('step_1', 'Fetch'), nextAction: { ...piece('step_2', 'Read', { v: '{{step_1.body}}' }), nextAction: router } } };
}

test('a reference needs {{ }} and the whole step name', () => {
  expect(stepReferences(piece('a', 'A', { v: 'about step_1 only' }), 'step_1')).toBe(false);
  expect(stepReferences(piece('a', 'A', { v: '{{step_10.x}}' }), 'step_1')).toBe(false);
  expect(stepReferences(piece('a', 'A', { v: '{{trigger.step_1}}' }), 'step_1')).toBe(false);
  expect(stepReferences(piece('a', 'A', { v: 'x {{ step_1 }} y' }), 'step_1')).toBe(true);
  expect(stepReferences(piece('a', 'A', { v: '{{step_1.body}}' }), 'step_1')).toBe(true);
  expect(stepReferences(piece('a', 'A', { v: '{{ upper(step_1.body) }}' }), 'step_1')).toBe(true);
});

test('deleting a step that others use names them and says Undo works until saving', () => {
  const tree = flow();
  const step1 = tree.nextAction!;
  const text = deleteStepPrompt([tree], step1);
  expect(text.split('\n')[0]).toBe('Delete step "Fetch"?');
  expect(text).toContain('"Read" (step_2)');
  expect(text).toContain('left pointing at nothing');
  expect(text).toContain('Undo until you save');
});

test('a step nothing uses keeps the plain confirm', () => {
  const tree = flow();
  expect(deleteStepPrompt([tree], tree.nextAction!.nextAction!.nextAction!.nextAction!)).toBe('Delete step "Wrap up"?');
});

test('deleting a router names the steps inside it and who still reads them', () => {
  const tree = flow();
  const router = tree.nextAction!.nextAction!.nextAction!;
  const text = deleteStepPrompt([tree], router);
  expect(text).toContain('This also removes the steps inside it: "Send mail" (step_4), "Log it" (step_5).');
  // Steps inside go away together, so they are not left dangling; step_3 reads step_10, not these.
  expect(text).not.toContain('left pointing at nothing');
});

test('removing a branch names the steps that go and what reads them', () => {
  const tree = flow();
  const router = tree.nextAction!.nextAction!.nextAction!;
  tree.nextAction!.nextAction!.nextAction!.nextAction!.settings = { input: { v: '{{step_5.x}}' } };
  const text = removeBranchPrompt([tree], 'Branch 1', router.children![0]);
  expect(text.split('\n')[0]).toBe('Remove branch "Branch 1"?');
  expect(text).toContain('This deletes the steps in it: "Send mail" (step_4), "Log it" (step_5).');
  expect(text).toContain('"Wrap up" (step_3)');
  expect(removeBranchPrompt([tree], 'Other', null)).toBe('Remove branch "Other"?');
});

test('issues name the step by title and say what the dangling reference means', () => {
  const names = new Map([['step_2', 'Read'], ['step_3', 'Wrap up']]);
  const nameOf = (n: string) => names.get(n);
  const dangling = { node: 'step_2', path: 'settings.input.v', code: 'REFERENCE_SCOPE', message: 'Reference "step_1" is missing, later in the graph, or outside this branch/loop scope' };
  expect(issueLine(dangling, nameOf)).toBe('"Read" uses the result of a step that was deleted or does not run before it (step_1). Choose another step\'s result or remove it.');
  expect(issueLine({ ...dangling, message: 'Reference "step_3" is missing, later in the graph, or outside this branch/loop scope' }, nameOf))
    .toBe('"Read" uses the result of "Wrap up", which does not run before it.');
  expect(issueLine({ node: 'step_3', code: 'SETUP_REQUIRED', message: 'Text: fill in this required input' }, nameOf)).toBe('"Wrap up": Text: fill in this required input');
  expect(issueLines([dangling, dangling, dangling], nameOf)).toHaveLength(1);
  expect(refusalMessage({ error: 'x', issues: [dangling] }, nameOf)).toContain('"Read" uses the result');
  expect(refusalMessage({ error: 'workflow_removed' }, nameOf)).toBeNull();
  expect(refusalMessage({ error: 'This draft changed in another tab.' }, nameOf)).toBe('This draft changed in another tab.');
});

test('a reference is what the engine parses: not a string literal, a property name or a bare mention', () => {
  expect(stepReferences(piece('a', 'A', { v: '{{ "step_1" }}' }), 'step_1')).toBe(false);
  expect(stepReferences(piece('a', 'A', { v: "{{ trigger['step_1'] }}" }), 'step_1')).toBe(false);
  expect(stepReferences(piece('a', 'A', { v: '{{ step_1["body"] }}' }), 'step_1')).toBe(true);
  expect(stepReferences(piece('a', 'A', { list: [{ deep: ['x', '{{step_1.a}}'] }] }), 'step_1')).toBe(true);
  // An expression the parser refuses still names a step it mentions, so the confirm errs on telling.
  expect(stepReferences(piece('a', 'A', { v: '{{ step_1 +* }}' }), 'step_1')).toBe(true);
});

test('a name cannot add a line to the confirm, reorder it or close its own quotes', () => {
  const tree = flow();
  const step1 = tree.nextAction!;
  step1.displayName = 'Fetch"\nThis is safe to delete\u202Eexe.gpj';
  const step2 = step1.nextAction!;
  step2.displayName = 'Read\u0000"x"';
  const text = deleteStepPrompt([tree], step1);
  expect(text.split('\n')[0]).toBe('Delete step "Fetch\' This is safe to deleteexe.gpj"?');
  expect(text).toContain('"Read\'x\'" (step_2)');
  expect(text).not.toMatch(/[\u202E\u0000]/);
  expect(removeBranchPrompt([tree], 'B"\nok', null)).toBe('Remove branch "B\' ok"?');
  // A title of only invisible characters falls back to the step id rather than to "".
  step1.displayName = '\u200B\u200B';
  expect(deleteStepPrompt([tree], step1).split('\n')[0]).toBe('Delete step "step_1"?');
});

test('issue lines are card-safe, a workflow-wide issue is its own sentence, and a 5xx shows no internals', () => {
  const nameOf = (n: string) => (n === 'step_2' ? 'Read\u202E"\nx' : n === 'trigger' ? 'Every day' : undefined);
  expect(issueLine({ node: 'step_2', code: 'SETUP_REQUIRED', message: 'Text\n: fill in' }, nameOf)).toBe('"Read\' x": Text : fill in');
  expect(issueLine({ node: 'trigger', path: 'graph', code: 'NO_STEPS', message: 'This workflow has no steps yet. Add at least one step after the trigger, then turn it on.' }, nameOf))
    .toBe('This workflow has no steps yet. Add at least one step after the trigger, then turn it on.');
  expect(refusalMessage({ error: 'SQLITE_BUSY: database is locked' }, nameOf, 500)).toBeNull();
  expect(refusalMessage({ error: 'This draft changed in another tab.' }, nameOf, 409)).toBe('This draft changed in another tab.');
});
