#!/usr/bin/env bun
/**
 * The mail study (the plan's Track B), run against a development brain that
 * was started by scripts/notch/try.sh.
 *
 *   bun scripts/notch/mail-study.ts go [#place]        open Gmail in Jarvis's own browser
 *   bun scripts/notch/mail-study.ts shape <name> [json] run src/notch/mail/page/shape-<name>.js and print what it found
 *   bun scripts/notch/mail-study.ts export [--days 30]  read the month's threads from Gmail into the study folder
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
  if (verb === 'export') {
    const days = Number(flag(rest, 'days') ?? 30);
    await brain.go('#inbox');
    const signed = await brain.run<{ host: string; main: boolean }>('shape-signin');
    if (signed.host !== 'mail' || !signed.main) {
      console.error('Jarvis\'s browser is not showing a signed-in Gmail. Sign in there first.');
      return 1;
    }
    const { address } = await brain.run<{ address: string }>('owner');
    const step = (what: string) => (page: number, rows: number) => process.stdout.write(`\r${what}: page ${page}, ${rows} rows   `);

    // Everything but chats and what Gmail filed as advertising or social notices.
    const window = `newer_than:${days}d -in:chats`;
    const rows = await gmailSearch(brain, `${window} -category:promotions -category:social`, { each: step('The month') });
    const filed = new Map<string, 'updates' | 'forums'>();
    for (const kind of ['updates', 'forums'] as const) {
      for (const row of await gmailSearch(brain, `${window} category:${kind}`, { each: step(`Filed under ${kind}`) })) filed.set(row.id, kind);
    }
    process.stdout.write('\n');

    // The owner's addresses: the account's own, and any other Gmail shows under the same word ("me").
    const words = new Set(rows.flatMap((row) => row.people).filter((who) => who.address === address).map((who) => who.name));
    const mine = new Set([address, ...rows.flatMap((row) => row.people).filter((who) => words.has(who.name)).map((who) => who.address)]);

    // A thread where only machines wrote and the owner never did can be neither a moment nor a sample.
    const worth = (row: GmailRow) => row.people.length === 0 || row.people.some((who) => mine.has(who.address) || !mailMachine(who));
    const wanted = rows.filter(worth);
    console.log(`${rows.length} threads in ${days} days; ${rows.length - wanted.length} are machines only and are not read.`);
    const { threads, failed } = await gmailThreads(brain, wanted, { each: (done, of) => process.stdout.write(`\rReading threads: ${done} of ${of}   `) });
    process.stdout.write('\n');
    for (const thread of threads) { const kind = filed.get(thread.id); if (kind) thread.filed = kind; }

    const own = threads.flatMap((thread) => thread.messages).filter((message) => mine.has(message.from.address));
    const names = new Map<string, number>();
    for (const message of own) if (message.from.name) names.set(message.from.name, (names.get(message.from.name) ?? 0) + 1);
    const full = [...names.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
    const name = full ? mailFirstName({ name: full, address }) : address.split('@')[0]!;
    write(files.threads, threads);
    write(files.owner, { name, addresses: [...mine], readAt: Date.now() });
    const all = threads.flatMap((thread) => thread.messages);
    console.log(`${threads.length} threads read, ${all.length} messages, ${own.length} of them the owner's, from ${mine.size} address${mine.size === 1 ? '' : 'es'} of theirs.`);
    console.log(`Not read, by reason: ${JSON.stringify(failed)}`);
    console.log(`Filed by Gmail: ${JSON.stringify({ updates: threads.filter((thread) => thread.filed === 'updates').length, forums: threads.filter((thread) => thread.filed === 'forums').length })}`);
    console.log(`Kept in ${STUDY}.`);
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
