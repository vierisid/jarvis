import { expect, test } from 'bun:test';
import { compileWorkflow } from './workflow-readiness';
import { PieceCatalog } from './piece-catalog';

const catalog = new PieceCatalog([{ name: '@activepieces/piece-hubspot', displayName: 'HubSpot', description: '', auth: { type: 'SECRET_TEXT' },
  actions: { update_contact: { name: 'update_contact', displayName: 'Update contact', description: '', inputSchema: { fields: [
    { name: 'notify', label: 'Notify owner', type: 'boolean', sourceType: 'CHECKBOX', required: false },
    { name: 'stage', label: 'Stage', type: 'multi_enum', sourceType: 'STATIC_MULTI_SELECT_DROPDOWN', required: false, options: [{ value: 'a', label: 'A' }] },
    { name: 'hubspotConnection', label: 'HubSpot account', type: 'string', sourceType: 'SHORT_TEXT', required: true },
    { name: 'adAccountId', label: 'Ad account', type: 'string', sourceType: 'SHORT_TEXT', required: true },
  ] } } } }] as any);
const graph = (input: Record<string, unknown>) => ({ name: 'trigger', type: 'EMPTY', settings: {}, nextAction: { name: 'step_1', type: 'PIECE',
  settings: { pieceName: '@activepieces/piece-hubspot', actionName: 'update_contact', input } } });

test('a missing connection names the app and Connected workspace, with a structured hint', () => {
  const { issues } = compileWorkflow(graph({ notify: true, hubspotConnection: 'x', adAccountId: 'y' }), { pieces: catalog });
  expect(issues).toContainEqual({ node: 'step_1', path: 'settings.input.auth', code: 'CONNECTION_BINDING',
    message: 'Connect your HubSpot account in Connected workspace, then choose it here', connect: { app: 'HubSpot' } });
  const setup = compileWorkflow(graph({}), { pieces: catalog }).issues;
  const account = setup.find(i => i.path === 'settings.input.hubspotConnection')!;
  expect(account).toMatchObject({ code: 'SETUP_REQUIRED', connect: { app: 'HubSpot' } });
  expect(account.message).toContain('Connected workspace');
  // A required field merely labelled "... account" is an input to fill in, not a connection.
  expect(setup.find(i => i.path === 'settings.input.adAccountId')).toEqual({ node: 'step_1', path: 'settings.input.adAccountId',
    code: 'SETUP_REQUIRED', message: 'Ad account: fill in this required input' });
});

test('type errors read in plain words naming the field', () => {
  const messages = compileWorkflow(graph({ notify: 'maybe', stage: 'a', hubspotConnection: 'x', adAccountId: 'y' }), { pieces: catalog }).issues
    .filter(i => i.code === 'INPUT_TYPE').map(i => i.message);
  expect(messages).toEqual(['Choose Yes or No for Notify owner', 'Choose one of the listed options for Stage']);
});
