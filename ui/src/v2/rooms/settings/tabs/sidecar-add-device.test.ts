import { describe, expect, test } from 'bun:test';
import { addDeviceMode, noDevicesCopy } from './sidecar-add-device.ts';

/**
 * The decision behind which "add a device" section renders. Getting it wrong in
 * the hosted direction shows instructions to copy a token that the daemon will
 * refuse to mint; getting it wrong in the self-hosted direction hides the only
 * way that user can add a device at all.
 */
describe('addDeviceMode', () => {
  test('hosted when the daemon says the install is hosted', () => {
    expect(addDeviceMode({ hosted_install: true })).toBe('hosted');
  });

  test('self-hosted when it says otherwise', () => {
    expect(addDeviceMode({ hosted_install: false })).toBe('self-hosted');
    // Absent means the daemon answered and did not set it: a self-hosted
    // install, not an unknown one.
    expect(addDeviceMode({})).toBe('self-hosted');
  });

  test('unknown while settings are still loading', () => {
    // A third answer, not a default. Defaulting to self-hosted would flash the
    // token instructions at a hosted user before swapping them away. The hook
    // starts this at null, so null is the case that actually occurs.
    expect(addDeviceMode(null)).toBe('unknown');
    expect(addDeviceMode(undefined)).toBe('unknown');
  });

  test('only an exact true counts as hosted', () => {
    // The field is a strict boolean contract across the wire. Anything else is
    // a daemon whose shape changed, and falling back to the form is the safe
    // direction: the server still gates it, so the worst case is a refusal the
    // user can read rather than a hidden control.
    expect(addDeviceMode({ hosted_install: "yes" } as unknown as { hosted_install?: boolean })).toBe(
      'self-hosted',
    );
  });
});

describe('noDevicesCopy', () => {
  test('never points at a control the user cannot see', () => {
    // "Enroll one above" is true only where there is a form above.
    expect(noDevicesCopy('self-hosted')).toContain('above');
    expect(noDevicesCopy('hosted')).not.toContain('above');
    expect(noDevicesCopy('unknown')).not.toContain('above');
  });

  test('tells a hosted user what actually adds a device', () => {
    expect(noDevicesCopy('hosted')).toContain('sign in');
  });
});
