/**
 * The notch's own settings, and the connections: the back office that fits
 * in a sheet.
 *
 * Settings is what the plan names for pass 12: the keys, the voice, and
 * watching. Each row is a sentence with a lit word where something can be
 * changed, as everywhere on the notch:
 *
 *   Talk      "Hold Ctrl + Win and speak."   the pair is the lit word
 *   Yes       "Tap Win + Alt."               the same
 *   Sounds    "My small sounds are off."     off or on
 *   Voice     what makes out speech now; changing it is the dashboard's
 *   Watching  leads to "What I see" (./where.ts)
 *
 * The keys are one machine's own, kept by its desktop app in its own
 * settings file. The brain asks that machine to change them (`notch.keys`)
 * and shows what it answers: a pair that is refused there (the same two keys
 * for talk and for yes) is refused here, and the word goes back.
 *
 * Connections says what Jarvis can reach and what it cannot, and takes the
 * person to where each is connected. It connects nothing itself: a sign-in
 * is the person's, in a window they can see.
 */
import type { NotchBlock, NotchButton, NotchPart, NotchWord } from './protocol.ts';
import type { NotchFeatureDef } from './feature.ts';
import type { NotchInbox } from './inbox.ts';
import type { NotchSettings } from './settings.ts';
import { NotchStageEnded, type NotchStage } from './stage.ts';

const em = (text: string): NotchPart => ({ em: text });
const word = (name: string, value: string, options: readonly string[], more: Partial<NotchWord> = {}): NotchPart =>
  ({ word: { name, value, options: [...options], ...more } });

/** The two pairs of keys of one machine, as its desktop app names them: "ctrl", "alt", "meta", "shift". */
/**
 * A page of the dashboard's settings the notch can open in a window of its
 * own. `speech` is where speech-to-text is chosen and its key is given.
 */
export type NotchSettingsPage = 'voice' | 'llm' | 'integrations' | 'speech';

export interface NotchKeyPairs { talk: [string, string]; yes: [string, string]; mac: boolean }

const KEY_NAMES: Record<string, [windows: string, mac: string]> = { ctrl: ['Ctrl', 'Ctrl'], alt: ['Alt', 'Option'], meta: ['Win', 'Cmd'], shift: ['Shift', 'Shift'] };

/** A pair as it is said: "Ctrl + Win" here, "Ctrl + Option" on a Mac. */
export function pairSaid(pair: readonly string[], mac: boolean): string {
  return pair.map((key) => KEY_NAMES[key]?.[mac ? 1 : 0] ?? key).join(' + ');
}

/** A pair as the desktop app reads it: "ctrl+meta". Null when the words are not two of its keys. */
export function pairWritten(said: string, mac: boolean): string | null {
  const parts = said.split('+').map((part) => part.trim().toLowerCase()).filter(Boolean);
  if (parts.length !== 2) return null;
  const keys = parts.map((part) => Object.keys(KEY_NAMES).find((key) => key === part || KEY_NAMES[key]![mac ? 1 : 0].toLowerCase() === part
    || (key === 'meta' && ['win', 'windows', 'cmd', 'command'].includes(part)) || (key === 'alt' && ['option', 'opt'].includes(part)) || (key === 'ctrl' && part === 'control')));
  if (!keys[0] || !keys[1] || keys[0] === keys[1]) return null;
  return `${keys[0]}+${keys[1]}`;
}

const same = (a: readonly string[], b: readonly string[]): boolean => [...a].sort().join('+') === [...b].sort().join('+');

/**
 * The pairs that are offered for one of the two, in the order they are
 * stepped through: the one in force first, then the usual others. The pair
 * the other one has is left out: both cannot be the same two keys.
 */
