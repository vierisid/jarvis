/**
 * #969: the two places that tell a model which room actions exist, the voice
 * intent classifier's prompt and the realtime nav tool, offer only actions in
 * ROOM_ACTIONS (what the rooms' handlers carry out; room-actions.test.ts holds
 * the table to the handlers). Both were typed by hand and offered Authority
 * grant_access/revoke_access, Settings set_primary_llm/set_fallback_llm and
 * six Workflows actions that no handler runs. room-tabs-vocabulary.test.ts
 * does the same for tab names.
 */

import { describe, expect, test } from 'bun:test';
import { classifyVoiceIntent } from '../agents/voice-intent-classifier.ts';
import type { LLMManager } from '../llm/manager.ts';
import { REALTIME_NAV_TOOLS } from './realtime-nav-tools.ts';
import { isRoomAction, ROOM_ACTIONS } from './room-actions.ts';
import { readFileSync } from 'node:fs';

async function classifierPrompt(): Promise<string> {
  let system = '';
  const llm = {
    chatTier: async (_tier: string, _purpose: string, messages: Array<{ role: string; content: string }>) => {
      system = messages.find((m) => m.role === 'system')!.content;
      return { content: '{}' };
    },
  } as unknown as LLMManager;
  await classifyVoiceIntent('grant jarvis email access', [], llm);
  if (!system) throw new Error('classifier sent no system prompt');
  return system;
}

/** Split on commas that are not inside braces. */
function topLevelItems(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of list) {
    if (ch === '{') depth++;
    if (ch === '}') depth--;
    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

describe('the classifier prompt offers only actions the rooms carry out', () => {
  test('every action listed under a room is one of its ROOM_ACTIONS', async () => {
    const prompt = await classifierPrompt();
    const offered: string[] = [];
    let room: string | null = null;
    for (const line of prompt.split('\n')) {
      const header = /^\w+ room \("room": "(\w+)"\):$/.exec(line);
      if (header) { room = header[1]!; continue; }
      if (line.trim() === '') { room = null; continue; }
      const spec = /^- "(\w+)" \S+ args:/.exec(line);
      if (spec && room) offered.push(`${room}/${spec[1]}`);
    }
    // Not vacuous: the section was found and read.
    expect(offered.length).toBeGreaterThan(50);
    expect(offered.filter((a) => !isRoomAction(a.split('/')[0]!, a.split('/')[1]))).toEqual([]);
  });

  test('every example room_action is one of its room\'s actions', async () => {
    const prompt = await classifierPrompt();
    const named: string[] = [];
    for (const line of prompt.split('\n')) {
      if (!line.startsWith('{"verb"')) continue;
      const ra = (JSON.parse(line) as { room_action?: { room: string; action: string } | null }).room_action;
      if (ra) named.push(`${ra.room}/${ra.action}`);
    }
    expect(named.length).toBeGreaterThan(20);
    expect(named.filter((a) => !isRoomAction(a.split('/')[0]!, a.split('/')[1]))).toEqual([]);
  });

  test('no authority grant or revoke is offered anywhere in the prompt', async () => {
    const prompt = await classifierPrompt();
    expect(prompt).not.toContain('grant_access');
    expect(prompt).not.toContain('revoke_access');
  });
});

describe('the realtime nav tool offers only actions the rooms carry out', () => {
  test('every action in the reference is one of its room\'s ROOM_ACTIONS', () => {
    const tool = REALTIME_NAV_TOOLS.find((t) => t.name === 'dashboard_room_action');
    expect(tool).toBeDefined();
    const offered: string[] = [];
    for (const line of tool!.description.split('\n')) {
      const entry = /^- (\w+): (.*)$/.exec(line);
      if (!entry) continue;
      // Drop a trailing remark such as "(Do NOT set API keys by voice.)".
      const list = entry[2]!.replace(/\.\s*\(.*\)\s*$/, '');
      for (const item of topLevelItems(list)) {
        const name = /^(\w+)(?:\{[^}]*\})?$/.exec(item);
        if (!name) throw new Error(`unreadable item "${item}" for ${entry[1]}`);
        offered.push(`${entry[1]}/${name[1]}`);
      }
    }
    expect(offered.length).toBeGreaterThan(30);
    expect(offered.filter((a) => !isRoomAction(a.split('/')[0]!, a.split('/')[1]))).toEqual([]);
    expect(tool!.description).not.toContain('grant_access');
    expect(tool!.description).not.toContain('revoke_access');
  });
});

describe('the daemon\'s acknowledgements name only real actions', () => {
  test('every ackForRoomAction case is an action some room carries out', () => {
    const src = readFileSync(new URL('./ws-service.ts', import.meta.url), 'utf8');
    const table = src.slice(src.indexOf('function ackForRoomAction('));
    const cases = [...table.matchAll(/case '(\w+)':/g)].map((m) => m[1]!);
    expect(cases.length).toBeGreaterThan(30);
    const all = new Set<string>(Object.values(ROOM_ACTIONS).flat());
    // An ack for an action no handler runs (grant_access used to have one)
    // can never be said; it only misleads whoever reads the table.
    expect(cases.filter((c) => !all.has(c))).toEqual([]);
  });
});
