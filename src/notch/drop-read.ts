/**
 * Reading a dropped file that is not plain text already.
 *
 * What a chat attachment can hold is plain text, a PDF, a PNG or a JPEG.
 * Many files people drop are none of those and are still made of words: a
 * web page, a Word document, a spreadsheet, a deck, a script. Here each is
 * turned into its words, and the words travel as plain text under the file's
 * own name.
 *
 * Nothing here runs anything, follows a link, or opens what a file points to.
 * A web page's scripts and styles are thrown away unread. An Office file is a
 * zip of XML: the few parts that hold the words are unpacked, with a limit on
 * how much any of them may unpack to, and read with patterns, never with a
 * parser that would follow what the XML declares.
 *
 * What comes out is cut at a length a model reads well, and says so.
 */
import { inflateRawSync } from 'node:zlib';

/** The most text one dropped file becomes. Under the limit a chat attachment's text may have. */
export const NOTCH_DROP_TEXT_MAX = 120_000;
/** The most one part of an Office file may unpack to, and the most parts that are looked at. */
export const NOTCH_DROP_UNPACK_MAX = 24 * 1024 * 1024;
export const NOTCH_DROP_PARTS_MAX = 4000;
/** The most rows of one sheet that are read. */
export const NOTCH_DROP_ROWS_MAX = 2000;
/**
 * The most of a file's own characters that are gone through for its words:
 * for plain text, and for a web page, whose words are a small part of it.
 * What comes out is cut at NOTCH_DROP_TEXT_MAX anyway. And the most all the
 * parts of one Office file may unpack to together.
 *
 * Everything here runs on the brain's one thread, while approvals, agents
 * and every connection wait. So every reader is one pass over its input,
 * whatever the input is: an audit on 17 November 2026 measured 25 seconds for
 * a 512 KB web page with unclosed comments, 3.7 for 64 KB of code with one
 * long run of spaces, and a 130 KB deck that became 92 MB of text.
 */
export const NOTCH_DROP_PLAIN_MAX = 400_000;
export const NOTCH_DROP_HTML_MAX = 4_000_000;
export const NOTCH_DROP_UNPACK_TOTAL_MAX = 48 * 1024 * 1024;

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '\u2013', mdash: '\u2014', hellip: '\u2026', copy: '\u00a9', euro: '\u20ac', pound: '\u00a3' };

/** `&amp;` and its kind, as the characters they stand for. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-zA-Z]{2,8});/g, (whole, name: string) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      // Not a control character, and a character there is.
      return Number.isFinite(code) && code >= 0x20 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : ' ';
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

/** Text fit to be an attachment: no control characters, no runs of empty lines, no trailing blanks. */
export function tidyText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
    .replace(/[ \t ]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Code and settings, kept as written: how far a line is set in is part of what it says. Only what cannot travel is taken out. */
export function plainText(text: string): string {
  // Line by line, so that a long run of blanks is walked once and not once from each of its blanks.
  const lines = text.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ').split('\n');
  const out: string[] = [];
  let empty = 0;
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (line === '') {
      // At most two empty lines in a row, and none before the first line.
      if (out.length === 0 || ++empty > 2) continue;
    } else empty = 0;
    out.push(line);
  }
  while (out.length > 0 && out[out.length - 1] === '') out.pop();
  return out.join('\n');
}

const HTML_UNREAD = new Set(['script', 'style', 'noscript', 'template', 'svg', 'head', 'iframe', 'object']);
const HTML_BLOCK_END = new Set(['p', 'div', 'section', 'article', 'header', 'footer', 'main', 'aside', 'nav', 'li', 'ul', 'ol', 'tr', 'table', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'figure', 'form', 'dd', 'dt']);
const HTML_INLINE = new Set(['a', 'b', 'i', 'u', 'em', 'strong', 'span', 'small', 'sub', 'sup', 'code', 'mark', 'label', 'font', 'abbr', 'cite', 'q', 's', 'del', 'ins', 'time']);

/**
 * The words of a web page: what a person would read on it, a line for each
 * block. Scripts and styles are thrown away unread.
 *
 * One pass from the first tag to the last: every character is looked at
 * once, whatever the page holds. (It was a chain of patterns, and a page with
 * comments or scripts that were never closed made each of them search to the
 * end again and again.)
 */
