/**
 * Quiet hours: inside them nothing arrives.
 *
 * Every evening to every morning by the clock (22:00 to 07:00 unless the
 * person says otherwise), and whenever they say "quiet for an hour". While it
 * is quiet nothing speaks up by itself: it joins the count, and the person can
 * still open the notch and find it there. What has a window already running
 * (a promise about to be kept) is still shown: that is theirs to stop.
 *
 * Kept in the notch's settings, so the hours survive a restart.
 */
import type { NotchBlock, NotchButton, NotchPart } from './protocol.ts';
import type { NotchSettings } from './settings.ts';

export interface NotchQuietHours {
  /** Minutes after midnight, on this machine's clock. Equal: no quiet hours. */
  from: number;
  to: number;
}

export const NOTCH_QUIET_DEFAULT: NotchQuietHours = { from: 22 * 60, to: 7 * 60 };
/** How long "quiet for an hour" is. */
export const NOTCH_QUIET_NOW_MS = 60 * 60 * 1000;
/** The times the person can pick for each end, as the notch offers them. */
export const NOTCH_QUIET_FROM = ['20:00', '21:00', '22:00', '23:00', '00:00'];
export const NOTCH_QUIET_TO = ['05:00', '06:00', '07:00', '08:00', '09:00'];

const HOURS = 'quiet.hours';
const UNTIL = 'quiet.until';

/** "22:00" as minutes after midnight, or null when it is not a time. "22", "22.30" and "7:5" are read too. */
export function notchClockMinutes(text: string): number | null {
  const found = /^\s*(\d{1,2})(?:[:.h](\d{1,2}))?\s*$/.exec(text);
  if (!found) return null;
  const hour = Number(found[1]);
  const minute = Number(found[2] ?? 0);
  return hour < 24 && minute < 60 ? hour * 60 + minute : null;
}

export const notchClockText = (minutes: number): string => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

/** Whether a moment is inside the hours. Hours that cross midnight (22:00 to 07:00) are one night. */
export function notchQuietAt(hours: NotchQuietHours, at: number): boolean {
  if (hours.from === hours.to) return false;
  const day = new Date(at);
  const minute = day.getHours() * 60 + day.getMinutes();
  return hours.from < hours.to ? minute >= hours.from && minute < hours.to : minute >= hours.from || minute < hours.to;
}

export class NotchQuiet {
  constructor(private readonly settings: NotchSettings, private readonly clock: () => number = Date.now) {}

  hours(): NotchQuietHours {
    const kept = this.settings.get<Partial<NotchQuietHours> | null>(HOURS, null);
    const ok = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < 24 * 60;
    return kept && ok(kept.from) && ok(kept.to) ? { from: kept.from, to: kept.to } : NOTCH_QUIET_DEFAULT;
  }

  setHours(hours: NotchQuietHours): void {
    this.settings.set(HOURS, hours, this.clock());
  }

  /** The moment "quiet for an hour" ends, or null when it is not on. */
  until(): number | null {
    const until = this.settings.get<number | null>(UNTIL, null);
    return typeof until === 'number' && until > this.clock() ? until : null;
  }

  /** Quiet from now for a while, whatever the hours say. */
  quietFor(ms = NOTCH_QUIET_NOW_MS): number {
    const until = this.clock() + ms;
    this.settings.set(UNTIL, until, this.clock());
    return until;
  }

  /** Ends "quiet for an hour" early. The hours by the clock are not changed. */
  end(): void {
    this.settings.set(UNTIL, null, this.clock());
  }

  /** Whether it is quiet now. */
  now(): boolean {
    return this.until() !== null || notchQuietAt(this.hours(), this.clock());
  }
}

/** What Home shows of the quiet hours, and what it does with what the person changes there. */
export interface NotchQuietHome {
  /** One line: the hours, each end a word that can be changed, or until when it is quiet now. */
  note(): NotchBlock;
  /** "Quiet for an hour", or "End quiet" while that is on. */
  button(): NotchButton;
  /** A lit word was changed. True when it was one of these and the value was a time. */
  word(name: string, value: string): boolean;
  /** The button was pressed. True when it was this one. */
  press(id: string): boolean;
}

export const NOTCH_QUIET_BUTTON = 'quiet';

export function notchQuietHome(quiet: NotchQuiet, changed: () => void = () => {}): NotchQuietHome {
  const lit = (name: string, minutes: number, options: string[], label: string): NotchPart => {
    const value = notchClockText(minutes);
    return { word: { name, value, options: options.includes(value) ? options : [value, ...options], label, free: true } };
  };
  return {
    note() {
      const until = quiet.until();
      if (until !== null) {
        const at = new Date(until);
        return { kind: 'note', say: ['Quiet until ', { em: notchClockText(at.getHours() * 60 + at.getMinutes()) }, '. Nothing arrives.'] };
      }
      const hours = quiet.hours();
      return { kind: 'note', say: ['Quiet from ', lit('quiet-from', hours.from, NOTCH_QUIET_FROM, 'Quiet from'), ' to ', lit('quiet-to', hours.to, NOTCH_QUIET_TO, 'Quiet until'), '.'] };
    },
    button: () => ({ id: NOTCH_QUIET_BUTTON, label: quiet.until() !== null ? 'End quiet' : 'Quiet for an hour', quiet: true }),
    word(name, value) {
      if (name !== 'quiet-from' && name !== 'quiet-to') return false;
      const minutes = notchClockMinutes(value);
      if (minutes === null) return false;
      const hours = quiet.hours();
      quiet.setHours(name === 'quiet-from' ? { ...hours, from: minutes } : { ...hours, to: minutes });
      changed();
      return true;
    },
    press(id) {
      if (id !== NOTCH_QUIET_BUTTON) return false;
      if (quiet.until() !== null) quiet.end(); else quiet.quietFor();
      changed();
      return true;
    },
  };
}

