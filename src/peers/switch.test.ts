import { describe, expect, test } from 'bun:test';
import { peersEnginePath } from './switch.ts';

describe('the switch for other people\'s Jarvises', () => {
  test('off unless the engine\'s place is given in full', () => {
    expect(peersEnginePath({})).toBeNull();
    expect(peersEnginePath({ JARVIS_PEERS_ENGINE: '' })).toBeNull();
    expect(peersEnginePath({ JARVIS_PEERS_ENGINE: '1' })).toBeNull();
    expect(peersEnginePath({ JARVIS_PEERS_ENGINE: 'collab-claude' })).toBeNull();
    expect(peersEnginePath({ JARVIS_PEERS_ENGINE: './bin/collab-claude' })).toBeNull();
  });

  test('on with a full path', () => {
    expect(peersEnginePath({ JARVIS_PEERS_ENGINE: ' /opt/collab/collab-claude ' })).toBe('/opt/collab/collab-claude');
  });
});
