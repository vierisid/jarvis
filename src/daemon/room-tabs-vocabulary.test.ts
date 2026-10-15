/**
 * #965: the two places that tell a model which room tabs exist, the voice
 * intent classifier's prompt and the realtime voice nav tool, offer exactly
 * the tabs in ROOM_TABS (what each room's switch_tab handler accepts), and
 * offer switch_tab only for rooms that have a handler for it. Both used to be
 * typed by hand: they offered Workflows `list|editor|builder` (Workflows has
 * no switch_tab handler) and left out Settings `voice`/`billing` and Agents
 * `builder`.
 */

import { describe, expect, test } from 'bun:test';
import { classifyVoiceIntent } from '../agents/voice-intent-classifier.ts';
import type { LLMManager } from '../llm/manager.ts';
import { REALTIME_NAV_TOOLS } from './realtime-nav-tools.ts';
import { isRoomTab, ROOM_TABS, type TabbedRoom } from './room-tabs.ts';

const expected = Object.fromEntries(Object.entries(ROOM_TABS).map(([room, tabs]) => [room, [...tabs]]));

async function classifierPrompt(): Promise<string> {
  let system = '';
  const llm = {
    chatTier: async (_tier: string, _purpose: string, messages: Array<{ role: string; content: string }>) => {
      system = messages.find((m) => m.role === 'system')!.content;
      return { content: '{}' };
    },
  } as unknown as LLMManager;
  await classifyVoiceIntent('switch to the voice tab', [], llm);
  if (!system) throw new Error('classifier sent no system prompt');
  return system;
}

describe('the classifier prompt offers only real tabs', () => {
  test('switch_tab is listed for exactly the rooms in ROOM_TABS, with exactly their tabs', async () => {
    const prompt = await classifierPrompt();
    const offered: Record<string, string[]> = {};
    let room: string | null = null;
    let outside = 0;
    for (const line of prompt.split('\n')) {
      const header = /^\w+ room \("room": "(\w+)"\):$/.exec(line);
      if (header) { room = header[1]!; continue; }
      if (line.trim() === '') { room = null; continue; }
      const spec = /^- "switch_tab" \S+ args: \{ "tab": (.+) \}$/.exec(line);
      if (!spec) continue;
      if (!room) { outside++; continue; }
      expect(offered[room]).toBeUndefined();
      offered[room] = [...spec[1]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
    }
    expect(outside).toBe(0);
    expect(offered).toEqual(expected);
  });

  test('every switch_tab example in the prompt names a real tab', async () => {
    const prompt = await classifierPrompt();
    let examples = 0;
    for (const line of prompt.split('\n')) {
      if (!line.startsWith('{"verb"')) continue;
      const ra = (JSON.parse(line) as { room_action?: { room: string; action: string; args: { tab?: unknown } } | null }).room_action;
      if (ra?.action !== 'switch_tab') continue;
      examples++;
      expect(`${ra.room}:${String(ra.args.tab)}:${Object.hasOwn(ROOM_TABS, ra.room) && isRoomTab(ra.room as TabbedRoom, ra.args.tab)}`)
        .toBe(`${ra.room}:${String(ra.args.tab)}:true`);
    }
    // Not vacuous: the prompt does carry switch_tab examples.
    expect(examples).toBeGreaterThan(0);
  });
});

describe('the realtime nav tool offers only real tabs', () => {
  test('switch_tab is listed for exactly the rooms in ROOM_TABS, with exactly their tabs', () => {
    const tool = REALTIME_NAV_TOOLS.find((t) => t.name === 'dashboard_room_action');
    expect(tool).toBeDefined();
    const offered: Record<string, string[]> = {};
    for (const line of tool!.description.split('\n')) {
      const entry = /^- (\w+): (.*)$/.exec(line);
      if (!entry) continue;
      const tabs = /\bswitch_tab\{tab: ([^}]*)\}/.exec(entry[2]!);
      if (tabs) offered[entry[1]!] = tabs[1]!.split('|');
      else expect(entry[2]).not.toContain('switch_tab');
    }
    // Authority is left out on purpose: nothing there needs voice, and its
    // grants and revokes are clicks only (#969). Every other tabbed room is
    // offered, with exactly its tabs.
    const { authority: _authority, ...rest } = expected;
    expect(offered).toEqual(rest);
    expect(tool!.description).not.toMatch(/^- authority:/m);
  });
});
