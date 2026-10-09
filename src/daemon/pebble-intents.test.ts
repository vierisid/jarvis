/**
 * Guards the pebble's one-shot voice fast paths (#926).
 *
 * Each of these runs before the model and, on a match, answers instead of it.
 * So every misfire pinned here is a sentence the user said that JARVIS either
 * acted on wrongly or refused without asking the model. The phrases are the
 * ones from the issue plus the ones found verifying it; each block also pins
 * the commands the fast path exists for, so a fix that simply stopped
 * matching anything would fail here too.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { wakeCommandFrom } from '../voice/wake-phrase.ts';
import {
  exactRoomKey, findRoomKey, parseBackgroundTask, parseSettingsIntent, PEBBLE_ROOMS,
  planInPanelAction, planSubPebbleClose, planWindowAction,
  type PanelLookups, type PanelRef, type SubPebbleCand,
} from './pebble-intents.ts';

// The daemon's open-panel inventory, over the real room table: the same
// shape as panelLookups() in index.ts.
function lookups(open: string[]): PanelLookups {
  const panels: PanelRef[] = open.map((key, i) => ({ id: `p${i}`, key, title: PEBBLE_ROOMS[key]!.title }));
  return {
    findPanel: (hint) => {
      if (!hint) return panels[panels.length - 1] ?? null;
      const key = findRoomKey(hint);
      return key ? [...panels].reverse().find((p) => p.key === key) ?? null : null;
    },
    roomTitle: (phrase) => {
      const key = exactRoomKey(phrase);
      return key ? PEBBLE_ROOMS[key]!.title : null;
    },
  };
}

describe('background agent trigger', () => {
  // The one with teeth: each of these spawned a specialist on the tail.
  test.each([
    'change the background to blue',
    "what's the background on this story",
    'background noise is really loud today',
    'play some music in the background, please',
    'research the market in the background, and summarize it',
    'can you run a background check on the new hire',
    'In the background of this photo, what is that car?',
    'in the background music keeps playing',
    // The price of the rule: without its comma this goes to the model, which
    // can still start an agent through its own gated tool.
    'In the background research flights to Tokyo',
  ])('does not start an agent for "%s"', (said) => {
    expect(parseBackgroundTask(said)).toBeNull();
  });

  test.each([
    ['in the background, research flights to Tokyo', 'research flights to Tokyo'],
    ['Background: draft a blog post about bun', 'draft a blog post about bun'],
    ['background, compare these three laptops', 'compare these three laptops'],
    ['spawn a background agent to compare laptops', 'compare laptops'],
    ['Hey Jarvis, in the background, summarize my inbox', 'summarize my inbox'],
    ['Okay, please, in the background: summarize my inbox', 'summarize my inbox'],
  ])('starts an agent for "%s"', (said, task) => {
    expect(parseBackgroundTask(said)).toBe(task);
  });

  test('a wake word mid-sentence does not make the rest a command', () => {
    // The wake path hands over what follows the LAST "jarvis".
    expect(parseBackgroundTask(wakeCommandFrom('keep Jarvis in the background while I work'))).toBeNull();
    expect(parseBackgroundTask(wakeCommandFrom('ok Jarvis, in the background, compare laptops'))).toBe('compare laptops');
  });

  test('a trigger with nothing after it is not a command', () => {
    expect(parseBackgroundTask('in the background, ok')).toBeNull();
  });
});

describe('text-to-speech toggle', () => {
  test.each([
    'turn off the voice memo app',
    'disable speech therapy reminders',
    'turn on the voice recorder',
    'turn off voice mail notifications',
    'i never turn off text to speech',
    "don't turn off text to speech",
  ])('leaves speech alone for "%s"', (said) => {
    expect(parseSettingsIntent(said)).toBeNull();
  });

  test.each([
    ['turn off text to speech', false],
    ['turn off text-to-speech in the settings', false],
    ['disable tts', false],
    ['turn off voice output', false],
    ['switch off the voice response', false],
    ['turn off the voice', false],
    ['disable speech.', false],
    ['enable text to speech please', true],
    ['turn on tts', true],
    ['can you turn off text to speech', false],
  ])('"%s" sets speech enabled=%p', (said, enabled) => {
    expect(parseSettingsIntent(said as string)).toEqual({ kind: 'tts', enabled: enabled as boolean });
  });

  test('transcription provider switch still parses', () => {
    expect(parseSettingsIntent('switch the transcription to groq')).toEqual({ kind: 'stt', target: 'groq' });
    expect(parseSettingsIntent('use whisper for transcription')).toEqual({ kind: 'stt', target: 'openai' });
    expect(parseSettingsIntent('Jarvis, use local for transcription')).toEqual({ kind: 'stt', target: 'local' });
  });

  test('a sentence about the transcription provider does not switch it', () => {
    // Persisted, and moves where all later mic audio goes.
    expect(parseSettingsIntent("i don't use groq for transcription anymore")).toBeNull();
    expect(parseSettingsIntent('we talked about how to switch the transcription to local')).toBeNull();
  });
});

describe('in-panel navigation', () => {
  test('with nothing open, "open the settings page" is left for the room opener, not refused', () => {
    expect(planInPanelAction('open the settings page', lookups([]))).toBeNull();
    expect(planInPanelAction('switch to the voice tab', lookups([]))).toBeNull();
  });

  test('a "tab" named after a room is the room, whatever is open', () => {
    // Was "Switched Workflows to settings." with Settings never opened; no
    // room takes settings, tools or logs as a tab.
    for (const said of ['open the settings page', 'open the logs view', 'open the tools section']) {
      expect(planInPanelAction(said, lookups(['workflows']))).toBeNull();
    }
  });

  test('a phrase that is not a known tab is not claimed, open panel or not', () => {
    expect(planInPanelAction('open the email view', lookups([]))).toBeNull();
    expect(planInPanelAction('open the email view', lookups(['settings']))).toBeNull();
    expect(planInPanelAction('open gmail in a new chrome tab', lookups(['settings']))).toBeNull();
  });

  test('naming a room that is not open is answered, with the room title', () => {
    expect(planInPanelAction('switch to the builder tab in agents', lookups(['settings'])))
      .toEqual({ kind: 'say', text: "The Agents window isn't open." });
  });

  test('a trailing phrase that is not a room is not taken for one', () => {
    expect(planInPanelAction('switch to the voice tab in the morning', lookups(['settings']))).toBeNull();
    // "chrome settings" contains a room name but is not one.
    expect(planInPanelAction('switch to the general tab in chrome settings', lookups([]))).toBeNull();
    expect(planInPanelAction('switch to the general tab in chrome settings', lookups(['settings']))).toBeNull();
  });

  test('switches the tab of the open panel', () => {
    expect(planInPanelAction('switch to the voice tab', lookups(['settings'])))
      .toMatchObject({ kind: 'switch_tab', tab: 'voice', target: { key: 'settings' } });
  });

  test('a room named after the tab picks that panel, with or without "window"', () => {
    // The hint used to be one letter ("s"), and "window" tripped the browser check.
    for (const said of ['go to the voice tab in settings', 'go to the voice tab in the settings window']) {
      expect(planInPanelAction(said, lookups(['settings', 'agents'])))
        .toMatchObject({ kind: 'switch_tab', tab: 'voice', target: { key: 'settings' } });
    }
    expect(planInPanelAction('go to the voice tab in chrome', lookups(['settings']))).toBeNull();
  });
});

describe('window management', () => {
  test.each(['can you expand on that', 'expand it', 'expand on this idea', 'make it bigger'])(
    'with nothing open, "%s" goes to the model',
    (said) => {
      expect(planWindowAction(said, lookups([]))).toBeNull();
    },
  );

  test.each([
    'can you expand on that', // was "I don't see a on window open."
    'please restore my faith in people',
    'restore my settings to default',
    'i need to focus',
    'can you expand',
    'dismiss the reminder',
    'dismiss that notification',
    'close that tab',
    'kill it with fire',
    'shut it down',
  ])('with panels open, "%s" is not a window command', (said) => {
    expect(planWindowAction(said, lookups(['settings', 'workflows']))).toBeNull();
  });

  test('naming a room that is not open is answered, with the room title', () => {
    expect(planWindowAction('expand the workflows window', lookups(['settings'])))
      .toEqual({ kind: 'say', text: "The Workflows window isn't open." });
  });

  test('acts on the open panel', () => {
    const open = lookups(['settings']);
    expect(planWindowAction('expand it', open)).toMatchObject({ kind: 'window', action: 'maximized', target: { key: 'settings' } });
    expect(planWindowAction('maximize', open)).toMatchObject({ kind: 'window', action: 'maximized' });
    expect(planWindowAction('Jarvis, go full screen please.', open)).toMatchObject({ kind: 'window', action: 'maximized' });
    expect(planWindowAction('put it away', open)).toMatchObject({ kind: 'window', action: 'minimized' });
    expect(planWindowAction('where did it go?', open)).toMatchObject({ kind: 'window', action: 'focus' });
    expect(planWindowAction('make it smaller', open)).toMatchObject({ kind: 'window', action: 'normal' });
    for (const said of ['close it', 'close that window', 'dismiss it', 'get rid of it', 'throw it away']) {
      expect(planWindowAction(said, open)).toMatchObject({ kind: 'window', action: 'close', target: { key: 'settings' } });
    }
    expect(planWindowAction('minimize the workflows window', lookups(['workflows', 'settings'])))
      .toMatchObject({ kind: 'window', action: 'minimized', target: { key: 'workflows' } });
  });

  test('a room with a two-word name resolves', () => {
    // The tail was lazy, so the hint was one word and these never matched.
    expect(planWindowAction('minimize the agent strip', lookups(['agent_strip', 'settings'])))
      .toMatchObject({ kind: 'window', action: 'minimized', target: { key: 'agent_strip' } });
    expect(planWindowAction('expand the token usage window', lookups(['usage', 'settings'])))
      .toMatchObject({ kind: 'window', action: 'maximized', target: { key: 'usage' } });
  });
});

describe('closing background agents', () => {
  const research: SubPebbleCand = { id: 't1', slot: 0, color: 'amber', agentName: 'Research Analyst' };
  const writer: SubPebbleCand = { id: 't2', slot: 1, color: 'sage', agentName: 'Content Writer' };
  const running = [research, writer];

  test.each([
    'close that window',
    'cancel this order',
    'get rid of this file',
    'close the agents window',
    'close the background agents window',
  ])('with none running, "%s" is not answered "no background agents"', (said) => {
    expect(planSubPebbleClose(said, null)).toBeNull();
  });

  test.each([
    'close that window',
    'cancel this order',
    'get rid of this file',
    'close the agents window',
    'close the agent strip',
    'close the background agents window',
    'close the content panel',
    'close the teal one',
    'close all agents',
  ])('with agents running, "%s" does not close one', (said) => {
    expect(planSubPebbleClose(said, running)).toBeNull();
  });

  test('asked by name with none running, says so', () => {
    expect(planSubPebbleClose('close the background agent', null))
      .toEqual({ kind: 'say', text: 'There are no background agents running.' });
  });

  test('a colour or name that is not running is not taken for the newest', () => {
    // Used to close t2, a different agent from the one named.
    expect(planSubPebbleClose('close the teal background agent', running))
      .toEqual({ kind: 'say', text: "There's no teal background agent running." });
    expect(planSubPebbleClose('kill that teal background agent', running))
      .toEqual({ kind: 'say', text: "There's no teal background agent running." });
    expect(planSubPebbleClose('close the legal background agent', running))
      .toEqual({ kind: 'say', text: "There's no legal background agent running." });
  });

  test('closes what it is asked to', () => {
    const cases: Array<[string, string, string]> = [
      ['close the background agent', 't2', 'most recent'],
      ['close the last background agent', 't2', 'most recent'],
      ['dismiss the sub-agent', 't2', 'most recent'],
      ['close the amber one', 't1', 'amber'],
      ['close the amber sub-pebble', 't1', 'amber'],
      ['close the amber background task', 't1', 'amber'],
      ['close the research one', 't1', 'research analyst'],
      ['close the content agent', 't2', 'content writer'],
    ];
    for (const [said, id, label] of cases) {
      expect({ said, plan: planSubPebbleClose(said, running) })
        .toMatchObject({ said, plan: { kind: 'close_one', cand: { id }, label } });
    }
    expect(planSubPebbleClose('close all background agents', running)).toEqual({ kind: 'close_all', count: 2 });
  });
});

describe('the daemon uses these plans', () => {
  // Extracting the decisions made it possible to bypass them with every test
  // here green: an inline regex left in index.ts would be what actually runs.
  const src = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');

  test('each fast path asks pebble-intents.ts', () => {
    expect(src).toContain('parseSettingsIntent(userText)');
    expect(src).toContain('planInPanelAction(userText, panelLookups(sidecarId))');
    expect(src).toContain('planSubPebbleClose(userText, cands)');
    expect(src).toContain('parseBackgroundTask(userText)');
    expect(src).toContain('planWindowAction(lower, panelLookups(sidecarId))');
  });

  test('no copy of the old patterns is left behind', () => {
    expect(src).not.toContain('in the background[,:]?');
    expect(src).not.toContain('voice (?:output|response)?');
    expect(src).not.toContain('tryParseWindowAction');
  });
});
