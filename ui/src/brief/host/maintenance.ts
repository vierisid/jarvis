import { ROOM_KEYS, type RoomKey } from '../../v2/router';
/** Native panels and standalone views keep their existing root. */
export function maintenanceRoom(href: string): RoomKey | null {
  const url = new URL(href);
  if (url.searchParams.has('onboarding') || url.searchParams.get('briefMaintenance') !== '1') return null;
  const match = /^#\/_room_([a-z_]+)$/.exec(url.hash);
  return match && ROOM_KEYS.has(match[1] as RoomKey) ? match[1] as RoomKey : null;
}