export function htmlToText(html: string): string {
  const lower = html.toLowerCase();
  const out: string[] = [];
  let title = '';
  let at = 0;
  const n = html.length;
  const endless = new Set<string>();
  while (at < n) {
    const open = html.indexOf('<', at);
    if (open < 0) { out.push(html.slice(at)); break; }
    out.push(html.slice(at, open));
    if (lower.startsWith('<!--', open)) {
      // A comment that is never closed: nothing after it is the page's words.
      const end = html.indexOf('-->', open + 4);
      if (end < 0) break;
      out.push(' ');
      at = end + 3;
      continue;
    }
    const close = html.indexOf('>', open + 1);
    // A "<" with no ">" after it anywhere is not a tag, and neither is any after it: the rest is words.
    if (close < 0) { out.push(html.slice(open).replace(/</g, ' ')); break; }
    const inside = lower.slice(open + 1, Math.min(close, open + 40));
    const ending = inside.startsWith('/');
    const name = /^[a-z][a-z0-9]*/.exec(ending ? inside.slice(1) : inside)?.[0] ?? '';
    at = close + 1;
    if (!ending && (HTML_UNREAD.has(name) || name === 'title')) {
      // Unread to its own end tag. One that is never closed: a script or a style takes the rest of the page
      // with it, and any other is only a tag.
      // A name with no end tag after this place has none after any later place: it is not searched for again.
      const end = endless.has(name) ? -1 : lower.indexOf(`</${name}`, at);
      if (end < 0) {
        if (name === 'script' || name === 'style') break;
        endless.add(name);
        out.push(' ');
        continue;
      }
      if (name === 'title' && !title) title = html.slice(at, end);
      const after = html.indexOf('>', end);
      out.push(' ');
      if (after < 0) break;
      at = after + 1;
      continue;
    }
    if (name === 'br') out.push('\n');
    else if (ending && HTML_BLOCK_END.has(name)) out.push('\n');
    else if (!ending && name === 'li') out.push('\n- ');
    else if (ending && (name === 'td' || name === 'th')) out.push(' | ');
    // A word made bold or a link is still one run of words: nothing is put where its tag was.
    else if (HTML_INLINE.has(name)) { /* nothing */ }
    else out.push(' ');
  }
  // One line for each block: the page's own empty lines are how it was written, not what it says.
  const words = tidyText(decodeEntities(out.join(''))).replace(/\n{2,}/g, '\n');
  const heading = tidyText(decodeEntities(htmlTagless(title)));
  return heading && !words.startsWith(heading) ? `${heading}\n\n${words}` : words;
}

/** Text with its tags taken out, in one pass. */
function htmlTagless(text: string): string {
  const out: string[] = [];
  let at = 0;
  for (;;) {
    const open = text.indexOf('<', at);
    if (open < 0) { out.push(text.slice(at)); break; }
    out.push(text.slice(at, open), ' ');
    const close = text.indexOf('>', open + 1);
    if (close < 0) break;
    at = close + 1;
  }
  return out.join('');
}

/**
 * Every `<tag …>inside</tag>` of a source, in order, with what stands in
 * the opening tag. One pass: found by position, never by a pattern that
 * would search to the end of the file for each tag that is never closed.
 * `<tag …/>` comes with nothing inside.
 */
export function* xmlBetween(source: string, tag: string): Generator<{ attributes: string; inner: string }> {
  const open = `<${tag}`;
  const close = `</${tag}>`;
  let at = 0;
  for (;;) {
    const start = source.indexOf(open, at);
    if (start < 0) return;
    const after = source.charCodeAt(start + open.length);
    // "<c" is not "<col": the name ends here, at a blank, a slash or the bracket.
    if (!(after === 62 || after === 47 || after === 32 || after === 9 || after === 10 || after === 13)) { at = start + open.length; continue; }
    const end = source.indexOf('>', start + open.length);
    if (end < 0) return;
    const attributes = source.slice(start + open.length, end);
    if (attributes.endsWith('/')) { yield { attributes: attributes.slice(0, -1), inner: '' }; at = end + 1; continue; }
    const stop = source.indexOf(close, end + 1);
    // Never closed: nothing after it closes either.
    if (stop < 0) return;
    yield { attributes, inner: source.slice(end + 1, stop) };
    at = stop + close.length;
  }
}

