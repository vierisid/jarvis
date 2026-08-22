/**
 * D1 at the config layer: realtime voice is ON and not rationed for the length
 * of the trial.
 *
 * Realtime ships OFF by default with a 10-minute session cap
 * (`src/config/types.ts`), which is the right default for everyone who is not
 * in a trial and exactly wrong for the one experience the whole product is
 * selling. Rather than WRITE those values into the user's stored voice settings
 * — which would outlive the trial and silently leave a lapsed user's mic wired
 * to a session cap they never chose — the trial applies them as an OVERLAY,
 * per resolve, at the moment a conductor session is opened.
 *
 * The contract that makes this safe to land: with no running trial this returns
 * THE SAME OBJECT it was handed. Not a clone, not an equal object — the same
 * reference. Everyone who is not in a trial resolves realtime from a config
 * this module has provably not touched.
 */

import type { JarvisConfig } from '../config/types.ts';
import { isTrialRunning, type TrialEntitlement } from './entitlement.ts';

/**
 * Apply the trial's realtime grant over a config, or hand the config straight
 * back when no trial is running.
 *
 * What it deliberately does NOT touch:
 *
 *  - `monthly_budget_usd`. D1 removes OUR rationing of the trial; it does not
 *    authorise spending a founder's own OpenAI credit past a ceiling they set
 *    themselves. On the hosted path the field is already unset (the proxy is
 *    the billing authority), so this costs the intended experience nothing.
 *  - `blocked_categories`. The destructive-impact backstop stays exactly as it
 *    is. Nothing in the opening is destructive, and quietly widening what an
 *    open mic may execute is not something the trial needs or the design asked
 *    for.
 */
export function withTrialRealtime(
  config: JarvisConfig,
  entitlement: TrialEntitlement | null,
  now = Date.now(),
): JarvisConfig {
  if (!isTrialRunning(entitlement, now)) return config;
  const grant = entitlement!.realtime;
  if (!grant.enabled) return config;

  return {
    ...config,
    voice: {
      ...(config.voice ?? { wake_engine: 'openwakeword' as const }),
      realtime: {
        ...(config.voice?.realtime ?? { enabled: false }),
        enabled: true,
        max_session_minutes: grant.max_session_minutes,
      },
    },
  };
}
