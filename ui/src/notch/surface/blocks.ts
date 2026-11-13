/**
 * What a sheet is made of, built from data: rows, a sheet of paper, a quiet
 * note, buttons, a file. The brain describes a sheet; this draws it with the
 * prototype's markup and reports which button or row was pressed.
 */
import type { NotchBlock, NotchButton, NotchPart } from '../../../../src/notch/protocol.ts';
import { btn, el } from './dom.ts';
import { FICON, G } from './icons.ts';

export interface BlockDeps {
  /** A sentence with no animation, lit words included. */
  plain(parts: readonly NotchPart[]): DocumentFragment;
  button(id: string, row?: string): void;
  go(row: string): void;
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
  const n = el('div', deciding ? 'row stack' : 'row');
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
    } else if (block.kind === 'file') {
      const card = el('div', 'filecard'), badge = el('div', 'ic');
      badge.append(icon(FICON[block.icon]));
      card.append(badge, el('b', '', block.name), el('span', '', block.meta));
      root.append(card);
    }
  }
  return root;
}
