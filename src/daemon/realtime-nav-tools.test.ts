/**
 * #965: the pebble's realtime session answers dashboard_room_action by opening
 * the room only. It used to return just "Opened Settings.", which the model
 * could read as the action it asked for having been done.
 */

import { describe, expect, test } from 'bun:test';
import { pebbleRoomActionResult } from './realtime-nav-tools.ts';

describe('pebbleRoomActionResult', () => {
  test('says the action was not run, alongside what happened to the room', () => {
    expect(pebbleRoomActionResult('Opened Settings.', 'disable_tts'))
      .toBe('Opened Settings. I did not run "disable_tts" inside it; tell the user it has not been done.');
    expect(pebbleRoomActionResult("I couldn't open Settings.", ''))
      .toBe("I couldn't open Settings. I did not run the action inside it; tell the user it has not been done.");
  });

});
