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
import type { NotchInbox } from './inbox.ts';
import type { NotchSurface } from './surface.ts';

export interface NotchPauseDeps {
  controller: {
    getState(): EmergencyState;
    pause(): void;
    resume(): void;
    subscribe(listener: (state: EmergencyState) => void): () => void;
  };
  log?: (line: string) => void;
}

const HOLD = 'stopped';

export function attachNotchPause(surface: NotchSurface, inbox: NotchInbox, deps: NotchPauseDeps): () => void {
  const log = deps.log ?? ((line: string) => console.log(line));
  let shown: EmergencyState = 'normal';

  const apply = (state: EmergencyState, tell: boolean): void => {
    const was = shown;
    shown = state;
    if (state === 'normal') {
      inbox.release(HOLD);
      inbox.setOpener(null);
      surface.setFace('idle');
      if (tell && was !== 'normal') {
        surface.act({ gesture: 'wake' });
        inbox.present('awake', (stage) => stage.say(['Awake. Going on from where things were.'], 2200, { mood: 'idle' }));
      }
      return;
    }
    // Whatever is on the notch goes back to the count, and nothing speaks up.
    inbox.hold(HOLD);
    surface.setFace('closed');
    if (state === 'paused') {
      inbox.setOpener(() => {
        log('[notch] woken from the notch: resuming');
        deps.controller.resume();
        return true;
      });
      if (tell) {
        surface.act({ gesture: 'shake' });
        inbox.present('stopped', (stage) => stage.say(['Everything is stopped. Nothing runs until you wake me.'], 3600, { mood: 'closed' }));
      }
      return;
    }
    // Killed. A yes at rest says what this is, and wakes nothing.
    const explain = (): boolean => {
      inbox.present('killed', (stage) => stage.say(['Stopped with Kill. Reset it in the dashboard, under Authority.'], 4200, { mood: 'closed' }));
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
