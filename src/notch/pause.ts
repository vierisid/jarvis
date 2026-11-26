/**
 * Esc twice: everything is stopped until the person wakes Jarvis.
 *
 * Esc twice pauses. It does not kill: nothing is thrown away, and waking
 * carries on from where things were. The pause is the product's own
 * (authority/emergency.ts), the one the tray's "Pause Jarvis" drives, so the
 * tray, the dashboard and the notch always agree: whichever of them pauses
 * or resumes, the notch shows it.
 *
 * While paused the notch rests with its eyes closed and says nothing by
 * itself. What arrives joins the count. A yes or a click on the resting notch
 * wakes it.
 *
 * Stopped with Kill is not a pause, and the notch cannot undo it: nothing
 * that was stopped comes back, so waking would promise something untrue. The
 * notch says where it is reset.
 */
import type { EmergencyState } from '../authority/emergency.ts';
import type { NotchFeatureDef } from './feature.ts';
import type { NotchInbox } from './inbox.ts';
import type { NotchIntent, NotchIntentSource } from './intents.ts';
import type { NotchMood } from './protocol.ts';
import type { NotchSurface } from './surface.ts';

export interface NotchPauseDeps {
  controller: {
    getState(): EmergencyState;
    pause(): void;
    resume(): void;
    subscribe(listener: (state: EmergencyState) => void): () => void;
  };
  /**
   * The face the notch has at rest when it is awake. It is not always open
   * eyes: it may be looking away, or not watching the app in front
   * (where.ts). Open eyes when not given.
   */
  restFace?: () => NotchMood;
  /** Told after the notch has gone to sleep or woken, so that what depends on it can follow. */
  changed?: () => void;
  log?: (line: string) => void;
}

const HOLD = 'stopped';

/**
 * "Pause", said or typed, and nothing else in the sentence: everything is stopped, as with Esc twice. English
 * and Italian. "Pause the music" and "stop" are not this: the first is an instruction, and whether "stop" is a
 * control word is not decided.
 */
export function pauseWord(text: string): boolean {
  return /^(?:(?:ok(?:ay)?|hey|jarvis|pillow|please|now)[,\s]+)*(?:pause|pause (?:everything|it all|jarvis|pillow|yourself)|pausa|pausa tutto|metti(?:ti)? in pausa)(?:[,\s]+(?:please|now|per favore))?[\s.!]*$/i.test(text.trim());
}

/**
 * The control word as an intent of the one table (./intents.ts). It stands before everything else, needs no
 * model, and is still asked when the words are the reply to a question. When everything is stopped already it
 * takes nothing: what is said then is turned away where it arrives, with "Wake me first".
 */
export function notchPauseWords(controller: Pick<NotchPauseDeps['controller'], 'getState' | 'pause'>, log: (line: string) => void = (line) => console.log(line)): NotchIntentSource {
  const intents: NotchIntent[] = [{
    id: 'pause.all', feature: 'pause', says: 'stop everything until I wake you, as Esc twice does', band: 'control', act: 'none', first: 'acts',
    examples: ['pause', 'pausa'],
    never: ['pause the music', 'pause for a second and think about it', 'stop'],
    // While its context is up, a draft or day one takes whatever is said: this word is taken from them.
    over: ['dayone.answer', 'mail.steer', 'said.answer'],
    inReply: true,
    match(text) {
      if (!pauseWord(text) || controller.getState() !== 'normal') return null;
      return { did: 'Stopped everything.', run: () => { log('[notch] "pause" was said or typed: pausing everything'); controller.pause(); } };
    },
  }];
  return { intents: () => intents };
}

export function attachNotchPause(surface: Pick<NotchSurface, 'onStop' | 'setFace' | 'act'>, inbox: NotchInbox, deps: NotchPauseDeps): () => void {
  const log = deps.log ?? ((line: string) => console.log(line));
  let shown: EmergencyState = 'normal';

  const apply = (state: EmergencyState, tell: boolean): void => {
    const was = shown;
    shown = state;
    if (state === 'normal') {
      inbox.release(HOLD);
      inbox.setOpener(null);
      surface.setFace(deps.restFace?.() ?? 'idle');
      if (tell && was !== 'normal') {
        surface.act({ gesture: 'wake' });
        inbox.present('awake', (stage) => stage.say(['Awake. Going on from where things were.'], 2200, { mood: 'idle' }));
      }
      deps.changed?.();
      return;
    }
    // Whatever is on the notch goes back to the count, and nothing speaks up.
    inbox.hold(HOLD);
    surface.setFace('closed');
    deps.changed?.();
    if (state === 'paused') {
      inbox.setOpener(() => {
        log('[notch] woken from the notch: resuming');
        deps.controller.resume();
        return true;
      });
      if (tell) {
        // It shakes for the stop, and zips its lip: it will stay quiet.
        surface.act({ gesture: 'shake', lip: 'zip' });
        inbox.present('stopped', (stage) => stage.say(['Everything is stopped. Nothing runs until you wake me.'], 3600, { mood: 'closed' }), { held: true });
      }
      return;
    }
    // Killed. A yes at rest says what this is, and wakes nothing.
    const explain = (): boolean => {
      inbox.present('killed', (stage) => stage.say(['Stopped with Kill. Reset it in the dashboard, under Authority.'], 4200, { mood: 'closed' }), { held: true });
      return true;
    };
    inbox.setOpener(explain);
    if (tell) explain();
  };

  const offStop = surface.onStop(() => {
    const state = deps.controller.getState();
    if (state === 'normal') {
      log('[notch] Esc twice: pausing everything');
      deps.controller.pause();
      return;
    }
    // Already stopped: say so again, so the keys are seen to have landed.
    apply(state, true);
  });
  const offState = deps.controller.subscribe((state) => apply(state, true));
  // The state as it stands: a brain that starts paused shows closed eyes and
  // says nothing about it.
  apply(deps.controller.getState(), false);

  return () => { offStop(); offState(); };
}

/**
 * Esc twice as a feature of the notch (./feature.ts): it hears the keys and
 * the product's pause until it is stopped. Absent on a brain that was not
 * given the pause. With the part that knows where the person is, the face at
 * rest is that part's, and it is told when the notch goes to sleep or wakes.
 */
export function notchPauseFeature(controller: NotchPauseDeps['controller'] | undefined): NotchFeatureDef<'pause'> {
  return {
    id: 'pause',
    wants: ['where'],
    make(ctx) {
      if (!controller) return null;
      const where = ctx.use('where');
      const stop = attachNotchPause(ctx.surface, ctx.inbox, {
        controller,
        restFace: where ? () => where.face() : undefined,
        changed: where ? () => where.refresh() : undefined,
        log: ctx.log,
      });
      return { api: {}, stop };
    },
  };
}