export function pairChoices(now: readonly string[], other: readonly string[], mac: boolean): string[] {
  const usual: [string, string][] = mac
    ? [['ctrl', 'alt'], ['alt', 'meta'], ['ctrl', 'meta'], ['ctrl', 'shift']]
    : [['ctrl', 'meta'], ['meta', 'alt'], ['ctrl', 'alt'], ['ctrl', 'shift']];
  const out = [pairSaid(now, mac)];
  for (const pair of usual) {
    if (same(pair, other) || same(pair, now)) continue;
    out.push(pairSaid(pair, mac));
  }
  return out;
}

/** "Settings", "open settings", "your settings", "change the keys". */
export function prefsRequest(text: string): boolean {
  const said = text.trim().toLowerCase().replace(/[.!?]+$/, '').replace(/\s+/g, ' ');
  return /^(?:open |show (?:me )?)?(?:the |your |my |notch )?settings$/.test(said) || /^change (?:the |my |your )?(?:talk |yes )?keys$/.test(said);
}

/** "Connections", "what are you connected to". */
export function connectionsRequest(text: string): boolean {
  const said = text.trim().toLowerCase().replace(/[.!?]+$/, '').replace(/\s+/g, ' ');
  return /^(?:open |show (?:me )?)?(?:the |your |my )?connections$/.test(said) || /^what (?:are you|is) connected(?: to)?$/.test(said);
}

/** One thing Jarvis can be connected to. */
export interface NotchConnection {
  id: string;
  name: string;
  /** Connected, not connected, or connected once and now needing the person to sign in again. */
  state: 'on' | 'off' | 'again';
  /** How it is reached, or why it is not, in a few words. */
  how: string;
}

export interface NotchPrefsDeps {
  inbox: NotchInbox;
  settings: NotchSettings;
  /** Switches the notch's small sounds, on every page that is up and every one that comes up. */
  setSound(on: boolean): void;
  /** The keys of the machine a sheet is open on. Not given where no desktop app can change them. */
  keys?: {
    read(sidecarId: string | null): Promise<NotchKeyPairs | null>;
    /** Asks that machine for other keys. Comes back with the pairs as they now are, or with why not. */
    change(sidecarId: string | null, change: { talk?: string; yes?: string }): Promise<NotchKeyPairs | { why: string }>;
  };
  /** What makes out speech now: who, and in which language. Null when nothing does. */
  voice?: () => { by: string; language: string } | null;
  /** "What I see" (./where.ts). */
  see?: (stage: NotchStage) => Promise<void>;
  /** "How I move" (./moves.ts). */
  moves?: (stage: NotchStage) => Promise<void>;
  /** "What I can do" (./cando.ts). */
  canDo?: (stage: NotchStage) => Promise<void>;
  /** Starts day one again (./dayone.ts). */
  dayOne?: () => void;
  /** Listening to calls (./call.ts): its row here, and what a word of that row changes. */
  calls?: { row(): NotchBlock | null; set(name: string, value: string): boolean };
  /** Noticing (./notice.ts): its row here, and what its word changes. */
  notice?: { row(): NotchBlock | null; set(name: string, value: string): boolean };
  /** What Jarvis is connected to, as it stands now. */
  connections?: () => NotchConnection[] | Promise<NotchConnection[]>;
  /** Takes the person to where one is connected: a sign-in window, or its page in the dashboard. */
  connect?: (id: string, sidecarId: string | null) => void | Promise<void>;
  /** Opens the dashboard, at one of its pages when it can. */
  openDashboard?: (sidecarId: string | null, page?: NotchSettingsPage) => void;
  log?: (line: string) => void;
}

export interface NotchPrefs {
  route(text: string): { did: string; run(): void } | null;
  /** The settings sheet. `leave` when what was pressed there takes the notch for itself (day one again): Home does not come back over it. */
  settings(stage: NotchStage): Promise<'leave' | void>;
  connections(stage: NotchStage): Promise<void>;
  /** Whether its small sounds are on. */
  sound(): boolean;
}

