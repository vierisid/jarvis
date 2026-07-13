/**
 * Keyboard combo parsing for browser_press_key.
 *
 * Turns a combo string like "Enter", "Escape", "Ctrl+K", "Shift+Enter",
 * "Ctrl+Shift+M" or "ArrowDown" into the fields a CDP Input.dispatchKeyEvent
 * call needs. Pure module so it can be unit-tested without a browser.
 */

// CDP modifier bitmask: Alt=1, Ctrl=2, Meta=4, Shift=8
const MODIFIER_BITS: Record<string, number> = {
  alt: 1,
  option: 1,
  opt: 1,
  ctrl: 2,
  control: 2,
  meta: 4,
  cmd: 4,
  command: 4,
  win: 4,
  shift: 8,
};

export type ParsedKey = {
  key: string;      // DOM KeyboardEvent.key
  code: string;     // DOM KeyboardEvent.code
  keyCode: number;  // legacy virtual key code (windowsVirtualKeyCode)
  modifiers: number; // CDP modifier bitmask
  text?: string;    // text produced by the key (printable, no ctrl/alt/meta)
  display: string;  // normalized combo for the tool result message
};

type KeyDef = { key: string; code: string; keyCode: number; text?: string };

const NAMED_KEYS: Record<string, KeyDef> = {
  enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  esc: { key: 'Escape', code: 'Escape', keyCode: 27 },
  backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  del: { key: 'Delete', code: 'Delete', keyCode: 46 },
  space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  up: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  down: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  left: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  right: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  home: { key: 'Home', code: 'Home', keyCode: 36 },
  end: { key: 'End', code: 'End', keyCode: 35 },
  pageup: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  pagedown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
};

// Punctuation that appears in web-app shortcuts (Slack /, Gmail ?, Notion @ ...)
const PUNCT_KEYS: Record<string, KeyDef> = {
  '/': { key: '/', code: 'Slash', keyCode: 191, text: '/' },
  '.': { key: '.', code: 'Period', keyCode: 190, text: '.' },
  ',': { key: ',', code: 'Comma', keyCode: 188, text: ',' },
  ';': { key: ';', code: 'Semicolon', keyCode: 186, text: ';' },
  "'": { key: "'", code: 'Quote', keyCode: 222, text: "'" },
  '[': { key: '[', code: 'BracketLeft', keyCode: 219, text: '[' },
  ']': { key: ']', code: 'BracketRight', keyCode: 221, text: ']' },
  '\\': { key: '\\', code: 'Backslash', keyCode: 220, text: '\\' },
  '`': { key: '`', code: 'Backquote', keyCode: 192, text: '`' },
  '-': { key: '-', code: 'Minus', keyCode: 189, text: '-' },
  '=': { key: '=', code: 'Equal', keyCode: 187, text: '=' },
  '?': { key: '?', code: 'Slash', keyCode: 191, text: '?' },
  '@': { key: '@', code: 'Digit2', keyCode: 50, text: '@' },
  '#': { key: '#', code: 'Digit3', keyCode: 51, text: '#' },
};

for (let i = 1; i <= 12; i++) {
  NAMED_KEYS[`f${i}`] = { key: `F${i}`, code: `F${i}`, keyCode: 111 + i };
}

function baseKeyDef(name: string): KeyDef | null {
  const lower = name.toLowerCase();
  if (NAMED_KEYS[lower]) return NAMED_KEYS[lower];
  if (name.length === 1) {
    if (/[a-z]/i.test(name)) {
      const lc = name.toLowerCase();
      return { key: lc, code: `Key${lc.toUpperCase()}`, keyCode: lc.toUpperCase().charCodeAt(0), text: lc };
    }
    if (/[0-9]/.test(name)) {
      return { key: name, code: `Digit${name}`, keyCode: name.charCodeAt(0), text: name };
    }
    if (PUNCT_KEYS[name]) return PUNCT_KEYS[name];
  }
  return null;
}

/**
 * Parse a combo like "Ctrl+Shift+M". The last "+"-separated part is the key,
 * everything before it must be modifiers. Returns null for unsupported keys.
 * "+" itself is expressible as the final char: "Ctrl++" is not supported —
 * use "Ctrl+=" with Shift instead.
 */
export function parseKeyCombo(combo: string): ParsedKey | null {
  const trimmed = combo.trim();
  if (!trimmed) return null;

  const parts = trimmed.split('+');
  // A trailing "+" (e.g. "Ctrl++") produces empty parts — reject.
  if (parts.some(p => p === '')) return null;

  const keyName = parts[parts.length - 1]!;
  const modNames = parts.slice(0, -1);

  let modifiers = 0;
  const displayMods: string[] = [];
  for (const m of modNames) {
    const bit = MODIFIER_BITS[m.toLowerCase()];
    if (!bit) return null;
    if (!(modifiers & bit)) {
      modifiers |= bit;
      displayMods.push(bit === 1 ? 'Alt' : bit === 2 ? 'Ctrl' : bit === 4 ? 'Meta' : 'Shift');
    }
  }

  const def = baseKeyDef(keyName);
  if (!def) return null;

  let key = def.key;
  let text = def.text;

  // Shift on a letter produces the uppercase character
  if (modifiers & 8 && key.length === 1 && /[a-z]/.test(key)) {
    key = key.toUpperCase();
    text = key;
  }
  // Ctrl/Alt/Meta suppress text production (the app sees a shortcut, not typing)
  if (modifiers & (1 | 2 | 4)) {
    text = undefined;
  }

  return {
    key,
    code: def.code,
    keyCode: def.keyCode,
    modifiers,
    text,
    display: [...displayMods, def.key === ' ' ? 'Space' : key.length === 1 ? key.toUpperCase() : key].join('+'),
  };
}

/** Keys/combos we accept, for the tool description and error messages. */
export const SUPPORTED_KEYS_HINT =
  'Enter, Tab, Escape, Backspace, Delete, Space, ArrowUp/Down/Left/Right, Home, End, PageUp, PageDown, F1-F12, letters, digits, common punctuation — optionally prefixed with Ctrl+/Alt+/Shift+/Meta+ (e.g. "Ctrl+K", "Shift+Enter")';
