/**
 * Where you are, and whether I am looking.
 *
 * The desktop app tells the brain which app is in front the moment it
 * changes (`notch.where`), with the app's own icon, whether your hands are
 * still, and whether it is looking away. From that the resting notch shows
 * three things, and nothing else decides them:
 *
 *   - eyes open, the app's icon beside them: I am watching this;
 *   - eyes turned aside, no icon: I am looking away by myself (a password is
 *     being typed, or this is your bank). Nothing is captured;
 *   - eyes closed, no icon: I see nothing here. You told me never to watch
 *     this app, or watching is switched off, or I am asleep.
 *
 * Looking away is decided in the desktop app, before anything is captured
 * (sidecar/notch_where.go). The brain is told; it does not decide. What it
 * adds is a second door: a capture that was already on its way when the
 * desktop app started looking away is not kept (`mayKeep`).
 *
 * "Never watch this app" is a list the desktop app keeps, on that machine.
 * The brain asks it to change the list and shows what it answers.
 *
 * A window's title is text from the screen. It is shown to the person on the
 * "What I see" sheet and goes nowhere else from here.
 */
import type { NotchInbox } from './inbox.ts';
import { notchIconUrl } from './protocol.ts';
import type { NotchBlock, NotchMood, NotchPart, NotchWhereApp } from './protocol.ts';
import { NotchStageEnded, type NotchStage } from './stage.ts';
import type { NotchSurface } from './surface.ts';

/** The event a desktop app sends when where you are, or whether it is looking, changes. */
export const NOTCH_WHERE_EVENT = 'notch.where';
/** The call that changes a desktop app's "never watch" list. */
export const NOTCH_NEVER_WATCH_RPC = 'notch.never_watch';

/** Why the desktop app is not looking: nothing, a password field in focus, a bank, or an app on the list. */
export type NotchLook = '' | 'password' | 'bank' | 'never';

/** How many icons are kept: one per app seen, the oldest dropped first. */
const ICONS_KEPT = 64;

export interface NotchWherePort {
  onEvent(listener: (sidecarId: string, event: { event_type: string; payload: unknown; binary?: unknown }) => void): void;
  onSidecarDisconnected?(listener: (sidecarId: string) => void): void;
  dispatchRPC(sidecarId: string, method: string, params: Record<string, unknown>): Promise<unknown>;
}

export interface NotchWhereDeps {
  /** Whether everything is stopped (Esc twice, the tray's Pause): asleep, and seeing nothing. */
  asleep(): boolean;
  /** Goes to sleep: the product's own pause. */
  sleep(): void;
  /** Whether watching is switched on at all (the product's awareness setting). Taken as on when not given. */
  watching?(): boolean;
  log?: (line: string) => void;
}

/** What one desktop app last said. */
interface Seen {
  /** The app as the desktop app names it for its list: a program's name, in small letters. */
  app: string;
  /** The app as a person calls it. */
  name: string;
  /** The site, when the app is a browser and the desktop app could tell: "github.com". */
  site: string;
  title: string;
  look: NotchLook;
  still: boolean;
  never: string[];
  icon: string | null;
}

export interface NotchWhere {
  /** The face the resting notch has, when it is not asleep. */
  face(): NotchMood;
  /** Looks again at everything and brings the notch in line: after sleep or wake, or a setting. */
  refresh(): void;
  /** The row Home shows about it. */
  row(): NotchBlock;
  /** The "What I see" sheet. Comes back when it is closed. */
  see(stage: NotchStage): Promise<void>;
  /**
   * Whether something a desktop app captured about `app` may be kept. False
   * while that machine looks away, while the app is on its list, and while
   * asleep: a capture that left before the desktop app knew is dropped here.
   */
  mayKeep(sidecarId: string, app?: string | null): boolean;
  /** Whether the person's hands are still on the machine in front, as last told. */
  still(): boolean;
  stop(): void;
}