export function attachNotchPrefs(deps: NotchPrefsDeps): NotchPrefs {
  const log = deps.log ?? ((line: string) => console.log(line));
  const sound = (): boolean => deps.settings.get<unknown>('sound', false) === true;

  async function settings(stage: NotchStage): Promise<'leave' | void> {
    for (;;) {
      const machine = stage.from();
      let pairs: NotchKeyPairs | null = null;
      try { pairs = (await deps.keys?.read(machine)) ?? null; } catch (error) {
        if (error instanceof NotchStageEnded) throw error;
        pairs = null;
      }
      /** A word that was refused, and why: said under its row until something else is changed. */
      let refused: { word: string; why: string } | null = null;
      const blocks = (): NotchBlock[] => {
        const voice = deps.voice?.() ?? null;
        const links: NotchButton[] = [
          ...(deps.canDo ? [{ id: 'cando', label: 'What I can do', quiet: true }] : []),
          ...(deps.moves ? [{ id: 'moves', label: 'How I move', quiet: true }] : []),
          ...(deps.dayOne ? [{ id: 'dayone', label: 'Day one again', quiet: true }] : []),
        ];
        return [
          ...(pairs ? [
            { kind: 'row' as const, lead: 'Talk', say: ['Hold ', word('talk', pairSaid(pairs.talk, pairs.mac), pairChoices(pairs.talk, pairs.yes, pairs.mac), { label: 'Talk keys' }), ' and speak.'] satisfies NotchPart[],
              ...(refused?.word === 'talk' ? { small: refused.why } : {}) },
            { kind: 'row' as const, lead: 'Yes', say: ['Tap ', word('yes', pairSaid(pairs.yes, pairs.mac), pairChoices(pairs.yes, pairs.talk, pairs.mac), { label: 'Yes keys' }), '.'] satisfies NotchPart[],
              ...(refused?.word === 'yes' ? { small: refused.why } : {}) },
          ] : [{ kind: 'row' as const, lead: 'Keys', say: ['This computer cannot tell me its keys. They are in its tray menu, under Settings.'] satisfies NotchPart[] }]),
          { kind: 'row', lead: 'Sounds', say: ['My small sounds are ', word('sound', sound() ? 'on' : 'off', ['off', 'on'], { label: 'Sounds' }), '.'] },
          {
            kind: 'row', lead: 'Voice',
            say: voice ? ['I make out what you say with ', em(voice.by), ', in ', em(voice.language), '.'] : ['Nothing turns your speech into words yet.'],
            ...(deps.openDashboard ? { buttons: [{ id: 'voice', label: voice ? 'Change' : 'Set up', quiet: true }] } : {}),
          },
          ...(deps.see ? [{ kind: 'row' as const, id: 'see', go: true, lead: 'Watching', say: ['What I see, and what I never watch.'] satisfies NotchPart[] }] : []),
          ...((): NotchBlock[] => { const row = deps.notice?.row(); return row ? [row] : []; })(),
          ...((): NotchBlock[] => { const row = deps.calls?.row(); return row ? [row] : []; })(),
          ...(links.length ? [{ kind: 'buttons' as const, buttons: links }] : []),
          { kind: 'note', say: ['The keys are for this computer. Nothing spoken is kept as sound.'] },
        ];
      };
      const id = stage.id();
      stage.put({ id, kind: 'sheet', say: ['Settings'], blocks: blocks(), mood: 'look' });
      let again = false;
      while (!again) {
        const answer = await stage.answer(id, ['no', 'button', 'go', 'word']);
        if (answer.act === 'no') return;
        if (answer.act === 'go' && answer.row === 'see' && deps.see) { await deps.see(stage); again = true; break; }
        if (answer.act === 'button') {
          if (answer.button === 'moves' && deps.moves) { await deps.moves(stage); again = true; break; }
          if (answer.button === 'cando' && deps.canDo) { await deps.canDo(stage); again = true; break; }
          // Day one begins when this sheet, and Home under it, have left the notch. Started from in here it
          // could not take the notch, sat in the count, and Home came back instead.
          if (answer.button === 'dayone' && deps.dayOne) { const begin = deps.dayOne; deps.inbox.after(() => begin()); return 'leave'; }
          // What makes out speech is set at "Voice Transcription", not on the page of the voice it speaks with.
          if (answer.button === 'voice' && deps.openDashboard) { deps.openDashboard(stage.from(), 'speech'); return; }
          continue;
        }
        if (answer.act !== 'word') continue;
        const value = (answer.value ?? '').trim();
        if (answer.word && (deps.calls?.set(answer.word, value) || deps.notice?.set(answer.word, value))) {
          refused = null;
          stage.surface.update(id, { blocks: blocks() });
          continue;
        }
        if (answer.word === 'sound') {
          const on = value.toLowerCase() === 'on';
          deps.settings.set('sound', on);
          deps.setSound(on);
          log(`[notch] its sounds were switched ${on ? 'on' : 'off'}`);
          refused = null;
          stage.surface.update(id, { blocks: blocks() });
          continue;
        }
        if ((answer.word === 'talk' || answer.word === 'yes') && pairs && deps.keys) {
          const written = pairWritten(value, pairs.mac);
          let got: NotchKeyPairs | { why: string };
          if (!written) got = { why: 'That is not two of the keys.' };
          else {
            try { got = await deps.keys.change(stage.from(), { [answer.word]: written }); } catch (error) {
              if (error instanceof NotchStageEnded) throw error;
              got = { why: 'This computer did not take them.' };
            }
          }
          if ('why' in got) {
            // Refused where the keys are kept: the word goes back to what holds, and why is said beside it.
            refused = { word: answer.word, why: got.why };
            stage.surface.act({ gesture: 'shake' });
          } else {
            pairs = got;
            refused = null;
            // Which two keys, never by whom or where.
            log(`[notch] the ${answer.word} keys were changed from the notch`);
          }
          stage.surface.update(id, { blocks: blocks() });
        }
      }
    }
  }

  async function connections(stage: NotchStage): Promise<void> {
    for (;;) {
      let list: NotchConnection[] = [];
      try { list = (await deps.connections?.()) ?? []; } catch (error) {
        if (error instanceof NotchStageEnded) throw error;
        log(`[notch] the connections could not be read: ${error instanceof Error ? error.message : String(error)}`);
      }
      const blocks: NotchBlock[] = [
        ...(list.length ? list.map((one): NotchBlock => ({
          kind: 'row', id: one.id, lead: one.name, say: [one.how],
          small: one.state === 'on' ? 'Connected' : one.state === 'again' ? 'Needs you to sign in again' : 'Not connected',
          ...(one.state !== 'on' && deps.connect ? { buttons: [{ id: 'connect', label: one.state === 'again' ? 'Sign in' : 'Connect' }] } : {}),
        })) : [{ kind: 'row' as const, say: ['I cannot tell what is connected right now.'] satisfies NotchPart[] }]),
        ...(deps.openDashboard ? [{ kind: 'buttons' as const, buttons: [{ id: 'all', label: 'Everything else, in the dashboard', quiet: true }] }] : []),
        { kind: 'note', say: ['I ask for a new app only when an agent needs it.'] },
      ];
      const answer = await stage.sheet(['Connections'], blocks, { mood: 'look' });
      if (answer.act !== 'button') return;
      if (answer.button === 'all') { deps.openDashboard?.(stage.from(), 'integrations'); return; }
      if (answer.button === 'connect' && answer.row && deps.connect) {
        const one = list.find((item) => item.id === answer.row);
        if (!one) continue;
        try { await deps.connect(one.id, stage.from()); } catch (error) {
          if (error instanceof NotchStageEnded) throw error;
          log(`[notch] a connection could not be opened: ${error instanceof Error ? error.message : String(error)}`);
          await stage.say(['I could not open that. It is in the dashboard, under Settings.'], 4000, { mood: 'sorry', mark: 'fail' });
          continue;
        }
        await stage.say(['I opened it. Sign in there, and come back.'], 3600, { mood: 'look' });
        return;
      }
    }
  }

  return {
    route(text) {
      if (prefsRequest(text)) return { did: 'Show the settings.', run: () => { deps.inbox.present('settings', async (stage) => { await settings(stage); }); } };
      if (connectionsRequest(text)) return { did: 'Show the connections.', run: () => { deps.inbox.present('connections', (stage) => connections(stage)); } };
      return null;
    },
    settings,
    connections,
    sound,
  };
}

