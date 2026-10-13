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
  backgroundRefusalReply, exactRoomKey, findRoomKey, parseBackgroundTask, parseSettingsIntent, PEBBLE_ROOMS,
  cancelCardReply, cancelRefusalReply, planInPanelAction, planSubPebbleClose, planWindowAction, SPOKEN_TABS, spokenTab, tabSwitchReply,
  type PanelLookups, type PanelRef, type SubPebbleCand,
} from './pebble-intents.ts';
import { isRoomTab, ROOM_TABS, roomTabs, type TabbedRoom } from './room-tabs.ts';
import { AgentLifecycleRefusal } from '../agents/lifecycle-gate.ts';
import { TaskHaltedError } from '../agents/task-manager.ts';

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
    openPanels: () => [...panels].reverse(),
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

describe('in-panel navigation names only tabs the room has (#933)', () => {
  const ROOM_KEYS = Object.keys(PEBBLE_ROOMS);
  // Every phrase the old flat table knew, plus every real tab and label. Each
  // used to be sent to whichever panel was open, whatever that room's tabs.
  const PHRASES = [
    'editor', 'edit', 'edit view', 'builder', 'agent builder', 'list', 'all', 'logs', 'history',
    'settings', 'general', 'tts', 'stt', 'voice', 'llm', 'tools', 'channels',
    ...Object.values(ROOM_TABS).flat(), 'command center',
  ];

  test('every spoken tab is a tab its room accepts, and every tab answers to its own name', () => {
    for (const [room, table] of Object.entries(SPOKEN_TABS)) {
      for (const tab of Object.values(table)) expect(isRoomTab(room as TabbedRoom, tab)).toBe(true);
      for (const tab of ROOM_TABS[room as TabbedRoom]) expect(spokenTab(room, tab)).toBe(tab);
    }
    expect(spokenTab('workflows', 'editor')).toBeNull();
    expect(spokenTab('settings', 'constructor')).toBeNull();
  });

  test('no plan, with any one room open, switches it to a tab it does not have', () => {
    let switches = 0;
    for (const key of ROOM_KEYS) {
      for (const phrase of PHRASES) {
        for (const said of [`switch to the ${phrase} tab`, `switch to the ${phrase} tab in ${PEBBLE_ROOMS[key]!.aliases[0]}`]) {
          const plan = planInPanelAction(said, lookups([key]));
          if (plan?.kind !== 'switch_tab') continue;
          switches++;
          const tabs = roomTabs(plan.target.key);
          if (!tabs?.includes(plan.tab)) throw new Error(`"${said}" with ${key} open switched ${plan.target.key} to ${plan.tab}`);
        }
      }
    }
    // Not vacuous: the real tabs do switch.
    expect(switches).toBeGreaterThan(20);
  });

  test('without a room named, the open panel that has the tab is the one switched', () => {
    // Agents is the most recent, and has no voice tab. This used to send
    // "voice" to Agents and say "Switched Agents to voice."
    expect(planInPanelAction('switch to the voice tab', lookups(['settings', 'agents'])))
      .toMatchObject({ kind: 'switch_tab', tab: 'voice', target: { key: 'settings' } });
    expect(planInPanelAction('switch to the voice tab', lookups(['agents']))).toBeNull();
    // Shared tab names go to the most recent room that has them.
    expect(planInPanelAction('switch to the constellation tab', lookups(['memory', 'goals'])))
      .toMatchObject({ kind: 'switch_tab', tab: 'constellation', target: { key: 'goals' } });
  });

  test('a room named outright that lacks the tab is answered, not switched', () => {
    expect(planInPanelAction('switch to the voice tab in agents', lookups(['agents', 'settings'])))
      .toEqual({ kind: 'say', text: "Agents doesn't have a voice tab." });
    // Workflows has no tab handler at all.
    expect(planInPanelAction('switch to the voice tab in the workflows window', lookups(['workflows'])))
      .toEqual({ kind: 'say', text: "Workflows doesn't have tabs I can switch." });
    // But a phrase that is no room's tab may be a place inside the room, so
    // the model gets it rather than a refusal.
    for (const said of [
      'switch to the editor tab in the workflows window',
      'go to the failed runs section of workflows',
      'go to the errors section in logs',
    ]) {
      expect(planInPanelAction(said, lookups(['workflows', 'logs']))).toBeNull();
    }
    // A place inside a tab is not a tab; the model can say where it lives.
    expect(planInPanelAction('go to the telegram section of settings', lookups(['settings']))).toBeNull();
  });

  test('every tab can be reached by a whole sentence with its room open', () => {
    // The table alone could hold a tab no sentence reaches. One is known:
    // "browser" is the browser-tab guard's word, so Memory's Browser tab is
    // left to the model rather than risk "open the browser tab".
    const unreachable = new Set(['memory:browser']);
    for (const [room, roomTabList] of Object.entries(ROOM_TABS)) {
      for (const tab of roomTabList) {
        const plan = planInPanelAction(`switch to the ${tab} tab`, lookups([room]));
        if (unreachable.has(`${room}:${tab}`)) expect(plan).toBeNull();
        else expect(plan).toMatchObject({ kind: 'switch_tab', tab, target: { key: room } });
      }
    }
  });

  test('tab labels read off the screen work', () => {
    expect(planInPanelAction('go to the agent builder tab', lookups(['agents'])))
      .toMatchObject({ kind: 'switch_tab', tab: 'builder' });
    expect(planInPanelAction('open the command center view', lookups(['agents'])))
      .toMatchObject({ kind: 'switch_tab', tab: 'command' });
  });

  test('a tab that shares a room alias is the tab while that room is open', () => {
    // "approvals" also names the Authority room.
    expect(planInPanelAction('switch to the approvals tab', lookups(['authority'])))
      .toMatchObject({ kind: 'switch_tab', tab: 'approvals', target: { key: 'authority' } });
    expect(planInPanelAction('open the approvals page', lookups(['settings']))).toBeNull();
  });

  test('only a switch the room accepted is announced as done', () => {
    expect(tabSwitchReply('Settings', 'voice', 'accepted')).toBe('Switched Settings to voice.');
    expect(tabSwitchReply('Settings', 'billing', 'rejected')).toBe("Settings didn't switch to billing.");
    expect(tabSwitchReply('Settings', 'voice', 'no_answer'))
      .toBe("I asked Settings to switch to voice, but it didn't answer.");
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
  const research: SubPebbleCand = { id: 't1', slot: 0, color: 'amber', agentName: 'Research Analyst', running: true };
  const writer: SubPebbleCand = { id: 't2', slot: 1, color: 'sage', agentName: 'Content Writer', running: true };
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
    expect(planSubPebbleClose('close all background agents', running)).toMatchObject({ kind: 'close_all', count: 2 });
  });

  // #934: closing a sub-pebble destroys its overlay; the task keeps running,
  // so none of these may be carried out by hiding. #963: they now ask for a
  // card to stop the agent. The assertion was `say CANNOT_STOP_AGENT`; it is
  // now `cancel`, which is just as much "not a hide" (a hide is close_one /
  // close_all) and also pins that the request reaches the card.
  test.each([
    'cancel the background agent',
    'kill the background agent',
    'kill the research agent',
    'cancel the amber one',
    'cancel the research one',
    'kill all background agents',
    'cancel all background agents',
    'close the background agent and stop it',
    'close and cancel the amber agent',
    'dismiss the sub-agent, abort it',
    'get rid of the background task and terminate it',
    // Inflections, STT spellings and other ways of asking for it to end.
    'close the background agent and cancels it',
    'close the background agent, I canceled it',
    'close the background agent, cancelling it',
    'close the background agent and kills it',
    'close the background agent and stopping it',
    'close the background agent and shut it down',
    'close and shut down the background agent',
    'close the background agent and end the task',
    'dismiss the background agent permanently',
    'get rid of the background task for good',
    'kill off the background agent',
  ])('"%s" is not carried out by hiding the agent: it asks for a card to stop it', (said) => {
    const plan = planSubPebbleClose(said, running);
    expect(plan?.kind).toBe('cancel');
    expect(plan && 'cands' in plan ? plan.cands.length : 0).toBeGreaterThan(0);
  });

  test('a stop asks about the agent it names, and only running ones', () => {
    expect(planSubPebbleClose('cancel the amber one', running)).toEqual({ kind: 'cancel', cands: [research], label: 'amber' });
    expect(planSubPebbleClose('kill the research agent', running))
      .toEqual({ kind: 'cancel', cands: [research], label: 'research analyst' });
    expect(planSubPebbleClose('cancel the background agent', running))
      .toEqual({ kind: 'cancel', cands: [writer], label: 'most recent' });
    const done: SubPebbleCand = { ...writer, running: false };
    expect(planSubPebbleClose('cancel all background agents', [research, done]))
      .toEqual({ kind: 'cancel', cands: [research], label: 'background' });
    expect(planSubPebbleClose('cancel the content agent', [research, done]))
      .toEqual({ kind: 'say', text: "The content writer background agent isn't running any more." });
    expect(planSubPebbleClose('cancel all background agents', [done]))
      .toEqual({ kind: 'say', text: 'None of the background agents is still running.' });
  });

  test('a negated cancel word asks only for the overlay to go', () => {
    for (const said of [
      "close the background agent, don't stop it",
      "close the background agent but don't kill it",
      'close the background agent without stopping it',
    ]) {
      expect({ said, kind: planSubPebbleClose(said, running)?.kind }).toEqual({ said, kind: 'close_one' });
    }
  });

  test('the card reply does not claim the agent was stopped or hidden', () => {
    for (const reply of [cancelCardReply('amber', 1), cancelCardReply('background', 2)]) {
      expect(reply).toContain('card');
      expect(reply).toMatch(/keeps? running until you click/);
      expect(reply).not.toMatch(/\b(closed|hid|cancelled|stopped)\b/i);
    }
    expect(cancelRefusalReply(new AgentLifecycleRefusal('terminate_agent', 'denied', 'x'))).toContain('not allowed');
    expect(cancelRefusalReply(new AgentLifecycleRefusal('terminate_agent', 'approval_required', 'x'))).toContain("can't ask");
    for (const reply of [cancelRefusalReply(new Error('x')), cancelRefusalReply(new AgentLifecycleRefusal('terminate_agent', 'denied', 'x'))]) {
      expect(reply).not.toMatch(/\b(closed|hid|cancelled|stopped)\b/i);
    }
  });

  test('a cancel for an agent that is not there still gets the true answer', () => {
    expect(planSubPebbleClose('cancel the teal background agent', running))
      .toEqual({ kind: 'say', text: "There's no teal background agent running." });
    expect(planSubPebbleClose('cancel the background agent', null))
      .toEqual({ kind: 'say', text: 'There are no background agents running.' });
    // Not about an agent at all: still the model's.
    expect(planSubPebbleClose('cancel this order', running)).toBeNull();
  });

  test('closing says it hid the agent, and whether its task is still running', () => {
    const done: SubPebbleCand = { ...writer, running: false };
    expect(planSubPebbleClose('close the amber one', running))
      .toMatchObject({ kind: 'close_one', reply: "Hid the amber background agent. It's still running." });
    expect(planSubPebbleClose('close the content agent', [research, done]))
      .toMatchObject({ kind: 'close_one', reply: 'Hid the content writer background agent.' });
    expect(planSubPebbleClose('close all background agents', running))
      .toMatchObject({ kind: 'close_all', reply: "Hid all 2 background agents. They're still running." });
    expect(planSubPebbleClose('close all background agents', [research, done]))
      .toMatchObject({ kind: 'close_all', reply: 'Hid all 2 background agents. 1 of them is still running.' });
    expect(planSubPebbleClose('close all background agents', [done]))
      .toMatchObject({ kind: 'close_all', reply: 'Hid the background agent.' });
    for (const said of ['close the background agent', 'dismiss the sub-agent', 'close all background agents']) {
      const plan = planSubPebbleClose(said, running);
      expect(plan?.kind === 'close_one' || plan?.kind === 'close_all' ? plan.reply : '').toMatch(/^Hid /);
    }
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

  test('hiding a background agent speaks the plan\'s reply, never "Closed" (#934)', () => {
    expect(src).toContain('await speakConfirmation(sidecarId, reply, ctrl);');
    expect(src).toContain('await speakConfirmation(sidecarId, plan.reply, ctrl);');
    expect(src).not.toContain('Closed the ${label} background agent.');
    expect(src).not.toContain('Closed all ${plan.count} background');
    expect(src).toContain("running: task.status === 'running'");
  });

  test('a tab switch waits for the room and reports what it said (#933)', () => {
    expect(src).toContain('await wsService.requestRoomAction({');
    expect(src).toContain('tabSwitchReply(target.title, tabRaw, outcome)');
    // A turn cancelled during the wait says nothing.
    const wait = src.indexOf('await wsService.requestRoomAction({');
    const reply = src.indexOf('tabSwitchReply(target.title, tabRaw, outcome)');
    expect(src.slice(wait, reply)).toContain('if (ctrl.cancelled) return true;');
    expect(src).not.toContain('`Switched ${target.title} to ${tabRaw}.`');
  });

  test('opening a room by voice resolves the alias with findRoomKey (#933)', () => {
    // The inline copy's escape never escaped anything (a broken character
    // class and replacement). No alias has a regex metacharacter, so it never
    // fired; this keeps the one correct copy the only one.
    expect(src).toContain('const key = findRoomKey(tail);');
    expect(src).not.toContain('orderedAliases');
  });

  // #932: "in the background, X" has no model and no gesture in front of it,
  // so it must reach the spawn through the shared, gated entry and nothing
  // that skips it.
  // #963: a spoken stop raises a card through the stop sink, and never calls
  // the stop itself.
  test('a spoken stop asks for a card and stops nothing directly', () => {
    expect(src).toContain('orchestrator.requestTerminationApproval(agentId, stopCall(agentId, cand.id))');
    expect(src).not.toContain('terminatePersistentAgent(');
    expect(src).not.toContain('.terminateAgent(');
    expect(src).not.toContain('cancelAgentTasks(');
    expect(src).not.toMatch(/\btm\??\.cancel\(/);
  });

  test('the background fast path spawns only through startPersistentAgent', () => {
    expect(src).toContain('await startPersistentAgent(deps, { specialist: specialistId, task });');
    expect(src).toContain('await speakConfirmation(sidecarId, backgroundRefusalReply(err), ctrl);');
    expect(src).not.toContain('spawnPersistentAgent(');
    expect(src).not.toContain('spawnSubAgent(');
    expect(src).not.toContain('taskManagerLocal.launch(');
  });

  test('no copy of the old patterns is left behind', () => {
    expect(src).not.toContain('in the background[,:]?');
    expect(src).not.toContain('voice (?:output|response)?');
    expect(src).not.toContain('tryParseWindowAction');
  });
});

describe('what the pebble says when a background agent was not started (#932)', () => {
  test('a spawn waiting on a card says so, and never that it is running', () => {
    const reply = backgroundRefusalReply(new AgentLifecycleRefusal('spawn_agent', 'approval_required', 'x', 'req-1'));
    expect(reply).toContain('needs your approval');
    expect(reply).toContain('card');
    expect(reply).not.toMatch(/running|started|got it/i);
  });

  test('approval with nobody to ask, a halted system and a deny each get their own answer', () => {
    expect(backgroundRefusalReply(new AgentLifecycleRefusal('spawn_agent', 'approval_required', 'x')))
      .toContain("can't ask");
    expect(backgroundRefusalReply(new AgentLifecycleRefusal('spawn_agent', 'halted', 'x'))).toContain('paused');
    expect(backgroundRefusalReply(new TaskHaltedError('paused'))).toContain('paused');
    expect(backgroundRefusalReply(new AgentLifecycleRefusal('spawn_agent', 'denied', 'x'))).toContain('not allowed');
    expect(backgroundRefusalReply(new Error('boom'))).toBe("I couldn't start that background task.");
  });
});
