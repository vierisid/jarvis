/**
 * #965: the pebble's realtime session answers dashboard_room_action by opening
 * the room only. It used to return just "Opened Settings.", which the model
 * could read as the action it asked for having been done.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { pebbleRoomActionResult } from './realtime-nav-tools.ts';

describe('pebbleRoomActionResult', () => {
  test('says the action was not run, alongside what happened to the room', () => {
    expect(pebbleRoomActionResult('Opened Settings.', 'disable_tts'))
      .toBe('Opened Settings. I did not run "disable_tts" inside it; tell the user it has not been done.');
    expect(pebbleRoomActionResult("I couldn't open Settings.", ''))
      .toBe("I couldn't open Settings. I did not run the action inside it; tell the user it has not been done.");
  });

  test('the pebble realtime path uses it rather than the bare open result', () => {
    const src = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
    const start = src.indexOf("case 'dashboard_room_action':");
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf('case ', start + 10));
    expect(body).toContain('pebbleRoomActionResult(await openRoom(');
  });
});
