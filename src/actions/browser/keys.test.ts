import { describe, test, expect } from 'bun:test';
import { parseKeyCombo } from './keys.ts';

describe('parseKeyCombo', () => {
  test('plain named keys', () => {
    expect(parseKeyCombo('Enter')).toMatchObject({
      key: 'Enter', code: 'Enter', keyCode: 13, modifiers: 0, text: '\r', display: 'Enter',
    });
    expect(parseKeyCombo('escape')).toMatchObject({ key: 'Escape', keyCode: 27, modifiers: 0 });
    expect(parseKeyCombo('ESC')).toMatchObject({ key: 'Escape' });
    expect(parseKeyCombo('Tab')).toMatchObject({ key: 'Tab', keyCode: 9 });
    expect(parseKeyCombo('Tab')!.text).toBeUndefined();
    expect(parseKeyCombo('ArrowDown')).toMatchObject({ key: 'ArrowDown', keyCode: 40 });
    expect(parseKeyCombo('down')).toMatchObject({ key: 'ArrowDown' });
    expect(parseKeyCombo('PageUp')).toMatchObject({ key: 'PageUp', keyCode: 33 });
    expect(parseKeyCombo('F5')).toMatchObject({ key: 'F5', keyCode: 116 });
  });

  test('single characters', () => {
    expect(parseKeyCombo('a')).toMatchObject({ key: 'a', code: 'KeyA', keyCode: 65, text: 'a' });
    expect(parseKeyCombo('K')).toMatchObject({ key: 'k', code: 'KeyK', keyCode: 75 });
    expect(parseKeyCombo('7')).toMatchObject({ key: '7', code: 'Digit7', keyCode: 55, text: '7' });
    expect(parseKeyCombo('/')).toMatchObject({ key: '/', code: 'Slash', text: '/' });
    expect(parseKeyCombo('@')).toMatchObject({ key: '@', text: '@' });
  });

  test('modifier combos', () => {
    expect(parseKeyCombo('Ctrl+K')).toMatchObject({
      key: 'k', code: 'KeyK', modifiers: 2, display: 'Ctrl+K',
    });
    expect(parseKeyCombo('Ctrl+K')!.text).toBeUndefined(); // ctrl suppresses text
    expect(parseKeyCombo('Shift+Enter')).toMatchObject({ key: 'Enter', modifiers: 8 });
    expect(parseKeyCombo('Ctrl+Shift+M')).toMatchObject({ modifiers: 10, display: 'Ctrl+Shift+M' });
    expect(parseKeyCombo('Alt+/')).toMatchObject({ key: '/', modifiers: 1 });
    expect(parseKeyCombo('control+shift+m')).toMatchObject({ modifiers: 10 });
    expect(parseKeyCombo('Cmd+A')).toMatchObject({ modifiers: 4 });
    expect(parseKeyCombo('Meta+A')).toMatchObject({ modifiers: 4 });
  });

  test('shift on a letter produces the uppercase character', () => {
    const parsed = parseKeyCombo('Shift+a')!;
    expect(parsed.key).toBe('A');
    expect(parsed.text).toBe('A');
  });

  test('duplicate modifiers collapse', () => {
    expect(parseKeyCombo('Ctrl+Control+K')).toMatchObject({ modifiers: 2 });
  });

  test('unsupported input returns null', () => {
    expect(parseKeyCombo('')).toBeNull();
    expect(parseKeyCombo('NotAKey')).toBeNull();
    expect(parseKeyCombo('Ctrl+')).toBeNull();
    expect(parseKeyCombo('Foo+K')).toBeNull();
    expect(parseKeyCombo('Ctrl++')).toBeNull();
  });

  test('space', () => {
    expect(parseKeyCombo('Space')).toMatchObject({ key: ' ', code: 'Space', text: ' ', display: 'Space' });
  });
});
