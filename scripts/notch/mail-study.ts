#!/usr/bin/env bun
/**
 * The mail study (the plan's Track B), run against a development brain that
 * was started by scripts/notch/try.sh.
 *
 *   bun scripts/notch/mail-study.ts go [#place]        open Gmail in Jarvis's own browser
 *   bun scripts/notch/mail-study.ts shape <name> [json] run src/notch/mail/page/shape-<name>.js and print what it found
 *   bun scripts/notch/mail-study.ts export [--days 30] [--resume]
 *                                                      read the month's threads from Gmail into the study folder
 *   bun scripts/notch/mail-study.ts calendar           read the calendar, when one is connected, into the study folder
 *   bun scripts/notch/mail-study.ts replay [--want 45] [--most 160] [--tier medium]
 *                                                      put the month's moments to the proposer and keep its drafts
 *   bun scripts/notch/mail-study.ts sheet [--port 3144] serve the scoring sheet on this computer only
 *   bun scripts/notch/mail-study.ts score              what the marks add up to
 *
 * What this prints is shapes and counts. Mail itself is written to the study
 * folder inside the brain's data folder (<data>/study) and never printed: a
 * `shape-` script is the only kind whose answer reaches the screen, and those
 * are written to answer with counts and yes-or-no, never with text from a mail.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { gmailSearch, gmailThreads, type GmailRow } from '../../src/notch/mail/gmail.ts';
import type { MailCalendarEvent, MailThought } from '../../src/notch/mail/proposer.ts';
import { studyMoments, studyReplay, studyResult, type StudyMark, type StudyProposal, type StudyTried } from '../../src/notch/mail/study.ts';
import { mailFirstName, type MailThread } from '../../src/notch/mail/thread.ts';
import { mailMachine } from '../../src/notch/mail/waiting.ts';

const DATA = process.env.NOTCH_DATA_DIR ?? join(homedir(), '.jarvis-notch');
const PORT = Number(process.env.NOTCH_PORT ?? 3143);
const GMAIL = 'https://mail.google.com/mail/u/0/';
/** Everything the study reads or makes is kept here, inside the brain's own data folder. */
const STUDY = join(DATA, 'study');

/** The files of the study. Mail is in them: they are read and written, never printed. */
const files = {
  owner: 'owner.json',        // { name, addresses, readAt }
  rows: 'rows.json',          // the month's list: { rows, filed, listedAt }
  threads: 'threads.json',    // MailThread[]
  calendar: 'calendar.json',  // MailCalendarEvent[]
  tried: 'tried.json',        // StudyTried[]: every moment put to the proposer, with what came of it
  marks: 'marks.json',        // { [proposal id]: StudyMark }
};

function read<T>(name: string, otherwise: T): T {
  try {
    return JSON.parse(readFileSync(join(STUDY, name), 'utf8')) as T;
  } catch {
    return otherwise;
  }
}

/** Written beside and moved into place: a mark is never half saved. */
function write(name: string, value: unknown): void {
  mkdirSync(STUDY, { recursive: true, mode: 0o700 });
  const path = join(STUDY, name);
  writeFileSync(`${path}.part`, JSON.stringify(value, null, 1), { mode: 0o600 });
  renameSync(`${path}.part`, path);
}

const flag = (rest: string[], name: string): string | undefined => {
  const at = rest.indexOf(`--${name}`);
  return at >= 0 ? rest[at + 1] : undefined;
};

const proposalsOf = (tried: StudyTried[]): StudyProposal[] => tried.flatMap((entry) => (entry.proposal ? [entry.proposal] : []));

export class StudyBrain {
  private readonly secret: string;
  constructor(private readonly port = PORT, data = DATA) {
    this.secret = readFileSync(join(data, '.notch-demo-secret'), 'utf8').trim();
  }

