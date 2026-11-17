/**
 * What a sheet is made of, built from data: rows, a sheet of paper, a quiet
 * note, buttons, a file. The brain describes a sheet; this draws it with the
 * prototype's markup and reports which button or row was pressed.
 */
import type { NotchBlock, NotchButton, NotchPart } from '../../../../src/notch/protocol.ts';
import { SVGNS, btn, el } from './dom.ts';
import { NOTCH_NAME } from '../../../../src/notch/name.ts';
import { FICON, G } from './icons.ts';

export interface BlockDeps {
  /** A sentence with no animation, lit words included. */
  plain(parts: readonly NotchPart[]): DocumentFragment;
  button(id: string, row?: string): void;
  go(row: string): void;
  /**
   * What of a map is already on the screen, for a sheet that is drawn again
   * with more in it: those things stay still, and only the new ones come in.
   */
  known?: Set<string>;
  /** No motion: nothing comes in, it is just there. */
  still?: boolean;
}

/** An svg from one of our own icon strings. */
function icon(svg: string): Element {
  const t = document.createElement('template');
  t.innerHTML = svg;
  return t.content.firstElementChild ?? el('span');
}

function button(b: NotchButton, deps: BlockDeps, row?: string): HTMLButtonElement {
  const n = btn(b.quiet ? 'btn quiet' : 'btn', null, () => deps.button(b.id, row));
  if (b.key !== undefined && !b.quiet) {
    n.append(el('span', 'cap', String(b.key)));
    n.dataset.k = String(b.key);
  }
  n.append(b.label);
  return n;
}

function row(block: Extract<NotchBlock, { kind: 'row' }>, deps: BlockDeps): HTMLElement {
  const main = el('span', 'mn');
  if (block.lead) main.append(el('b', '', block.lead), ' ');
  main.append(deps.plain(block.say));
  if (block.go && block.id) {
    // A row that opens something is one button, with a chevron.
    const id = block.id;
    const b = el('button', 'row go');
    b.type = 'button';
    b.onclick = () => deps.go(id);
    // The small word on the right (a time, how it ended) shows here too, before the chevron.
    const aside = block.small ?? block.tail;
    b.append(main, ...(aside ? [el('span', 'at', aside)] : []), icon(G.chev));
    return b;
  }
  const buttons = block.buttons ?? [];
  // Buttons that decide something sit under the sentence; a quiet one sits beside it.
  const deciding = buttons.some((b) => !b.quiet);
  const n = el('div', `${deciding ? 'row stack' : 'row'}${block.gone ? ' gone' : ''}`);
  n.append(main);
  const aside = block.small ?? block.tail;
  if (aside) n.append(el('span', 'at', aside));
  if (deciding) {
    const acts = el('div', 'acts');
    for (const b of buttons) acts.append(button(b, deps, block.id));
    n.append(acts);
  } else {
    for (const b of buttons) n.append(button(b, deps, block.id));
  }
  return n;
}

function paper(block: Extract<NotchBlock, { kind: 'paper' }>, deps: BlockDeps): HTMLElement {
  const n = el('div', 'paper');
  if (block.to) {
    const to = el('p', 'to');
    to.append(deps.plain(block.to));
    n.append(to);
  }
  if (block.numbered) {
    const list = el('ul');
    block.lines.forEach((line, i) => {
      const li = el('li');
      const text = el('div');
      text.append(deps.plain(line));
      li.append(el('span', 'num', String(i + 1)), text);
      list.append(li);
    });
    n.append(list);
  } else {
    for (const line of block.lines) {
      const p = el('p');
      p.append(deps.plain(line));
      n.append(p);
    }
  }
  if (block.file) {
    const f = el('div', 'file');
    f.append(icon(G.file), block.file.name, el('i', '', block.file.size));
    n.append(f);
  }
  return n;
}

const svg = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] => {
  const n = document.createElementNS(SVGNS, tag) as SVGElementTagNameMap[K];
  for (const [key, value] of Object.entries(attrs)) n.setAttribute(key, String(value));
  return n;
};

const MAP_KINDS: ReadonlySet<string> = new Set(['me', 'person', 'tool', 'co', 'thing']);
/** The most a map holds. More than this cannot be read in a panel this size. */
const MAP_MOST = 24;

/**
 * The look-around map (the prototype's `viewScan`): a dot and a name for each
 * thing found, a thin line between two that belong together, and under it one
 * chip for each place that was read. Everything in it is text from the brain,
 * set as text.
 */