const em = (text: string): NotchPart => ({ em: text });

const oneLine = (value: unknown, most: number): string =>
  typeof value === 'string' ? [...value.replace(/\s+/g, ' ').trim()].slice(0, most).join('') : '';

/** A program's name as the list holds it: small letters, no `.exe`. */
export const notchAppKey = (value: unknown): string => oneLine(value, 80).toLowerCase().replace(/\.(exe|app)$/, '');

/** How a site is told from a program on the "never watch" list: this mark in front of it. */
export const NOTCH_SITE_MARK = 'site:';

/** A site as the desktop app names it, "github.com", or '' when it is not one. */
export function notchSite(value: unknown): string {
  const site = oneLine(value, 253).toLowerCase();
  return /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*\.[a-z]{2,24}$/.test(site) ? site : '';
}

/** One entry of the list: a program's name, or a site with its mark. '' when it is neither. */
export function notchNeverEntry(value: unknown): string {
  const raw = oneLine(value, 300);
  if (raw.toLowerCase().startsWith(NOTCH_SITE_MARK)) {
    const site = notchSite(raw.slice(NOTCH_SITE_MARK.length));
    return site ? NOTCH_SITE_MARK + site : '';
  }
  return notchAppKey(raw);
}

/** Whether a site is on a list, itself or as part of a site that is ("google.com" covers "mail.google.com"). */
export function notchNeverHasSite(never: readonly string[], site: string): boolean {
  if (!site) return false;
  return never.some((entry) => {
    if (!entry.startsWith(NOTCH_SITE_MARK)) return false;
    const listed = entry.slice(NOTCH_SITE_MARK.length);
    return site === listed || site.endsWith(`.${listed}`);
  });
}

function readLook(value: unknown): NotchLook {
  return value === 'password' || value === 'bank' || value === 'never' ? value : '';
}

/** What a desktop app said, checked. Null when it is not a `notch.where` payload at all. */
export function parseNotchWhere(payload: unknown): Omit<Seen, 'icon'> & { iconKey: string } | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const raw = payload as Record<string, unknown>;
  const app = notchAppKey(raw.app);
  const look = readLook(raw.look);
  return {
    app,
    name: oneLine(raw.name, 60) || app,
    // The site is not ours to have while it looks away for a password or a
    // bank, whatever was sent. For a site on the list it is: the person named it.
    site: look === 'password' || look === 'bank' ? '' : notchSite(raw.site),
    // While it looks away the title is not ours to have, whatever was sent.
    title: look ? '' : oneLine(raw.title, 160),
    look,
    still: raw.still === true,
    never: Array.isArray(raw.never) ? [...new Set(raw.never.map(notchNeverEntry).filter(Boolean))].slice(0, 200) : [],
    iconKey: oneLine(raw.icon, 80),
  };
}