  async ask(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const res = await fetch(`http://127.0.0.1:${this.port}/api/notch/study`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-notch-demo-token': this.secret },
      body: JSON.stringify(body),
    });
    // A brain without the route answers 404, or 401 from the door in front of every unknown /api path.
    if (res.status === 404 || res.status === 401) {
      throw new Error(`The brain on port ${this.port} has no mail study. Start it again with scripts/notch/try.sh --no-build.`);
    }
    const answer = await res.json().catch(() => null) as Record<string, unknown> | null;
    if (!res.ok || !answer) throw new Error(typeof answer?.error === 'string' ? answer.error : `The brain answered ${res.status}.`);
    return answer;
  }

  go(place = '', options: { headless?: boolean } = {}): Promise<unknown> {
    return this.ask({ op: 'navigate', url: GMAIL + place, ...options });
  }

  /** Runs a page script and gives back what it answered, parsed. */
  async run<T = unknown>(name: string, args?: unknown): Promise<T> {
    const { answer } = await this.ask({ op: 'run', name, args });
    return JSON.parse(String(answer)) as T;
  }
}

/**
 * The scoring sheet, served to this computer only. The address carries a
 * secret of its own, kept in the study folder, so that another page open in
 * the same browser cannot ask for the mail by guessing a port.
 */
async function sheet(port: number): Promise<void> {
  mkdirSync(STUDY, { recursive: true, mode: 0o700 });
  const keyPath = join(STUDY, '.sheet-key');
  if (!existsSync(keyPath)) writeFileSync(keyPath, randomBytes(18).toString('base64url'), { mode: 0o600 });
  const key = readFileSync(keyPath, 'utf8').trim();
  const page = readFileSync(new URL('./mail-study-sheet.html', import.meta.url), 'utf8');
  const proposals = () => proposalsOf(read<StudyTried[]>(files.tried, []));
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

  Bun.serve({
    hostname: '127.0.0.1',
    port,
    async fetch(req) {
      const url = new URL(req.url);
      const [, given, what = ''] = url.pathname.split('/');
      if (given !== key) return new Response('Not found', { status: 404 });
      // A page from elsewhere may not post marks here, whatever it knows.
      const origin = req.headers.get('origin');
      if (origin && new URL(origin).host !== url.host) return new Response('Not found', { status: 404 });
      if (req.method === 'GET' && what === '' && url.pathname.endsWith('/')) {
        return new Response(page, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } });
      }
      if (req.method === 'GET' && what === '') return Response.redirect(`/${key}/`, 302);
      if (req.method === 'GET' && what === 'proposals') return json({ proposals: proposals(), marks: read<Record<string, StudyMark>>(files.marks, {}) });
      if (req.method === 'GET' && what === 'result') {
        return json(studyResult(read<Record<string, StudyMark>>(files.marks, {}), proposals().map((entry) => entry.id)));
      }
      if (req.method === 'POST' && what === 'mark') {
        const body = await req.json().catch(() => null) as { id?: unknown; score?: unknown; wrong?: unknown } | null;
        const known = typeof body?.id === 'string' && proposals().some((entry) => entry.id === body.id);
        if (!body || !known || (body.score !== 'useful' && body.score !== 'not' && body.score !== 'wrong')) return json({ error: 'Not a mark.' }, 400);
        const marks = read<Record<string, StudyMark>>(files.marks, {});
        marks[body.id as string] = body.score === 'wrong' && (body.wrong === 'person' || body.wrong === 'content')
          ? { score: 'wrong', wrong: body.wrong }
          : { score: body.score };
        write(files.marks, marks);
        return json({ ok: true });
      }
      return new Response('Not found', { status: 404 });
    },
  });
  console.log(`The scoring sheet: http://localhost:${port}/${key}/`);
  console.log(`${proposals().length} proposals. Marks are kept in ${join(STUDY, files.marks)}. Leave this running while scoring; Ctrl+C stops it.`);
}

