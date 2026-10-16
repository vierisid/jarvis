import type { Case } from './matrix';
import { blockReason } from './report';
import type { Candidate, Row } from './report';
import type { Inventory } from './discovery';
// The caller supplies a documented CUA tab/viewport and an artifact writer.
// Browser code only reads the DOM; interaction uses locators and native keyboard.
export async function inspect(tab: any) {
  return tab.playwright.evaluate(() => {
    const scene = document.querySelector('[data-u11-scene]') as HTMLElement | null;
    const visible = (element: Element) => {
      if (element.closest('[hidden],[inert],[aria-hidden="true"]')) return false;
      for (let node: Element | null = element; node; node = node.parentElement) { const s = getComputedStyle(node); if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false; }
      return element.getClientRects().length > 0;
    };
    const name = (element: Element) => (element.getAttribute('aria-label') || (element.getAttribute('aria-labelledby') ?? '').split(/\s+/).map(id => document.getElementById(id)?.textContent ?? '').join(' ').trim()
      || [...((element as HTMLInputElement).labels ?? [])].map(label => label.textContent).join(' ') || element.textContent || element.getAttribute('title') || '').trim();
    const controls = [...(scene?.querySelectorAll('button,a[href],input:not([type=hidden]),textarea,select,summary,[role=button],[tabindex="0"]') ?? [])].filter(visible);
    const clipped = controls.filter(element => {
      const r = element.getBoundingClientRect();
      if (r.width < 1 || r.height < 1 || r.left < -2 || r.right > innerWidth + 2) return true;
      let scrollX = false, scrollY = false;
      for (let parent = element.parentElement; parent; parent = parent.parentElement) {
        const s = getComputedStyle(parent), b = parent.getBoundingClientRect();
        if (!scrollX && ['hidden','clip'].includes(s.overflowX) && (r.left < b.left - 2 || r.right > b.right + 2)) return true;
        if (!scrollY && ['hidden','clip'].includes(s.overflowY) && (r.top < b.top - 2 || r.bottom > b.bottom + 2)) return true;
        scrollX ||= ['auto','scroll'].includes(s.overflowX) && parent.scrollWidth > parent.clientWidth;
        scrollY ||= ['auto','scroll'].includes(s.overflowY) && parent.scrollHeight > parent.clientHeight;
      }
      if (r.top >= 0 && r.bottom <= innerHeight) { const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); if (top && !element.contains(top) && !top.contains(element)) return true; }
      return false;
    }).map(name);
    const card = scene?.querySelector('.on-tour__card,.on-pebble-tour__card');
    const cardStyle = card ? getComputedStyle(card) : null;
    const active = document.activeElement;
    const surface = scene?.querySelector('.brief-pebble-surface');
    const b = surface?.getBoundingClientRect();
    return { revision: document.querySelector('[data-u11-revision]')?.getAttribute('data-u11-revision'), dirty: document.querySelector('[data-u11-dirty]')?.getAttribute('data-u11-dirty'),
      caseId: scene?.dataset.case, view: scene?.dataset.view, state: scene?.dataset.state, sidebar: scene?.dataset.sidebar,
      theme: document.documentElement.dataset.theme, childThemes: [...(scene?.querySelectorAll('[data-theme]') ?? [])].filter(visible).map(n => n.getAttribute('data-theme')),
      width: innerWidth, height: innerHeight, dpr: devicePixelRatio, overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      headings: [...(scene?.querySelectorAll('h1,h2') ?? [])].filter(visible).map(n => n.textContent?.trim()), text: scene?.innerText ?? '',
      controls: controls.map(name), unnamed: controls.filter(c => !name(c)).length, clipped,
      contour: cardStyle ? { shadow: cardStyle.boxShadow, border: cardStyle.borderColor, width: cardStyle.borderWidth } : null,
      reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
      focus: active ? { name: name(active), tag: active.tagName, inside: !!scene?.contains(active), visible: visible(active),
        indicator: active.matches(':focus-visible') && ((parseFloat(getComputedStyle(active).outlineWidth) > 0 && getComputedStyle(active).outlineStyle !== 'none') || getComputedStyle(active).boxShadow !== 'none') } : null,
      pebbleOpen: scene?.querySelector('[data-pebble-open]')?.getAttribute('data-pebble-open'),
      pebbleVisible: !!surface && visible(surface) && !!b && b.width > 0 && b.height > 0 && b.left >= -2 && b.right <= innerWidth + 2,
      buildPhases: [...(scene?.querySelectorAll('.on-build__phase') ?? [])].map(n => n.getAttribute('data-state')),
    };
  });
}
export function problems(test: Case, metrics: Awaited<ReturnType<typeof inspect>>, candidate: Candidate): string[] {
  const errors: string[] = [];
  if (metrics.revision !== candidate.revision || metrics.dirty !== String(candidate.dirty)) errors.push('Served candidate differs from report.');
  if (metrics.caseId !== test.id || metrics.view !== test.view || metrics.state !== test.state || metrics.sidebar !== test.sidebar) errors.push('Wrong view/state/sidebar rendered.');
  if (!metrics.headings.length || !metrics.controls.length) errors.push('Missing actual view headings or controls.');
  if (metrics.width !== test.width || metrics.theme !== test.theme || metrics.childThemes.some((t: string) => t !== test.theme)) errors.push('Wrong viewport or mixed theme.');
  if (metrics.overflow > 2 || metrics.clipped.length) errors.push(`Clipped or obscured controls: ${metrics.clipped.join(', ')}; horizontal overflow ${metrics.overflow}px.`);
  if (metrics.unnamed) errors.push('Interactive controls lack accessible names.');
  if (test.view === 'tour' || test.view === 'pebble-tour') {
    const blue = test.theme === 'dark' ? '111, 164, 255' : '45, 120, 255';
    if (!metrics.contour || !JSON.stringify(metrics.contour).includes(blue)) errors.push('Approved blue tutorial contour missing.');
  }
  if (test.view === 'pebble-tour' && test.state === 'open' && (metrics.pebbleOpen !== 'true' || !metrics.pebbleVisible)) errors.push('Open Pebble surface missing/hidden/clipped.');
  if (test.view === 'build' && test.state !== 'saved' && (metrics.text.includes('Your draft is saved.') || metrics.buildPhases.at(-1) === 'complete')) errors.push('Unverified build reports saved success.');
  return errors;
}
export async function runCases(options: { tab: any; viewport: any; baseUrl: string; cases: Case[]; candidate: Candidate; inventory: Inventory; save(path: string, bytes: Uint8Array | string): Promise<{ path: string; sha256: string }>; onResult(row: Row): Promise<void> }) {
  const { tab, viewport, candidate, inventory, save, onResult } = options;
  for (const test of options.cases) {
    const blocked = blockReason(test, inventory);
    if (blocked) { await onResult({ id: test.id, revision: candidate.revision, outcome: 'blocked', reason: blocked, evidence: [] }); continue; }
    if (test.kind === 'journey') throw Error('Use runJourney for journey cases.');
    await viewport.set({ width: test.width, height: test.width === 390 ? 844 : 1000 });
    await tab.goto(`${options.baseUrl}/?case=${encodeURIComponent(test.id)}`);
    await tab.playwright.waitForLoadState({ state: 'load' });
    await tab.playwright.locator('[data-u11-scene]').waitFor({ state: 'visible' });
    await tab.playwright.evaluate(async () => { await document.fonts.ready; return document.fonts.status; });
    await tab.playwright.domSnapshot();
    const metrics = await inspect(tab), errors = problems(test, metrics, candidate), keys: any[] = [];
    if (test.kind === 'keyboard') {
      if (typeof tab.pressKey !== 'function') errors.push('Native keyboard input unavailable.');
      else {
        const total = metrics.controls.length + 2;
        for (let i = 0; i < total; i++) { await tab.pressKey(null, 'Tab'); keys.push((await inspect(tab)).focus); }
        for (let i = 0; i < total; i++) { await tab.pressKey(null, 'shift+Tab'); keys.push((await inspect(tab)).focus); }
        if (!keys.some(k => k?.inside) || !keys.some(k => !k?.inside) || keys.some(k => k?.inside && (!k.visible || !k.indicator))) errors.push('Keyboard traversal did not enter and leave the view with a visible focus indicator.');
      }
    }
    const evidence = [await save(`${test.id}.metrics.json`, JSON.stringify({ candidate, caseId: test.id, metrics, errors, keys }, null, 2)), await save(`${test.id}.ax.txt`, await tab.playwright.domSnapshot()), await save(`${test.id}.png`, await tab.screenshot({ fullPage: true }))];
    await onResult({ id: test.id, revision: candidate.revision, outcome: errors.length ? 'failed' : 'passed', reason: errors.length ? `${test.owner}: ${errors.join(' ')}` : 'Actual view rendered with expected theme/state, named controls, reachable geometry and required contour; synthetic data. This is not visual design or screen-reader approval.', evidence });
  }
}

