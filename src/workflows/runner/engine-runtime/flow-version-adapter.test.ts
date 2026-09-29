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
