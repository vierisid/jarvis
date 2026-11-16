import { expect, test } from 'bun:test';
import { estimateMinutesFromJson, estimateMinutesPerRun } from './time-saved-estimate';
import type { FlowTriggerNode } from './db/repos/flow-version';

const piece = (pieceName: string, nextAction?: FlowTriggerNode): FlowTriggerNode => ({ name: 's', type: 'PIECE', settings: { pieceName, actionName: 'a' }, ...(nextAction ? { nextAction } : {}) });
const graph = (first?: FlowTriggerNode): FlowTriggerNode => ({ name: 'trigger', type: 'PIECE_TRIGGER', ...(first ? { nextAction: first } : {}) });

test('each kind of step adds its documented minutes, short or scoped piece names alike', () => {
  expect(estimateMinutesPerRun(graph(piece('@jarvispieces/piece-jarvis-notify', piece('@activepieces/piece-gmail', piece('jarvis-ask')))))).toBe(1 + 2 + 5);
  expect(estimateMinutesPerRun(graph(piece('@jarvispieces/piece-jarvis-report')))).toBe(10);
  expect(estimateMinutesPerRun(graph(piece('@activepieces/piece-http', piece('@activepieces/piece-json', piece('@activepieces/piece-store')))))).toBe(3);
});
test('human input, triggers, routers and loops add nothing; the floor is one minute and the cap sixty', () => {
  expect(estimateMinutesPerRun(graph(piece('@jarvispieces/piece-jarvis-input', piece('@activepieces/piece-approval'))))).toBe(1);
  expect(estimateMinutesPerRun(null)).toBe(1);
  let chain: FlowTriggerNode | undefined;
  for (let i = 0; i < 20; i++) chain = piece('@jarvispieces/piece-jarvis-report', chain);
  expect(estimateMinutesPerRun(graph(chain))).toBe(60);
});
test('steps inside loops and router branches count once, and unreadable graphs get the floor', () => {
  const loop: FlowTriggerNode = { name: 'loop', type: 'LOOP_ON_ITEMS', firstLoopAction: piece('@activepieces/piece-gmail') };
  const router: FlowTriggerNode = { name: 'r', type: 'ROUTER', children: [piece('@activepieces/piece-slack'), null] };
  expect(estimateMinutesPerRun(graph({ ...loop, nextAction: router }))).toBe(4);
  expect(estimateMinutesFromJson('{not json')).toBe(1);
  expect(estimateMinutesFromJson(JSON.stringify(graph(piece('@activepieces/piece-gmail'))))).toBe(2);
});
