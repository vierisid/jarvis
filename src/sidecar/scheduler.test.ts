import { describe, test, expect } from 'bun:test';
import { EventScheduler, MAX_QUEUE_PER_SIDECAR } from './scheduler.ts';
import type { SidecarEvent } from './protocol.ts';

function makeEvent(type = 'sidecar_event', priority?: SidecarEvent['priority']): SidecarEvent {
  return {
    event_type: type,
    payload: { kind: 'test' },
    ...(priority ? { priority } : {}),
  } as unknown as SidecarEvent;
}

/** Drive the private drain loop directly instead of waiting on wall-clock timers. */
async function drainOnce(scheduler: EventScheduler): Promise<void> {
  await (scheduler as unknown as { drain(): Promise<void> }).drain();
}

describe('EventScheduler queue bounds', () => {
  test('queue never exceeds MAX_QUEUE_PER_SIDECAR', () => {
    const scheduler = new EventScheduler();
    for (let i = 0; i < MAX_QUEUE_PER_SIDECAR + 100; i++) {
      scheduler.enqueue('sc-1', makeEvent());
    }
    const queues = (scheduler as unknown as { queues: Map<string, unknown[]> }).queues;
    expect(queues.get('sc-1')!.length).toBe(MAX_QUEUE_PER_SIDECAR);
  });

  test('overflow drops the oldest lowest-priority event, keeps critical', async () => {
    const scheduler = new EventScheduler();
    scheduler.enqueue('sc-1', makeEvent('critical_evt', 'critical'));
    for (let i = 0; i < MAX_QUEUE_PER_SIDECAR - 1; i++) {
      scheduler.enqueue('sc-1', makeEvent('normal_evt', 'normal'));
    }
    // Queue is full — a high-priority arrival evicts a normal one, not the critical
    scheduler.enqueue('sc-1', makeEvent('high_evt', 'high'));

    const seen: string[] = [];
    scheduler.on('*', async (_id, event) => {
      seen.push(event.event_type);
    });
    await drainOnce(scheduler);
    expect(seen[0]).toBe('critical_evt');
    expect(seen).toContain('high_evt');
  });

  test('incoming event lower-priority than the whole queue is dropped', () => {
    const scheduler = new EventScheduler();
    for (let i = 0; i < MAX_QUEUE_PER_SIDECAR; i++) {
      scheduler.enqueue('sc-1', makeEvent('normal_evt', 'normal'));
    }
    scheduler.enqueue('sc-1', makeEvent('low_evt', 'low'));
    const queues = (scheduler as unknown as { queues: Map<string, Array<{ event: SidecarEvent }>> }).queues;
    const queue = queues.get('sc-1')!;
    expect(queue.length).toBe(MAX_QUEUE_PER_SIDECAR);
    expect(queue.some((q) => q.event.event_type === 'low_evt')).toBe(false);
  });

  test('drain dispatches a batch per tick, round-robin across sidecars', async () => {
    const scheduler = new EventScheduler();
    const seen: string[] = [];
    scheduler.on('*', async (sidecarId) => {
      seen.push(sidecarId);
    });
    for (let i = 0; i < 10; i++) {
      scheduler.enqueue('sc-a', makeEvent());
      scheduler.enqueue('sc-b', makeEvent());
    }
    await drainOnce(scheduler);
    // More than the old one-event-per-tick, fair across both sidecars
    expect(seen.length).toBe(10);
    expect(seen.filter((s) => s === 'sc-a').length).toBe(5);
    expect(seen.filter((s) => s === 'sc-b').length).toBe(5);
  });

  test('rpc_result is never evicted and never dropped on overflow', () => {
    const scheduler = new EventScheduler();
    for (let i = 0; i < MAX_QUEUE_PER_SIDECAR; i++) {
      scheduler.enqueue('sc-1', makeEvent('rpc_result', 'critical'));
    }
    // Queue is full of undroppable events: an incoming rpc_result must
    // still be accepted (cap overflows), a plain event must be dropped.
    scheduler.enqueue('sc-1', makeEvent('rpc_result', 'low'));
    scheduler.enqueue('sc-1', makeEvent('sidecar_event', 'critical'));
    const queues = (scheduler as unknown as { queues: Map<string, Array<{ event: SidecarEvent }>> }).queues;
    const queue = queues.get('sc-1')!;
    expect(queue.length).toBe(MAX_QUEUE_PER_SIDECAR + 1);
    expect(queue.every((q) => q.event.event_type === 'rpc_result')).toBe(true);
    expect(scheduler.dropped().count).toBe(1);
  });

  test('overflow evicts a droppable event, not a queued rpc_result', () => {
    const scheduler = new EventScheduler();
    scheduler.enqueue('sc-1', makeEvent('rpc_result', 'low'));
    for (let i = 0; i < MAX_QUEUE_PER_SIDECAR - 1; i++) {
      scheduler.enqueue('sc-1', makeEvent('sidecar_event', 'low'));
    }
    scheduler.enqueue('sc-1', makeEvent('sidecar_event', 'normal'));
    const queues = (scheduler as unknown as { queues: Map<string, Array<{ event: SidecarEvent }>> }).queues;
    const queue = queues.get('sc-1')!;
    expect(queue.length).toBe(MAX_QUEUE_PER_SIDECAR);
    expect(queue.some((q) => q.event.event_type === 'rpc_result')).toBe(true);
  });

  test('dropped() reports count, timestamp, and per-sidecar attribution', () => {
    const scheduler = new EventScheduler();
    for (let i = 0; i < MAX_QUEUE_PER_SIDECAR + 3; i++) {
      scheduler.enqueue('sc-1', makeEvent());
    }
    const stats = scheduler.dropped();
    expect(stats.count).toBe(3);
    expect(stats.lastDroppedAt).toBeGreaterThan(0);
    expect(stats.bySidecar['sc-1']).toBe(3);
  });

  test('priority order is preserved with FIFO within a class', async () => {
    const scheduler = new EventScheduler();
    scheduler.enqueue('sc-1', makeEvent('n1', 'normal'));
    scheduler.enqueue('sc-1', makeEvent('c1', 'critical'));
    scheduler.enqueue('sc-1', makeEvent('n2', 'normal'));
    scheduler.enqueue('sc-1', makeEvent('h1', 'high'));

    const seen: string[] = [];
    scheduler.on('*', async (_id, event) => {
      seen.push(event.event_type);
    });
    await drainOnce(scheduler);
    expect(seen).toEqual(['c1', 'h1', 'n1', 'n2']);
  });
});