// ---------------------------------------------------------------------------
// A zip, as far as an Office file needs one
// ---------------------------------------------------------------------------

export interface ZipPart { name: string; method: number; packed: number; size: number; at: number }

/** The list of what a zip holds. Null when the bytes are not a zip this can read (none at all, damaged, encrypted, or the 64-bit kind). */
export function zipParts(bytes: Uint8Array): ZipPart[] | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // The end record is the last 22 bytes, or sits before a comment of up to 65,535.
  let end = -1;
  for (let at = bytes.length - 22; at >= 0 && at >= bytes.length - 22 - 65_535; at--) {
    if (view.getUint32(at, true) === 0x06054b50) { end = at; break; }
  }
  if (end < 0) return null;
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  if (count === 0xffff || at === 0xffffffff || count > NOTCH_DROP_PARTS_MAX) return null;
  const parts: ZipPart[] = [];
  const decoder = new TextDecoder();
  for (let i = 0; i < count; i++) {
    if (at + 46 > bytes.length || view.getUint32(at, true) !== 0x02014b50) return null;
    const flags = view.getUint16(at + 8, true);
    const nameLength = view.getUint16(at + 28, true);
    const part: ZipPart = {
      name: decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength)),
      method: view.getUint16(at + 10, true),
      packed: view.getUint32(at + 20, true),
      size: view.getUint32(at + 24, true),
      at: view.getUint32(at + 42, true),
    };
    // Encrypted: not something to read.
    if (flags & 1) return null;
    parts.push(part);
    at += 46 + nameLength + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
  }
  return parts;
}

/** One part of a zip, unpacked. Null when it is too large, or cannot be unpacked. */
export function zipRead(bytes: Uint8Array, part: ZipPart, budget?: { left: number }): Uint8Array | null {
  if (part.size > NOTCH_DROP_UNPACK_MAX || part.at + 30 > bytes.length) return null;
  // All parts of one file together: a small zip can hold thousands of parts that each unpack to megabytes.
  if (budget && budget.left <= 0) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(part.at, true) !== 0x04034b50) return null;
  const from = part.at + 30 + view.getUint16(part.at + 26, true) + view.getUint16(part.at + 28, true);
  const packed = bytes.subarray(from, from + part.packed);
  if (packed.length !== part.packed) return null;
  if (part.method === 0) { if (budget) budget.left -= packed.length; return packed; }
  if (part.method !== 8) return null;
  // The limit holds whatever the zip says the size is: a few kilobytes can claim to be anything.
  try {
    const out = inflateRawSync(packed, { maxOutputLength: budget ? Math.min(NOTCH_DROP_UNPACK_MAX, Math.max(1, budget.left)) : NOTCH_DROP_UNPACK_MAX });
    if (budget) budget.left -= out.length;
    return out;
  } catch { return null; }
}

const xml = (bytes: Uint8Array | null): string => (bytes ? new TextDecoder().decode(bytes) : '');

/** The words between tags of one name, joined: the text runs of a paragraph. */
const runs = (source: string, tag: string): string => {
  const out: string[] = [];
  for (const found of xmlBetween(source, tag)) out.push(decodeEntities(found.inner));
  return out.join('');
};

/** The words of a Word document: a line for each paragraph. */
export function docxText(bytes: Uint8Array): string | null {
  const parts = zipParts(bytes);
  const body = parts?.find((part) => part.name === 'word/document.xml');
  if (!parts || !body) return null;
  const source = xml(zipRead(bytes, body));
  if (!source) return null;
  const lines: string[] = [];
  let kept = 0;
  for (const paragraph of source.split('</w:p>')) {
    // Enough to fill what is kept: the rest of a long document is not gone through.
    if (kept > NOTCH_DROP_TEXT_MAX * 2) break;
    const line = runs(paragraph.replace(/<w:tab\b[^>]{0,200}\/>/g, '<w:t>\t</w:t>').replace(/<w:(br|cr)\b[^>]{0,200}\/>/g, '<w:t>\n</w:t>'), 'w:t');
    kept += line.length + 1;
    lines.push(line);
  }
  return tidyText(lines.join('\n'));
}

