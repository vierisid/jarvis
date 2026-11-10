import { expect, test } from 'bun:test';
import { compileWorkflow } from './workflow-readiness';
import { PieceCatalog } from './piece-catalog';

const catalog = new PieceCatalog([{ name: '@activepieces/piece-hubspot', displayName: 'HubSpot', description: '', auth: { type: 'SECRET_TEXT' },
  actions: { update_contact: { name: 'update_contact', displayName: 'Update contact', description: '', inputSchema: { fields: [
    { name: 'notify', label: 'Notify owner', type: 'boolean', sourceType: 'CHECKBOX', required: false },
    { name: 'stage', label: 'Stage', type: 'multi_enum', sourceType: 'STATIC_MULTI_SELECT_DROPDOWN', required: false, options: [{ value: 'a', label: 'A' }] },
    { name: 'owner_account', label: 'HubSpot account', type: 'string', sourceType: 'SHORT_TEXT', required: true },
  ] } } } }] as any);
const graph = (input: Record<string, unknown>) => ({ name: 'trigger', type: 'EMPTY', settings: {}, nextAction: { name: 'step_1', type: 'PIECE',
  settings: { pieceName: '@activepieces/piece-hubspot', actionName: 'update_contact', input } } });

test('a missing connection names the app and Connected workspace, with a structured hint', () => {
  const { issues } = compileWorkflow(graph({ notify: true, owner_account: 'x' }), { pieces: catalog });
  expect(issues).toContainEqual({ node: 'step_1', path: 'settings.input.auth', code: 'CONNECTION_BINDING',
    message: 'Connect your HubSpot account in Connected workspace, then choose it here', connect: { app: 'HubSpot' } });
  const setup = compileWorkflow(graph({}), { pieces: catalog }).issues.find(i => i.path === 'settings.input.owner_account')!;
  expect(setup).toMatchObject({ code: 'SETUP_REQUIRED', connect: { app: 'HubSpot' } });
  expect(setup.message).toContain('Connected workspace');
});

test('type errors read in plain words naming the field', () => {
  const messages = compileWorkflow(graph({ notify: 'maybe', stage: 'a', owner_account: 'x' }), { pieces: catalog }).issues
    .filter(i => i.code === 'INPUT_TYPE').map(i => i.message);
  expect(messages).toEqual(['Choose Yes or No for Notify owner', 'Choose one of the listed options for Stage']);
});