async function main(argv: string[]): Promise<number> {
  const [verb, ...rest] = argv;
  if (verb === 'sheet') {
    await sheet(Number(flag(rest, 'port') ?? 3144));
    return await new Promise<number>(() => {});
  }
  if (verb === 'score') {
    const proposals = proposalsOf(read<StudyTried[]>(files.tried, []));
    const result = studyResult(read<Record<string, StudyMark>>(files.marks, {}), proposals.map((entry) => entry.id));
    console.log(`${result.scored} of ${proposals.length} scored: ${result.useful} useful, ${result.not} not useful, ${result.wrong} wrong (${result.wrongPerson} the wrong person).`);
    console.log(result.passes === null ? result.why : result.passes ? `It passes: ${result.why}` : `It does not pass: ${result.why}`);
    return 0;
  }
  const brain = new StudyBrain();
  if (verb === 'go') {
    const headless = rest.includes('--headless') ? true : rest.includes('--visible') ? false : undefined;
    const place = rest.find((arg) => !arg.startsWith('--')) ?? '';
    await brain.go(place, headless === undefined ? {} : { headless });
    console.log('Went.');
    return 0;
  }
  if (verb === 'shape' && rest[0]) {
    const answer = await brain.run(`shape-${rest[0]}`, rest[1] ? JSON.parse(rest[1]) : undefined);
    console.log(JSON.stringify(answer, null, 2));
    return 0;
  }
  if (verb === 'selfcheck') {
    // The owner said yes to this on 14 November 2026: one mail from them to themselves, one reply
    // draft in that thread, and the draft thrown away. Each step refuses unless the mail goes to
    // the owner's own address and to nobody else.
    const stage = rest[0];
    const { address } = await brain.run<{ address: string }>('owner');
    const kept = read<{ subject: string } | null>('selfcheck.json', null);
    const find = async (subject: string) => (await gmailSearch(brain, `subject:"${subject}"`, { pages: 1 }));
    const describe = (rows: GmailRow[]) => `${rows.length} thread${rows.length === 1 ? '' : 's'} with that subject; `
      + rows.map((row) => `[messages:${row.count} draft:${row.draft} people:${row.people.length} all the owner:${row.people.every((who) => who.address === address)}]`).join(' ');
    if (stage === 'send') {
      const subject = `Jarvis mail check ${new Date().toISOString().slice(11, 16).replace(':', '')}${Math.random().toString(36).slice(2, 5)}`;
      write('selfcheck.json', { subject });
      const body = 'A test from Jarvis: sent by you, to yourself, to check that it can send mail from its own browser. You can delete it.';
      await brain.ask({ op: 'navigate', url: `${GMAIL}?view=cm&fs=1&tf=1&to=${encodeURIComponent(address)}&su=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}` });
      const state = await brain.run<{ subject: number | null; body: number | null; send: boolean; saved: boolean }>('shape-compose', { wait: 9000 });
      console.log(`Writing window: ${JSON.stringify(state)}`);
      if (state.subject !== subject.length || !state.body || !state.send) {
        console.error('The writing window is not as expected. Nothing was sent.');
        return 1;
      }
      const sent = await brain.run<{ sent: boolean; why: string }>('compose-send', { subject, to: address });
      console.log(`Send: ${JSON.stringify(sent)}`);
      await brain.go('#inbox');
      console.log(`After sending: ${describe(await find(subject))}`);
      return sent.sent ? 0 : 1;
    }
    if (!kept) { console.error('Run "selfcheck send" first.'); return 1; }
    const rows = await find(kept.subject);
    if (rows.length !== 1) { console.error(`Expected one thread with the check's subject, found ${rows.length}.`); return 1; }
    const thread = rows[0]!;
    if (stage === 'find') { console.log(describe(rows)); return 0; }
    if (stage === 'reply' || stage === 'discard') {
      // The list of the search is on screen: the thread is opened from it, as a person would.
      // Opening changes the address, and the desktop app throws away an answer when it does: both are fine.
      const opened = await brain.run<{ opened: boolean }>('open-thread', { id: thread.id }).catch(() => null);
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const view = await brain.run<{ legacyMessages: number }>('shape-thread-view');
      console.log(`Thread open: ${JSON.stringify(opened)}; messages on screen: ${view.legacyMessages}`);
      if (!view.legacyMessages) { console.error('The thread did not open.'); return 1; }
      if (stage === 'reply') {
        const text = 'A reply written by Jarvis as a draft, to check that it can. It is not sent.';
        console.log(`Reply: ${JSON.stringify(await brain.run('reply-write', { to: address, text }))}`);
        // Gmail keeps a draft a moment after the last key.
        await new Promise((resolve) => setTimeout(resolve, 5000));
      } else {
        console.log(`Discard: ${JSON.stringify(await brain.run('reply-discard'))}`);
        await new Promise((resolve) => setTimeout(resolve, 2500));
      }
      console.log(`In the list now: ${describe(await find(kept.subject))}`);
      return 0;
    }
    console.error('Usage: mail-study.ts selfcheck send | find | reply | discard');
    return 2;
  }
  if (verb === 'unread') {
    // Threads the list shows that the study folder does not have: how many on the first
    // pages of the month's search, and what Gmail's print page of one of them is built like.
    const have = new Set(read<MailThread[]>(files.threads, []).map((thread) => thread.id));
    const rows = await gmailSearch(brain, `newer_than:${Number(flag(rest, 'days') ?? 30)}d -category:promotions -category:social`, { pages: Number(flag(rest, 'pages') ?? 2) });
    const machines = (row: GmailRow) => row.people.length > 0 && row.people.every((who) => mailMachine(who));
    const missing = rows.filter((row) => !have.has(row.id) && !machines(row));
    console.log(`${rows.length} rows on those pages, ${rows.filter(machines).length} machines only, ${missing.length} others not in the study folder.`);
    // Where they fall in the list, in runs: one stretch means Gmail stopped answering for a while, scattered means a kind of thread.
    const runs: string[] = [];
    let from = -1;
    rows.forEach((row, at) => {
      const out = !have.has(row.id) && !machines(row);
      if (out && from < 0) from = at;
      if ((!out || at === rows.length - 1) && from >= 0) { runs.push(`${from}-${out ? at : at - 1}`); from = -1; }
    });
    console.log(`Runs of missing rows: ${runs.slice(0, 60).join(' ')}${runs.length > 60 ? ` and ${runs.length - 60} more` : ''}`);
    console.log(`Of the missing: ${missing.filter((row) => row.count > 1).length} have more than one message; people per row ${JSON.stringify([...new Set(missing.map((row) => row.people.length))])}; machines only: ${missing.filter((row) => row.people.length > 0 && row.people.every((who) => mailMachine(who))).length}.`);
    for (const row of missing.slice(0, 2)) {
      const shape = await brain.run<{ found: Record<string, unknown> }>('shape-print', { id: row.id });
      console.log(JSON.stringify(shape.found.old).slice(0, 1800));
    }
    return 0;
  }
  if (verb === 'try') {
    // The reader on a handful of real threads, described without a word of them:
    // how many messages, whether each has a sender and a date, how long its text is.
    const place = rest.find((arg) => arg.startsWith('#')) ?? '#inbox';
    const many = Number(flag(rest, 'n') ?? 8);
    await brain.run('go', { place });
    const listed = await brain.run<{ there: boolean; rows: GmailRow[] }>('list', { place, not: '' });
    console.log(`The list showed: ${listed.there}. ${listed.rows.length} rows; ${listed.rows.filter((row) => row.draft).length} with a draft; ${listed.rows.filter((row) => row.count > 1).length} with more than one message.`);
    const { address } = await brain.run<{ address: string }>('owner');
    const picked = [...listed.rows.filter((row) => row.count > 1).slice(0, Math.ceil(many / 2)), ...listed.rows.filter((row) => row.count === 1).slice(0, Math.floor(many / 2))];
    const started = Date.now();
    const { threads, failed } = await gmailThreads(brain, picked);
    console.log(`${threads.length} of ${picked.length} read in ${Date.now() - started} ms. Not read: ${JSON.stringify(failed)}`);
    for (const thread of threads) {
      const row = picked.find((entry) => entry.id === thread.id)!;
      console.log(`  list says ${row.count}, read ${thread.messages.length}; subject ${thread.subject.length} chars; `
        + thread.messages.map((message) => `[${message.from.address === address ? 'owner' : 'other'} to:${message.to.length} cc:${message.cc.length} text:${message.text.length}]`).join(' '));
    }
    return 0;
  }
  if (verb === 'export') {
    const days = Number(flag(rest, 'days') ?? 30);
    const resume = rest.includes('--resume');
    await brain.go('#inbox');
    const signed = await brain.run<{ host: string; main: boolean }>('shape-signin');
    if (signed.host !== 'mail' || !signed.main) {
      console.error('Jarvis\'s browser is not showing a signed-in Gmail. Sign in there first.');
      return 1;
    }
    const { address } = await brain.run<{ address: string }>('owner');
    const step = (what: string) => (page: number, rows: number) => process.stdout.write(`\r${what}: page ${page}, ${rows} rows   `);

    // The list of the month. Kept, so that a reading cut short goes on from the threads and not from the list.
    type Listed = { rows: GmailRow[]; filed: Record<string, 'updates' | 'forums'>; listedAt: number };
    let listed = resume ? read<Listed | null>(files.rows, null) : null;
    if (!listed) {
      // Everything but what Gmail filed as advertising or social notices. Chats are not named:
      // a search that speaks of them, even to leave them out, is shown under Gmail's chat tab, with no mail in it.
      const window = `newer_than:${days}d`;
      const PAGES = 300;
      const rows = await gmailSearch(brain, `${window} -category:promotions -category:social`, { pages: PAGES, each: step('The month') });
      if (rows.length >= PAGES * 50) console.log(`\nThe list was cut at ${rows.length} threads: the oldest days of the month are not all in it.`);
      const filed: Listed['filed'] = {};
      for (const kind of ['updates', 'forums'] as const) {
        for (const row of await gmailSearch(brain, `${window} category:${kind}`, { pages: PAGES, each: step(`Filed under ${kind}`) })) filed[row.id] = kind;
      }
      process.stdout.write('\n');
      listed = { rows, filed, listedAt: Date.now() };
      write(files.rows, listed);
    }
    const { rows, filed } = listed;

    // The owner's addresses: the account's own, and any other Gmail shows under the same word ("me").
    const words = new Set(rows.flatMap((row) => row.people).filter((who) => who.address === address).map((who) => who.name));
    const mine = new Set([address, ...rows.flatMap((row) => row.people).filter((who) => words.has(who.name)).map((who) => who.address)]);

    // A thread where only machines wrote and the owner never did can be neither a moment nor a sample.
    const worth = (row: GmailRow) => row.people.length === 0 || row.people.some((who) => mine.has(who.address) || !mailMachine(who));
    const wanted = rows.filter(worth);
    const have = new Map((resume ? read<MailThread[]>(files.threads, []) : []).map((thread) => [thread.id, thread]));
    const todo = wanted.filter((row) => !have.has(row.id));
    console.log(`${rows.length} threads in ${days} days; ${rows.length - wanted.length} are machines only and are not read; ${have.size} already read; ${todo.length} to read.`);
    let unsaved = 0;
    const { failed } = await gmailThreads(brain, todo, {
      each: (done, of) => process.stdout.write(`\rReading threads: ${done} of ${of}   `),
      got: (read) => {
        for (const thread of read) have.set(thread.id, thread);
        unsaved += read.length;
        // Kept as it goes: a reading that is stopped has lost a minute, not the month.
        if (unsaved >= 120) { write(files.threads, [...have.values()]); unsaved = 0; }
      },
    });
    process.stdout.write('\n');
    const threads = wanted.flatMap((row) => { const thread = have.get(row.id); return thread ? [thread] : []; });
    for (const thread of threads) { const kind = filed[thread.id]; if (kind) thread.filed = kind; }

    const own = threads.flatMap((thread) => thread.messages).filter((message) => mine.has(message.from.address));
    const names = new Map<string, number>();
    for (const message of own) if (message.from.name) names.set(message.from.name, (names.get(message.from.name) ?? 0) + 1);
    const full = [...names.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
    const name = full ? mailFirstName({ name: full, address }) : address.split('@')[0]!;
    write(files.threads, threads);
    write(files.owner, { name, addresses: [...mine], readAt: listed.listedAt });
    const all = threads.flatMap((thread) => thread.messages);
    const span = all.length ? Math.round((Math.max(...all.map((message) => message.at)) - Math.min(...all.map((message) => message.at))) / 86_400_000) : 0;
    console.log(`${threads.length} of ${wanted.length} threads read, ${all.length} messages over ${span} days, ${own.length} of them the owner's, from ${mine.size} address${mine.size === 1 ? '' : 'es'} of theirs.`);
    console.log(`Not read, by reason: ${JSON.stringify(failed)}`);
    console.log(`Filed by Gmail: ${JSON.stringify({ updates: threads.filter((thread) => thread.filed === 'updates').length, forums: threads.filter((thread) => thread.filed === 'forums').length })}`);
    console.log(`Threads with a draft of the owner's: ${threads.filter((thread) => thread.draft).length}. Kept in ${STUDY}.`);
    return 0;
  }
  if (verb === 'calendar') {
    // The month that is replayed, and the two weeks after today that a reply written today may speak of.
    const DAY = 24 * 60 * 60 * 1000;
    const answer = await brain.ask({ op: 'calendar', from: new Date(Date.now() - 31 * DAY).toISOString(), to: new Date(Date.now() + 14 * DAY).toISOString() });
    if (!answer.connected) {
      console.log('No calendar is connected to this brain. The study runs without one: no reply will propose a time.');
      return 0;
    }
    const events = answer.events as MailCalendarEvent[];
    write(files.calendar, events);
    console.log(`A calendar is connected: ${events.length} events kept, from a month back to two weeks ahead.`);
    return 0;
  }
  if (verb === 'replay') {
    const owner = read<{ name: string; addresses: string[]; readAt: number } | null>(files.owner, null);
    const threads = read<MailThread[]>(files.threads, []);
    if (!owner || threads.length === 0) {
      console.error('The mailbox has not been read yet. Run the export first.');
      return 1;
    }
    const mine = new Set(owner.addresses);
    const want = Number(flag(rest, 'want') ?? 45);
    const most = Number(flag(rest, 'most') ?? 160);
    const tier = flag(rest, 'tier') ?? 'medium';
    const { moments, ruled } = studyMoments(threads, mine, owner.readAt);
    console.log(`${threads.length} threads. ${moments.length} moments where a person was waiting (${moments.filter((moment) => moment.live).length} still are).`);
    console.log(`Last messages that are not one, by reason: ${JSON.stringify(ruled)}`);
    const already = read<StudyTried[]>(files.tried, []);
    const all = [...already];
    const tried = await studyReplay({
      threads,
      owner: mine,
      ownerName: owner.name,
      calendar: existsSync(join(STUDY, files.calendar)) ? read<MailCalendarEvent[]>(files.calendar, []) : null,
      now: owner.readAt,
      zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      want,
      most,
      already,
      think: async (messages, { maxTokens }) => await brain.ask({ op: 'think', messages, tier, max_tokens: maxTokens }) as unknown as MailThought,
      each: (entry) => {
        // Kept after every one: a run that is stopped has lost nothing it paid for.
        all.push(entry);
        write(files.tried, all);
        process.stdout.write(entry.outcome === 'proposed' ? '+' : entry.outcome === 'silent' ? '.' : '!');
      },
    });
    process.stdout.write('\n');
    const count = (outcome: StudyTried['outcome']) => tried.filter((entry) => entry.outcome === outcome).length;
    const tokens = tried.reduce((sum, entry) => ({ input: sum.input + entry.cost.input + entry.cost.cached, output: sum.output + entry.cost.output }), { input: 0, output: 0 });
    console.log(`${tried.length} put to the proposer: ${count('proposed')} drafted, ${count('silent')} needed no reply, ${count('failed')} gave nothing usable.`);
    console.log(`${tokens.input} tokens read and ${tokens.output} written in all, on ${[...new Set(tried.map((entry) => entry.cost.model))].join(', ')}.`);
    return 0;
  }
  console.error('Usage: mail-study.ts go [#place] [--headless|--visible] | shape <name> [json] | export | calendar | replay | sheet | score');
  return 2;
}

if (import.meta.main) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
