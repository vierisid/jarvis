import { describe, expect, test } from 'bun:test';
import { peersEnginePath, peersOn, peersSourcePath } from './switch.ts';

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

  test('on with no engine yet, by its own name', () => {
    expect(peersOn({})).toBe(false);
    expect(peersOn({ JARVIS_PEERS: '0' })).toBe(false);
    expect(peersOn({ JARVIS_PEERS: 'yes' })).toBe(false);
    expect(peersOn({ JARVIS_PEERS: '1' })).toBe(true);
    expect(peersOn({ JARVIS_PEERS_ENGINE: '/opt/collab/collab-claude' })).toBe(true);
  });

  test('the source of the engine is a full path or nothing', () => {
    expect(peersSourcePath({})).toBeNull();
    expect(peersSourcePath({ JARVIS_PEERS_SOURCE: 'collab' })).toBeNull();
    expect(peersSourcePath({ JARVIS_PEERS_SOURCE: ' /home/sam/collab ' })).toBe('/home/sam/collab');
  });
});