/** What the settings and the connections are given of the product. */
export interface NotchPrefsGiven extends Pick<NotchPrefsDeps, 'keys' | 'voice' | 'connections' | 'connect'> {
  /** Opens the dashboard at one of its settings pages. */
  openPage?: (sidecarId: string | null, page: NotchSettingsPage) => void;
  /** Opens the dashboard itself. */
  openDashboard?: (sidecarId: string | null) => void;
  /** Whether the brain was given day one, listening to calls, noticing: each has its link or its row in Settings when it was. */
  dayOne: boolean;
  calls: boolean;
  notice: boolean;
}

/**
 * The notch's own settings and the connections, as a feature of the notch
 * (./feature.ts), with their quiet links at the foot of Home. Absent on a
 * brain that was not given where to keep the settings.
 *
 * Day one, the calls and the noticing are made after this: each is asked for
 * when its row is drawn or its word is changed.
 */
export function notchPrefsFeature(given: NotchPrefsGiven): NotchFeatureDef<'prefs'> {
  return {
    id: 'prefs',
    needs: ['moves', 'canDo'],
    wants: ['where', 'dayOne', 'calls', 'notice'],
    make(ctx) {
      const settings = ctx.settings;
      const moves = ctx.use('moves');
      const canDo = ctx.use('canDo');
      if (!settings || !moves || !canDo) return null;
      const where = ctx.use('where');
      const { openPage, openDashboard } = given;
      const api = attachNotchPrefs({
        inbox: ctx.inbox, settings, log: ctx.log,
        setSound: (on) => ctx.surface.setSound(on),
        keys: given.keys,
        voice: given.voice,
        see: where ? (stage) => where.see(stage) : undefined,
        moves: (stage) => moves.open(stage),
        canDo: (stage) => canDo.open(stage),
        dayOne: given.dayOne ? () => ctx.use('dayOne')?.again() : undefined,
        // Listening to calls: whether it is offered, and whether the other side is heard.
        calls: given.calls ? { row: () => ctx.use('calls')?.settingsRow() ?? null, set: (name, value) => ctx.use('calls')?.setWord(name, value) ?? false } : undefined,
        // Noticing: whether it offers one thing in the window the person is in.
        notice: given.notice ? { row: () => ctx.use('notice')?.settingsRow() ?? null, set: (name, value) => ctx.use('notice')?.setWord(name, value) ?? false } : undefined,
        connections: given.connections,
        connect: given.connect,
        // A page of the dashboard when it can be opened at one, the dashboard itself when not.
        openDashboard: openPage || openDashboard
          ? (sidecarId, page) => { if (page && openPage) openPage(sidecarId, page); else openDashboard?.(sidecarId); }
          : undefined,
      });
      return {
        api,
        // The connections have their link when the brain can tell what is connected.
        homeLinks: () => [
          ...(given.connections ? [{ id: 'connections', label: 'Connections', quiet: true }] : []),
          { id: 'settings', label: 'Settings', quiet: true },
        ],
        press: async (stage, link) => {
          if (link === 'connections') { await api.connections(stage); return 'stay'; }
          if (link === 'settings') return (await api.settings(stage)) === 'leave' ? 'leave' : 'stay';
          return null;
        },
      };
    },
  };
}
