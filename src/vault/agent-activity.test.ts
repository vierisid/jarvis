import { test, expect, beforeEach, describe } from 'bun:test';
import { initDatabase } from './schema.ts';
import { recordAgentActivity, listAgentActivity, countAgentActivity } from './agent-activity.ts';

describe('agent-activity', () => {
  beforeEach(() => {
    initDatabase(':memory:');
  });

  test('records and lists events for one agent', () => {
    recordAgentActivity({
      agent_id: 'agent-1',
      agent_name: 'Research',
      event_type: 'text',
      data: { text: 'Looking up Q3 revenue' },
      timestamp: 1000,
    });
    recordAgentActivity({
      agent_id: 'agent-1',
      agent_name: 'Research',
      event_type: 'tool_call',
      data: { name: 'web_search' },
      timestamp: 2000,
    });

    const events = listAgentActivity('agent-1');
    expect(events.length).toBe(2);
    // newest first
    expect(events[0]!.event_type).toBe('tool_call');
    expect(events[1]!.event_type).toBe('text');
  });

  test('isolates events by agent_id', () => {
    recordAgentActivity({ agent_id: 'a', agent_name: 'A', event_type: 'text', timestamp: 1 });
    recordAgentActivity({ agent_id: 'b', agent_name: 'B', event_type: 'text', timestamp: 2 });
    recordAgentActivity({ agent_id: 'a', agent_name: 'A', event_type: 'done', timestamp: 3 });

    expect(listAgentActivity('a').length).toBe(2);
    expect(listAgentActivity('b').length).toBe(1);
    expect(countAgentActivity('a')).toBe(2);
    expect(countAgentActivity('b')).toBe(1);
  });

  test('respects limit and offset', () => {
    for (let i = 0; i < 10; i++) {
      recordAgentActivity({
        agent_id: 'paginate',
        agent_name: 'P',
        event_type: 'text',
        data: { i },
        timestamp: 1000 + i,
      });
    }

    const first = listAgentActivity('paginate', { limit: 3 });
    expect(first.length).toBe(3);
    // newest first → i=9, 8, 7
    expect((first[0]!.data as { i: number }).i).toBe(9);
    expect((first[2]!.data as { i: number }).i).toBe(7);

    const second = listAgentActivity('paginate', { limit: 3, offset: 3 });
    expect((second[0]!.data as { i: number }).i).toBe(6);
  });

  test('clamps limit between 1 and 200', () => {
    for (let i = 0; i < 5; i++) {
      recordAgentActivity({
        agent_id: 'clamp',
        agent_name: 'C',
        event_type: 'text',
        timestamp: i,
      });
    }
    expect(listAgentActivity('clamp', { limit: 0 }).length).toBe(1);
    expect(listAgentActivity('clamp', { limit: -5 }).length).toBe(1);
    expect(listAgentActivity('clamp', { limit: 99999 }).length).toBe(5);
  });

  test('round-trips JSON data and handles missing data', () => {
    recordAgentActivity({
      agent_id: 'json',
      agent_name: 'J',
      event_type: 'tool_call',
      data: { name: 'send_email', args: { to: 'a@b.com' } },
      timestamp: 1,
    });
    recordAgentActivity({
      agent_id: 'json',
      agent_name: 'J',
      event_type: 'done',
      timestamp: 2,
    });

    const events = listAgentActivity('json');
    expect(events.length).toBe(2);
    const done = events[0]!;
    const tool = events[1]!;
    expect(done.data).toBeNull();
    expect((tool.data as { name: string }).name).toBe('send_email');
  });

  test('returns empty for unknown agent', () => {
    expect(listAgentActivity('nope').length).toBe(0);
    expect(countAgentActivity('nope')).toBe(0);
  });
});