/** The words of a deck: what each slide says, slide by slide. */
export function pptxText(bytes: Uint8Array): string | null {
  const parts = zipParts(bytes);
  if (!parts) return null;
  const slides = parts
    .map((part) => ({ part, number: Number(/^ppt\/slides\/slide(\d+)\.xml$/.exec(part.name)?.[1] ?? NaN) }))
    .filter((slide) => Number.isFinite(slide.number))
    .sort((a, b) => a.number - b.number);
  if (slides.length === 0) return null;
  const out: string[] = [];
  const budget = { left: NOTCH_DROP_UNPACK_TOTAL_MAX };
  let length = 0;
  for (const slide of slides) {
    // Enough to fill what is kept: the slides after it are not unpacked at all.
    if (length > NOTCH_DROP_TEXT_MAX) break;
    const source = xml(zipRead(bytes, slide.part, budget));
    const lines: string[] = [];
    let kept = 0;
    for (const paragraph of source.split('</a:p>')) {
      const line = runs(paragraph, 'a:t').trim();
      if (!line) continue;
      lines.push(line);
      if ((kept += line.length) > NOTCH_DROP_TEXT_MAX) break;
    }
    const text = `Slide ${slide.number}:\n${lines.join('\n')}`;
    length += text.length;
    out.push(text);
  }
  return tidyText(out.join('\n\n'));
}

/** A source with every `<tag …>…</tag>` taken out, in one pass. */
function xmlWithout(source: string, tag: string): string {
  if (!source.includes(`<${tag}`)) return source;
  const out: string[] = [];
  const close = `</${tag}>`;
  let at = 0;
  for (;;) {
    const start = source.indexOf(`<${tag}`, at);
    if (start < 0) { out.push(source.slice(at)); break; }
    out.push(source.slice(at, start));
    const stop = source.indexOf(close, start);
    if (stop < 0) break;
    at = stop + close.length;
  }
  return out.join('');
}

/** A column's letters as its place: A is 0, Z is 25, AA is 26. */
const column = (letters: string): number => [...letters].reduce((sum, letter) => sum * 26 + (letter.charCodeAt(0) - 64), 0) - 1;

