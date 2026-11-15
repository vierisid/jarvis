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
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .replace(/^\n+|\s+$/g, '');
}

/** The words of a web page: what a person would read on it, a line for each block. Scripts and styles are thrown away unread. */
export function htmlToText(html: string): string {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '';
  const body = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template|svg|head|title|iframe|object)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    // What is left of one that was never closed: nothing after it is the page's words.
    .replace(/<(script|style)\b[\s\S]*$/i, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|header|footer|main|aside|nav|li|ul|ol|tr|table|h[1-6]|blockquote|pre|figure|form|dd|dt)\s*>/gi, '\n')
    .replace(/<(li)\b[^>]*>/gi, '\n- ')
    .replace(/<\/(td|th)\s*>/gi, ' | ')
    // A word made bold or a link is still one run of words: nothing is put where its tag was.
    .replace(/<\/?(a|b|i|u|em|strong|span|small|sub|sup|code|mark|label|font|abbr|cite|q|s|del|ins|time)\b[^>]*>/gi, '')
    .replace(/<[^>]*>/g, ' ');
  // One line for each block: the page's own empty lines are how it was written, not what it says.
  const words = tidyText(decodeEntities(body)).replace(/\n{2,}/g, '\n');
  const heading = tidyText(decodeEntities(title.replace(/<[^>]*>/g, ' ')));
  return heading && !words.startsWith(heading) ? `${heading}\n\n${words}` : words;
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
export function zipRead(bytes: Uint8Array, part: ZipPart): Uint8Array | null {
  if (part.size > NOTCH_DROP_UNPACK_MAX || part.at + 30 > bytes.length) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(part.at, true) !== 0x04034b50) return null;
  const from = part.at + 30 + view.getUint16(part.at + 26, true) + view.getUint16(part.at + 28, true);
  const packed = bytes.subarray(from, from + part.packed);
  if (packed.length !== part.packed) return null;
  if (part.method === 0) return packed;
  if (part.method !== 8) return null;
  // The limit holds whatever the zip says the size is: a few kilobytes can claim to be anything.
  try { return inflateRawSync(packed, { maxOutputLength: NOTCH_DROP_UNPACK_MAX }); } catch { return null; }
}

const xml = (bytes: Uint8Array | null): string => (bytes ? new TextDecoder().decode(bytes) : '');

/** The words between tags of one name, joined: the text runs of a paragraph. */
const runs = (source: string, tag: string): string =>
  [...source.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'g'))].map((found) => decodeEntities(found[1]!)).join('');

/** The words of a Word document: a line for each paragraph. */
export function docxText(bytes: Uint8Array): string | null {
  const parts = zipParts(bytes);
  const body = parts?.find((part) => part.name === 'word/document.xml');
  if (!parts || !body) return null;
  const source = xml(zipRead(bytes, body));
  if (!source) return null;
  const lines = source.split(/<\/w:p>/).map((paragraph) =>
    runs(paragraph.replace(/<w:tab\b[^>]*\/>/g, '<w:t>\t</w:t>').replace(/<w:(br|cr)\b[^>]*\/>/g, '<w:t>\n</w:t>'), 'w:t'));
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
  for (const slide of slides) {
    const source = xml(zipRead(bytes, slide.part));
    const lines = source.split(/<\/a:p>/).map((paragraph) => runs(paragraph, 'a:t').trim()).filter(Boolean);
    out.push(`Slide ${slide.number}:\n${lines.join('\n')}`);
  }
  return tidyText(out.join('\n\n'));
}

/** A column's letters as its place: A is 0, Z is 25, AA is 26. */
const column = (letters: string): number => [...letters].reduce((sum, letter) => sum * 26 + (letter.charCodeAt(0) - 64), 0) - 1;

/** A spreadsheet as text: each sheet by its name, each row a line, cells parted by commas. Dates come as the numbers the file keeps them as. */
export function xlsxText(bytes: Uint8Array): string | null {
  const parts = zipParts(bytes);
  if (!parts) return null;
  const find = (name: string): string => { const part = parts.find((entry) => entry.name === name); return part ? xml(zipRead(bytes, part)) : ''; };
  const workbook = find('xl/workbook.xml');
  if (!workbook) return null;
  // Words that many cells share are kept once, in a list the cells point into.
  const shared = [...find('xl/sharedStrings.xml').matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((item) => runs(item[1]!.replace(/<rPh\b[\s\S]*?<\/rPh>/g, ''), 't'));
  const names = [...workbook.matchAll(/<sheet\b[^>]*\bname="([^"]*)"/g)].map((sheet) => decodeEntities(sheet[1]!));
  const sheets = parts
    .map((part) => ({ part, number: Number(/^xl\/worksheets\/sheet(\d+)\.xml$/.exec(part.name)?.[1] ?? NaN) }))
    .filter((sheet) => Number.isFinite(sheet.number))
    .sort((a, b) => a.number - b.number);
  if (sheets.length === 0) return null;
  const out: string[] = [];
  let length = 0;
  for (const [at, sheet] of sheets.entries()) {
    if (length > NOTCH_DROP_TEXT_MAX) break;
    const source = xml(zipRead(bytes, sheet.part));
    const lines: string[] = [];
    for (const row of source.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      if (lines.length >= NOTCH_DROP_ROWS_MAX) { lines.push('(more rows follow)'); break; }
      const cells: string[] = [];
      for (const cell of row[1]!.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attributes = cell[1]!;
        const inner = cell[2] ?? '';
        const place = /\br="([A-Z]{1,3})\d+"/.exec(attributes)?.[1];
        const type = /\bt="([a-zA-Z]+)"/.exec(attributes)?.[1] ?? '';
        const value = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? '';
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
  try {
    if (reader === 'docx') text = docxText(bytes);
    else if (reader === 'pptx') text = pptxText(bytes);
    else if (reader === 'xlsx') text = xlsxText(bytes);
    else {
      // Bytes that are not text at all (a picture named .txt) are mostly marks of what could not be read.
      const decoded = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
      const unread = (decoded.match(/�/g) ?? []).length;
      if (decoded.length === 0 || unread > decoded.length / 20) return null;
      text = reader === 'html' ? htmlToText(decoded) : plainText(decoded);
    }
  } catch {
    return null;
  }
  if (!text) return null;
  const cut = text.length > NOTCH_DROP_TEXT_MAX;
  return { text: cut ? `${text.slice(0, NOTCH_DROP_TEXT_MAX)}\n\n(The file goes on. Only this first part was read.)` : text, cut };
}
