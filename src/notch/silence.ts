/**
 * Nothing is spoken back while the notch is on.
 *
 * With the switch on, Jarvis answers in writing on the notch and in the
 * dashboard, and never out loud: not a reply, not a confirmation, not a
 * suggestion, not live voice. It also does not listen for its name: the talk
 * keys are the only way to speak to it. This is the one question every place
 * that could speak or listen asks, so the rule is in one place.
 *
 * It does not turn the speech settings off or take the provider away: the
 * dashboard's own "preview this voice" still plays, a dashboard message sent
 * with "speak" is still accepted (and answered in text), and with the switch
 * off everything speaks as it did.
 */
import { notchEnabled } from './switch.ts';

export function notchSilent(env: Record<string, string | undefined> = process.env): boolean {
  return notchEnabled(env);
}
