/**
 * Sound: six tiny cues made with oscillators, no files. Off until the brain
 * switches them on.
 */

export type Sfx = 'yes' | 'done' | 'no' | 'fail' | 'launch' | 'tick';

export interface Sounds {
  sfx(kind: Sfx): void;
  set(on: boolean): void;
  stop(): void;
}

type AudioCtor = new () => AudioContext;

export function createSounds(): Sounds {
  let ac: AudioContext | null = null, on = false;
  const tone = (ctx: AudioContext, t: number, f: number, d: number, at = 0, type: OscillatorType = 'sine', g = .05) => {
    const o = ctx.createOscillator(), v = ctx.createGain();
    o.type = type; o.frequency.value = f;
    v.gain.setValueAtTime(0.0001, t + at); v.gain.linearRampToValueAtTime(g, t + at + .008); v.gain.exponentialRampToValueAtTime(.0001, t + at + d);
    o.connect(v).connect(ctx.destination); o.start(t + at); o.stop(t + at + d + .03);
  };
  return {
    sfx(kind) {
      if (!on) return;
      try {
        if (!ac) {
          const w = window as unknown as { AudioContext?: AudioCtor; webkitAudioContext?: AudioCtor };
          const Ctor = w.AudioContext ?? w.webkitAudioContext;
          if (!Ctor) return;
          ac = new Ctor();
        }
        const ctx = ac, t = ctx.currentTime;
        if (kind === 'yes') tone(ctx, t, 520, .09);
        else if (kind === 'done') { tone(ctx, t, 660, .12); tone(ctx, t, 880, .18, .09); }
        else if (kind === 'no') tone(ctx, t, 300, .1, 0, 'sine', .04);
        else if (kind === 'fail') { tone(ctx, t, 330, .14); tone(ctx, t, 247, .22, .1); }
        else if (kind === 'launch') tone(ctx, t, 740, .08, 0, 'triangle', .03);
        else tone(ctx, t, 1300, .018, 0, 'square', .01);
      } catch { /* no audio here; stay silent */ }
    },
    set(next) { on = next; },
    stop() { on = false; if (ac) { void ac.close().catch(() => {}); ac = null; } },
  };
}
