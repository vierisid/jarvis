import { FOREGROUND_ALIASES } from '../entry/release-route';
import { briefHash } from '../entry/route';
/** Used only by the separate local bundle, including native first-run URLs. */
export function localIntegrationHref(href: string): string {
  const url = new URL(href);
  if (url.searchParams.get('briefMaintenance') === '1' || url.searchParams.get('brief') === '0') return href;
  const hash = url.hash || '#/';
  const room = Object.hasOwn(FOREGROUND_ALIASES, hash) ? FOREGROUND_ALIASES[hash as keyof typeof FOREGROUND_ALIASES] : null;
  const firstRun = url.searchParams.has('onboarding');
  if (!room && !firstRun) return href;
  url.searchParams.delete('onboarding'); url.searchParams.set('brief', '1');
  url.hash = briefHash({ room: room ?? 'today', selection: {} });
  return url.href;
}
