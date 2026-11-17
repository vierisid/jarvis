import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';

let drawInstalledCard: (typeof import('./card.ts'))['drawInstalledCard'];
let isInstalledCard: (typeof import('./card.ts'))['isInstalledCard'];

beforeAll(async () => {
  GlobalRegistrator.register();
  ({ drawInstalledCard, isInstalledCard } = await import('./card.ts'));
});
afterAll(() => GlobalRegistrator.unregister());

describe('the card that says it is installed', () => {
  test('says the new name and where it lives, and nothing else', () => {
    const root = document.createElement('div');
    drawInstalledCard(root);
    expect(root.querySelector('b')?.textContent).toBe('Pillow is installed.');
    expect(root.querySelector('span')?.textContent).toBe('It lives at the top of your screen.');
    // The owner: "Don't say look up. Don't use Jarvis as the name."
    expect(root.textContent).not.toMatch(/look up/i);
    expect(root.textContent).not.toMatch(/jarvis/i);
    expect(root.classList.contains('pillow-card')).toBe(true);
  });

  test('its mark is the brand\'s own picture, shown as a picture', () => {
    const root = document.createElement('div');
    drawInstalledCard(root);
    const mark = root.querySelector<HTMLImageElement>('.tile img');
    expect(mark?.getAttribute('src')?.startsWith('data:image/png;base64,iVBOR')).toBe(true);
    expect(root.querySelectorAll('svg, script').length).toBe(0);
  });

  test('the page is the card only when it was opened to be one', () => {
    expect(isInstalledCard('?card=installed')).toBe(true);
    expect(isInstalledCard('?card=installed&token=abc')).toBe(true);
    expect(isInstalledCard('')).toBe(false);
    expect(isInstalledCard('?card=other')).toBe(false);
  });
});