function map(block: Extract<NotchBlock, { kind: 'map' }>, deps: BlockDeps): HTMLElement {
  const box = el('div');
  const known = deps.known ?? new Set<string>();
  const drawing = svg('svg', { viewBox: '0 0 444 204', class: 'map', role: 'img', 'aria-label': `A map of the people, tools and things ${NOTCH_NAME} found` });
  const gLinks = svg('g', {}), gNodes = svg('g', {});
  drawing.append(gLinks, gNodes);
  const num = (value: unknown, most: number): number => (typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(most, value)) : 0);
  const nodes = (Array.isArray(block.nodes) ? block.nodes : []).filter((node) => node && typeof node.id === 'string' && typeof node.label === 'string').slice(0, MAP_MOST);
  const at = new Map(nodes.map((node) => [node.id, { x: num(node.x, 444), y: num(node.y, 204) }]));
  // What was there before does not come in again.
  const was = (key: string): boolean => { const had = deps.still === true || known.has(key); known.add(key); return had; };
  for (const pair of (Array.isArray(block.links) ? block.links : []).slice(0, MAP_MOST * 3)) {
    const a = at.get(pair?.[0] ?? ''), b = at.get(pair?.[1] ?? '');
    if (!a || !b) continue;
    const line = svg('line', { x1: a.x, y1: a.y, x2: b.x, y2: b.y });
    if (was(`l:${pair[0]}>${pair[1]}`)) line.setAttribute('class', 'was');
    gLinks.append(line);
  }
  for (const node of nodes) {
    const p = at.get(node.id)!, right = p.x > 340, kind = MAP_KINDS.has(node.kind) ? node.kind : 'thing';
    const g = svg('g', { class: was(`n:${node.id}`) ? `${kind} was` : kind });
    const label = svg('text', { x: right ? p.x - 8 : p.x + 8, y: p.y + 3.5, 'text-anchor': right ? 'end' : 'start' });
    label.textContent = [...node.label].slice(0, 28).join('');
    g.append(svg('circle', { cx: p.x, cy: p.y, r: kind === 'me' ? 5 : 3.5 }), label);
    gNodes.append(g);
  }
  // One stroke through everything it found, drawn once, when it is done.
  const tour = (Array.isArray(block.tour) ? block.tour : []).map((id) => at.get(id)).filter((p): p is { x: number; y: number } => !!p);
  if (tour.length > 1 && !was('tour')) {
    const path = svg('path', { d: tour.map((p, i) => `${i ? 'L' : 'M'}${p.x} ${p.y}`).join(' '), class: 'tour' });
    gLinks.append(path);
    let length = 0;
    try { length = path.getTotalLength(); } catch { length = 0; }
    if (Number.isFinite(length) && length > 0) {
      path.style.strokeDasharray = String(length);
      path.style.strokeDashoffset = String(length);
      requestAnimationFrame(() => requestAnimationFrame(() => {
        path.style.transition = 'stroke-dashoffset 1.6s cubic-bezier(.4,0,.2,1), opacity .9s ease 1.7s';
        path.style.strokeDashoffset = '0';
        path.style.opacity = '0';
      }));
    } else path.remove();
  }
  const chips = el('div', 'srcs');
  for (const source of (Array.isArray(block.sources) ? block.sources : []).slice(0, 8)) {
    if (!source || typeof source.name !== 'string') continue;
    const chip = el('span', `src${source.state === 'on' ? ' on' : source.state === 'done' ? ' on done' : ''}`);
    chip.append(el('b', '', source.name), el('i', '', typeof source.found === 'string' ? source.found : ''));
    chips.append(chip);
  }
  box.append(drawing, chips);
  return box;
}

export function renderBlocks(blocks: readonly NotchBlock[], deps: BlockDeps): HTMLElement {
  const root = el('div');
  let rows: HTMLElement | null = null;
  for (const block of blocks) {
    if (block.kind === 'row') {
      if (!rows) { rows = el('div', 'rows'); root.append(rows); }
      rows.append(row(block, deps));
      continue;
    }
    rows = null;
    if (block.kind === 'paper') root.append(paper(block, deps));
    else if (block.kind === 'note') {
      const p = el('p', 'note');
      p.append(deps.plain(block.say));
      root.append(p);
    } else if (block.kind === 'buttons') {
      // Nothing but quiet ones is a row of links.
      const quiet = block.buttons.every((b) => b.quiet);
      const acts = el('div', quiet ? 'quietlinks' : 'acts');
      for (const b of block.buttons) {
        acts.append(quiet ? btn('', b.label, () => deps.button(b.id)) : button(b, deps));
      }
      root.append(acts);
    } else if (block.kind === 'map') {
      root.append(map(block, deps));
    } else if (block.kind === 'file') {
      const card = el('div', 'filecard'), badge = el('div', 'ic');
      badge.append(icon(FICON[block.icon]));
      card.append(badge, el('b', '', block.name), el('span', '', block.meta));
      root.append(card);
    }
  }
  return root;
}