export function attachNotchWhere(surface: NotchSurface, inbox: NotchInbox, port: NotchWherePort, deps: NotchWhereDeps): NotchWhere {
  const log = deps.log ?? ((line: string) => console.log(line));
  const seen = new Map<string, Seen>();
  /** Icons by the key the desktop app gave them, as data URLs. */
  const icons = new Map<string, string>();
  /** The machine that spoke last: the one the person is at. */
  let front: string | null = null;
  /** Said once since the brain started, so the first time is explained and the rest is the eyes. */
  const said = new Set<NotchLook>();
  let stopped = false;

  const here = (): Seen | null => (front ? seen.get(front) ?? null : null);
  const watchingOn = (): boolean => deps.watching?.() !== false;

  function face(): NotchMood {
    const now = here();
    if (!watchingOn() || now?.look === 'never') return 'closed';
    if (now?.look === 'password' || now?.look === 'bank') return 'away';
    return 'idle';
  }

  function refresh(): void {
    if (stopped) return;
    const now = here();
    const asleep = deps.asleep();
    // Asleep, the closed eyes are the pause's own (pause.ts). Awake, they are mine.
    if (!asleep) surface.setFace(face());
    const watching = !asleep && face() === 'idle' && !!now?.app;
    const app: NotchWhereApp | null = watching ? { name: now!.name, ...(now!.icon ? { icon: now!.icon } : {}) } : null;
    surface.setWhere(app);
  }

  /** The first time it looks away for a reason, it says why. After that the eyes say it. */
  function explain(look: NotchLook): void {
    if (look !== 'password' && look !== 'bank') return;
    if (said.has(look) || deps.asleep()) return;
    const words = look === 'password' ? 'A password. I am not looking.' : 'Your bank. I look away in here.';
    if (inbox.present(`look-${look}`, (stage) => stage.say([words], 2400, { mood: 'away' }))) said.add(look);
  }

  port.onEvent((sidecarId, event) => {
    if (stopped || event.event_type !== NOTCH_WHERE_EVENT) return;
    const told = parseNotchWhere(event.payload);
    if (!told) return;
    const binary = event.binary as { type?: string; mime_type?: string; data?: unknown } | undefined;
    if (told.iconKey && binary?.type === 'inline' && typeof binary.data === 'string') {
      const url = notchIconUrl(`data:image/png;base64,${binary.data}`);
      if (url) {
        icons.delete(told.iconKey);
        icons.set(told.iconKey, url);
        while (icons.size > ICONS_KEPT) icons.delete(icons.keys().next().value!);
      }
    }
    const before = seen.get(sidecarId)?.look ?? '';
    const { iconKey, ...rest } = told;
    seen.set(sidecarId, { ...rest, icon: iconKey ? icons.get(iconKey) ?? null : null });
    front = sidecarId;
    refresh();
    if (told.look !== before) {
      // What changed, never what is on the screen.
      log(`[notch] that machine is ${told.look ? `looking away (${told.look})` : 'watching again'}`);
      explain(told.look);
    }
  });
  port.onSidecarDisconnected?.((sidecarId) => {
    seen.delete(sidecarId);
    if (front === sidecarId) front = seen.keys().next().value ?? null;
    refresh();
  });

  function row(): NotchBlock {
    const now = here();
    const say: NotchPart[] = deps.asleep() || face() === 'closed' ? ['I am ', em('not watching'), ' right now.']
      : face() === 'away' ? ['I am ', em('looking away'), '.']
        : now?.site ? ['I see ', em(now.site), ', in ', now.name, '.']
          : now?.app ? ['I see ', em(now.name), '.'] : ['I see ', em('no app'), ' in front.'];
    return { kind: 'row', id: 'see', say, go: true };
  }

  /** What "never watch" would be about: the site when one is known, else the app. Null when nothing is in front. */
  function subject(now: Seen | null): { entry: string; label: string; listed: boolean } | null {
    if (!now?.app) return null;
    // An app that is on the list is offered first: taking it off is the only thing to do about it.
    if (now.never.includes(now.app)) return { entry: now.app, label: now.name, listed: true };
    if (now.site) {
      // On the list as part of a bigger site ("google.com" for mail.google.com):
      // what can be taken off is the entry that is there, by its own name.
      const covering = now.never.find((entry) => entry.startsWith(NOTCH_SITE_MARK)
        && (now.site === entry.slice(NOTCH_SITE_MARK.length) || now.site.endsWith(`.${entry.slice(NOTCH_SITE_MARK.length)}`)));
      if (covering) return { entry: covering, label: covering.slice(NOTCH_SITE_MARK.length), listed: true };
      return { entry: NOTCH_SITE_MARK + now.site, label: now.site, listed: false };
    }
    return { entry: now.app, label: now.name, listed: false };
  }

  /** The sheet's blocks for the state as it stands. */
  function blocks(): NotchBlock[] {
    const now = here();
    const asleep = deps.asleep();
    const name = now?.name ?? '';
    const about = subject(now);
    const lead = asleep || !watchingOn() || now?.look === 'never' ? 'Not watching'
      : now?.look ? 'Looking away'
        : now?.site ? `${now.site}, in ${name}`
          : now?.app ? name : 'No app in front';
    const small: NotchPart[] = asleep ? ['I am asleep. I see nothing until you wake me.']
      : !watchingOn() ? ['Watching is switched off in the settings. I see nothing.']
        : now?.look === 'never' ? ['You told me never to watch ', em(about?.label ?? name), '.']
          : now?.look === 'password' ? ['A password is being typed. Banks and passwords are never read. I look away by myself.']
            : now?.look === 'bank' ? ['This looks like your bank. Banks and passwords are never read. I look away by myself.']
              : now?.app ? [...(now.title ? [em(now.title), '. '] : []), 'I look at this screen about every 15 seconds, when it has changed, and read the text on it.']
                : ['Nothing I can name is in front.'];
    const never = (now?.never ?? []).map((entry) => (entry.startsWith(NOTCH_SITE_MARK) ? entry.slice(NOTCH_SITE_MARK.length) : entry));
    const buttons = [
      ...(asleep ? [] : [{ id: 'sleep', label: 'Sleep' }]),
      ...(about && !asleep ? [{ id: 'never', label: about.listed ? `Watch ${about.label} again` : `Never watch ${about.label}` }] : []),
    ];
    return [
      { kind: 'row', lead, say: small },
      ...(never.length ? [{ kind: 'note' as const, say: ['Never watching: ', em(never.join(', ')), '.'] satisfies NotchPart[] }] : []),
      ...(buttons.length ? [{ kind: 'buttons' as const, buttons }] : []),
      { kind: 'note', say: ['Eyes open means I am watching. Eyes closed means I see nothing.'] },
    ];
  }

  async function see(stage: NotchStage): Promise<void> {
    for (;;) {
      const answer = await stage.sheet(['What I see'], blocks(), { mood: deps.asleep() ? 'closed' : face() === 'idle' ? 'look' : face() });
      if (answer.act !== 'button') return;
      if (answer.button === 'sleep') {
        // Sleeping takes the notch: this sheet ends under it.
        deps.sleep();
        return;
      }
      if (answer.button === 'never') {
        const machine = front;
        const about = subject(here());
        if (!machine || !about) continue;
        const watch = about.listed;
        try {
          // `app` holds the entry: a program's name, or a site with its mark.
          const reply = await port.dispatchRPC(machine, NOTCH_NEVER_WATCH_RPC, { app: about.entry, watch });
          const list = (reply as { never?: unknown } | null)?.never;
          // The desktop app answers with its list and sends the new state too.
          // Until that arrives the sheet shows the answer.
          const current = seen.get(machine);
          if (current && Array.isArray(list)) {
            current.never = [...new Set(list.map(notchNeverEntry).filter(Boolean))];
            const off = current.never.includes(current.app) || notchNeverHasSite(current.never, current.site);
            if (off) current.look = 'never';
            else if (current.look === 'never') current.look = '';
            refresh();
          }
        } catch (error) {
          if (error instanceof NotchStageEnded) throw error;
          log(`[notch] the "never watch" list could not be changed: ${error instanceof Error ? error.message : String(error)}`);
          await stage.say(['That could not be changed on this computer. Nothing is different.'], 3000, { mood: 'sorry', mark: 'fail' });
        }
      }
    }
  }

  function mayKeep(sidecarId: string, app?: string | null): boolean {
    if (deps.asleep()) return false;
    const now = seen.get(sidecarId);
    if (!now) return true;
    if (now.look) return false;
    const key = notchAppKey(app);
    return !(key && now.never.includes(key));
  }

  refresh();
  return {
    face, refresh, row, see, mayKeep,
    still: () => here()?.still === true,
    stop() { stopped = true; },
  };
}