/** A spreadsheet as text: each sheet by its name, each row a line, cells parted by commas. Dates come as the numbers the file keeps them as. */
export function xlsxText(bytes: Uint8Array): string | null {
  const parts = zipParts(bytes);
  if (!parts) return null;
  const budget = { left: NOTCH_DROP_UNPACK_TOTAL_MAX };
  const find = (name: string): string => { const part = parts.find((entry) => entry.name === name); return part ? xml(zipRead(bytes, part, budget)) : ''; };
  const workbook = find('xl/workbook.xml');
  if (!workbook) return null;
  // Words that many cells share are kept once, in a list the cells point into. How a word is read aloud
  // (rPh) stands beside it and is not the word.
  const shared: string[] = [];
  for (const item of xmlBetween(find('xl/sharedStrings.xml'), 'si')) shared.push(runs(xmlWithout(item.inner, 'rPh'), 't'));
  const names: string[] = [];
  for (const sheet of xmlBetween(workbook, 'sheet')) names.push(decodeEntities(/\bname="([^"]{0,200})"/.exec(sheet.attributes)?.[1] ?? ''));
  const sheets = parts
    .map((part) => ({ part, number: Number(/^xl\/worksheets\/sheet(\d+)\.xml$/.exec(part.name)?.[1] ?? NaN) }))
    .filter((sheet) => Number.isFinite(sheet.number))
    .sort((a, b) => a.number - b.number);
  if (sheets.length === 0) return null;
  const out: string[] = [];
  let length = 0;
  for (const [at, sheet] of sheets.entries()) {
    if (length > NOTCH_DROP_TEXT_MAX) break;
    const source = xml(zipRead(bytes, sheet.part, budget));
    const lines: string[] = [];
    for (const row of xmlBetween(source, 'row')) {
      if (lines.length >= NOTCH_DROP_ROWS_MAX) { lines.push('(more rows follow)'); break; }
      const cells: string[] = [];
      for (const cell of xmlBetween(row.inner, 'c')) {
        const attributes = cell.attributes.slice(0, 400);
        const inner = cell.inner;
        const place = /\br="([A-Z]{1,3})\d+"/.exec(attributes)?.[1];
        const type = /\bt="([a-zA-Z]+)"/.exec(attributes)?.[1] ?? '';
        let value = '';
        for (const found of xmlBetween(inner, 'v')) { value = found.inner; break; }
        const said = type === 's' ? shared[Number(value)] ?? ''
          : type === 'inlineStr' ? runs(inner, 't')
            : type === 'b' ? (value === '1' ? 'TRUE' : 'FALSE')
              : decodeEntities(value);
        const index = place ? column(place) : cells.length;
        if (index > 200) continue;
        while (cells.length < index) cells.push('');
        // A comma inside a cell would read as two cells.
        cells[index] = /[,\n"]/.test(said) ? `"${said.replace(/"/g, '""').replace(/\n/g, ' ')}"` : said;
      }
      if (cells.some(Boolean)) lines.push(cells.join(','));
    }
    const text = `Sheet: ${names[at] ?? `Sheet ${sheet.number}`}\n${lines.length ? lines.join('\n') : '(empty)'}`;
    length += text.length;
    out.push(text);
  }
  return tidyText(out.join('\n\n'));
}

/** How a kind of file is turned into its words. */
export type DropReader = 'text' | 'html' | 'docx' | 'pptx' | 'xlsx';

/** The kinds that are made of words but are not plain text to a chat attachment, by the end of their name. */
export const NOTCH_DROP_READERS: Record<string, DropReader> = {
  html: 'html', htm: 'html', xhtml: 'html',
  docx: 'docx', pptx: 'pptx', xlsx: 'xlsx', xlsm: 'xlsx',
  // Written by hand or by a program, and plain words all the same.
  xml: 'text', yaml: 'text', yml: 'text', toml: 'text', ini: 'text', cfg: 'text', conf: 'text', tsv: 'text', sql: 'text', srt: 'text', vtt: 'text', tex: 'text', rst: 'text',
  js: 'text', mjs: 'text', cjs: 'text', ts: 'text', tsx: 'text', jsx: 'text', py: 'text', go: 'text', rs: 'text', java: 'text', kt: 'text', swift: 'text',
  c: 'text', h: 'text', cpp: 'text', hpp: 'text', cs: 'text', rb: 'text', php: 'text', sh: 'text', bash: 'text', ps1: 'text', bat: 'text', cmd: 'text',
  css: 'text', scss: 'text', vue: 'text', svelte: 'text',
};

/**
 * The words of a dropped file, cut at a length a model reads well. Null when
 * it cannot be read as what its name says it is: damaged, protected with a
 * password, or not made of words at all.
 */
export function readDropped(reader: DropReader, bytes: Uint8Array): { text: string; cut: boolean } | null {
  let text: string | null;
  /** The file itself was larger than what is gone through: what was read is its first part. */
  let clipped = false;
  try {
    if (reader === 'docx') text = docxText(bytes);
    else if (reader === 'pptx') text = pptxText(bytes);
    else if (reader === 'xlsx') text = xlsxText(bytes);
    else {
      // Only as much as can end up in what is kept is gone through: the first part of a very large file.
      const most = reader === 'html' ? NOTCH_DROP_HTML_MAX : NOTCH_DROP_PLAIN_MAX;
      const whole = new TextDecoder('utf-8', { fatal: false }).decode(bytes.length > most * 4 ? bytes.subarray(0, most * 4) : bytes);
      const decoded = whole.length > most ? whole.slice(0, most) : whole;
      if (bytes.length > most * 4 || whole.length > most) clipped = true;
      // Bytes that are not text at all (a picture named .txt) are mostly marks of what could not be read.
      let unread = 0;
      for (let at = decoded.indexOf('\ufffd'); at >= 0; at = decoded.indexOf('\ufffd', at + 1)) unread++;
      if (decoded.length === 0 || unread > decoded.length / 20) return null;
      text = reader === 'html' ? htmlToText(decoded) : plainText(decoded);
    }
  } catch {
    return null;
  }
  if (!text) return null;
  const cut = clipped || text.length > NOTCH_DROP_TEXT_MAX;
  return { text: cut ? `${text.length > NOTCH_DROP_TEXT_MAX ? text.slice(0, NOTCH_DROP_TEXT_MAX) : text}\n\n(The file goes on. Only this first part was read.)` : text, cut };
}
