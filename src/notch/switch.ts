/**
 * The notch switch.
 *
 * The notch is a desktop surface that is still being built. Until it is
 * finished it ships dark: with the switch off the brain sends no `notch.*`
 * message to any desktop app, so an installed product behaves exactly as it
 * did before this code existed. docs/notch/README.md states the invariant.
 *
 * On only for the exact value "1", like the JARVIS_BRIEF_* switches. Anything
 * else is off, including "true" and "yes": a typo must not turn a dark feature
 * on.
 */
export const NOTCH_SWITCH = 'JARVIS_NOTCH';

export function notchEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env[NOTCH_SWITCH] === '1';
}
