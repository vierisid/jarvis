import { expect, test } from 'bun:test';
import { source } from './data-rooms';
import { AWARENESS_OFF_TEXT } from './http';
import { Projection } from '../reconciliation/resource';

/**
 * #1314 review: Today's prepared opportunities come from what awareness
 * recorded. Turned off, the stack says so and drops the cards it showed,
 * rather than keeping them as stale or reading "source_unavailable".
 */
test('an awareness-off read clears the stack and names the switch', async () => {
  let off = false;
  const read = async () => off ? { status: 'unavailable' as const, reason: AWARENESS_OFF_TEXT }
    : { status: 'ready' as const, data: [{ title: 'Invoice review', observation: 'You opened Outlook' }] };
  const projection = new Projection(source(['opportunities'], 'preparedOpportunities', read as never), () => () => {}, 5_000, () => {});
  const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setTimeout(resolve, 0)); };
  projection.subscribe(() => {});
  projection.access('ready'); await settle();
  expect(projection.getSnapshot()).toMatchObject({ state: 'ready' });
  off = true; projection.refresh(); await settle();
  expect(projection.getSnapshot()).toMatchObject({ state: 'unavailable', data: null, reason: AWARENESS_OFF_TEXT });
  off = false; projection.refresh(); await settle();
  expect(projection.getSnapshot()).toMatchObject({ state: 'ready' });
});