/** Four UI journeys through the real optional U10 host. Provider responses are
 * synthetic and advanced explicitly; missing D room/canvas bindings stay blocked. */
export async function runJourney(options: { tab: any; viewport: any; baseUrl: string; test: Case; candidate: Candidate; inventory: Inventory; save(path: string, bytes: Uint8Array | string): Promise<{path: string; sha256: string}> }) {
  const { tab, viewport, test, candidate, inventory, save } = options;
  const blocked = blockReason(test, inventory);
  if (blocked) return { id: test.id, revision: candidate.revision, outcome: 'blocked' as const, reason: blocked, evidence: [] };
  await viewport.set({ width: test.width, height: test.width === 390 ? 844 : 1000 });
  await tab.goto(`${options.baseUrl}/?case=${encodeURIComponent(test.id)}`);
  const trace: any[] = [], errors: string[] = [];
  const observe = async (step: string, checkTheme = true) => {
    const snapshot = await tab.playwright.domSnapshot(), metrics = await inspect(tab);
    trace.push({ step, snapshot, metrics });
    if (metrics.revision !== candidate.revision || metrics.dirty !== String(candidate.dirty)) throw Error('Wrong served candidate');
    if (checkTheme && metrics.childThemes.some((t: string) => t !== test.theme)) errors.push(`${step}: mixed-theme endpoint`);
    return snapshot;
  };
  const click = async (name: string) => { await tab.playwright.getByRole('button', { name, exact: true }).click(); return observe(name); };
  try {
    await observe('entry', false);
    // Theme is controlled by U10's existing useTheme owner, not a CSS override.
    await click(test.theme === 'dark' ? 'Dark' : 'Light');
    await click('Set up Jarvis'); await click('Continue');
    if (test.state === 'skip-connection-interview') { await click('Skip for now'); await click('Skip'); }
    else { await click('Continue'); await tab.playwright.getByLabel('Your written answer', { exact: true }).fill('I review meeting follow-ups each week.'); await click('Send'); }
    await click('Continue');
    for (let step = 0; step < 11; step++) await click('Next');
    await click('Open Pebble');
    await tab.playwright.getByLabel('Unsent sample draft', { exact: true }).fill('Keep this unsent text');
    await observe('Pebble draft');
    await click('Let’s build your first workflow');
    if (test.state === 'tour-replay') {
      await click('Replay tour fixture');
      const text = await observe('replayed-today');
      if (!text.includes('Start with what matters.')) throw Error('Replay did not return to Today');
      await click('Skip tour');
    }
    await click('Meeting follow-up'); await click('Create my workflow');
    if (test.state === 'failed-build-retry') { const snap = await observe('failed'); if (!snap.includes('Retry build')) throw Error('Missing deliberate retry'); await click('Retry build'); }
    const waiting = await observe('before-phase-advance'); if (waiting.includes('Your draft is saved.')) throw Error('Build reported success without a provider event');
    for (let phase = 0; phase < 4; phase++) await click('Advance observed build phase');
    const result = await observe('saved-result');
    if (!result.includes('Draft · Not enabled')) throw Error('Missing saved disabled result');
    await click('Review steps'); await click('Continue to dashboard');
    if (!(await observe('complete')).includes('Dashboard handoff')) throw Error('Missing dashboard destination');
  } catch (error) { errors.push(String(error)); }
  const evidence = [await save(`${test.id}.trace.json`, JSON.stringify({ candidate, caseId: test.id, trace, errors }, null, 2)), await save(`${test.id}.png`, await tab.screenshot({ fullPage: true }))];
  return { id: test.id, revision: candidate.revision, outcome: errors.length ? 'failed' as const : 'blocked' as const,
    reason: errors.length ? `ON-U-10: ${errors.join('; ')}` : 'Fixture UI journey completed. Full D room and D18 canvas bindings are absent; runtime visual acceptance remains blocked.', evidence };
}
