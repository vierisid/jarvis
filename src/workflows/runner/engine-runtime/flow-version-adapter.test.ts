import { expect, test } from 'bun:test';
import { toUpstreamFlowVersion } from './flow-version-adapter';
import type { FlowVersion } from '../../db/repos/flow-version';

for (const propertySettings of [{}, { form: { schema: { recipient: { type: 'SHORT_TEXT', required: true } } } }]) {
  test(`adapter preserves saved action and trigger property schemas: ${JSON.stringify(propertySettings)}`, () => {
    const version: FlowVersion = { valid: false, schemaVersion: null, updatedBy: null, agentIds: [], connectionIds: [], notes: [], backupFiles: null, engineListeners: null, engineSchedule: null, sampleData: null, sampleInput: null, id: 'v1', flowId: 'f1', displayName: 'Dynamic form', created: 1, updated: 1, state: 'DRAFT', trigger: {
      name: 'trigger', type: 'PIECE_TRIGGER', settings: { pieceName: 'native', triggerName: 'event', input: { form: { recipient: 'owner' } }, propertySettings },
      nextAction: { name: 'send', type: 'PIECE', settings: { pieceName: 'native', actionName: 'send', input: { form: { recipient: 'owner' } }, propertySettings } },
    } };
    const before = structuredClone(version);
    const adapted = toUpstreamFlowVersion(version);
    expect(adapted.trigger.settings.propertySettings).toEqual(propertySettings);
    expect((adapted.trigger.nextAction!.settings as any).propertySettings).toEqual(propertySettings);
    expect(version).toEqual(before);
  });
}

function versionOf(actions: any): FlowVersion {
  return { valid: false, schemaVersion: null, updatedBy: null, agentIds: [], connectionIds: [], notes: [], backupFiles: null, engineListeners: null, engineSchedule: null, sampleData: null, sampleInput: null, id: 'v1', flowId: 'f1', displayName: 'Errors', created: 1, updated: 1, state: 'DRAFT',
    trigger: { name: 'trigger', type: 'EMPTY', nextAction: actions } };
}
const both = { continueOnFailure: { value: true }, retryOnFailure: { value: true } };

test('adapter hands the engine "Continue on failure" for piece and CODE steps', () => {
  const adapted = toUpstreamFlowVersion(versionOf({ name: 'a', type: 'PIECE', settings: { pieceName: '@activepieces/piece-math-helper', actionName: 'x', input: {}, errorHandlingOptions: both },
    nextAction: { name: 'b', type: 'CODE', settings: { sourceCode: { packageJson: '{}', code: '' }, input: {}, errorHandlingOptions: both } } }));
  const a = adapted.trigger.nextAction as any;
  expect(a.settings.errorHandlingOptions.continueOnFailure).toEqual({ value: true });
  expect(a.nextAction.settings.errorHandlingOptions).toEqual({ continueOnFailure: { value: true } });
});

test('adapter keeps "Retry on failure" only for built-in steps that act inside the run', () => {
  const retried = (pieceName: string) => (toUpstreamFlowVersion(versionOf({ name: 'a', type: 'PIECE', settings: { pieceName, actionName: 'x', input: {}, errorHandlingOptions: { retryOnFailure: { value: true } } } })).trigger.nextAction as any).settings.errorHandlingOptions;
  expect(retried('@activepieces/piece-math-helper')).toEqual({ retryOnFailure: { value: true } });
  for (const outside of ['@activepieces/piece-http', '@activepieces/piece-gmail', '@jarvispieces/piece-jarvis-notify', '@activepieces/piece-store', '@activepieces/piece-delay', '@activepieces/piece-approval', 'community-piece']) {
    expect(retried(outside)).toBeUndefined();
  }
});

test('adapter never hands the engine "Continue on failure" for a step that asks a person', () => {
  const options = (pieceName: string, actionName: string) => (toUpstreamFlowVersion(versionOf({ name: 'a', type: 'PIECE',
    settings: { pieceName, actionName, input: {}, errorHandlingOptions: both } })).trigger.nextAction as any).settings.errorHandlingOptions;
  for (const [piece, action] of [['@activepieces/piece-approval', 'wait_for_approval'], ['@activepieces/piece-approval', 'create_approval_links'],
    ['@jarvispieces/piece-jarvis-input', 'request_approval'], ['@jarvispieces/piece-jarvis-input', 'request_input']]) {
    expect(options(piece!, action!)).toBeUndefined();
  }
  expect(options('@jarvispieces/piece-jarvis-ask', 'ask')).toEqual({ continueOnFailure: { value: true } });
});
