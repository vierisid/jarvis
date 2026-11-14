#!/usr/bin/env bun
/**
 * The mail study (the plan's Track B), run against a development brain that
 * was started by scripts/notch/try.sh.
 *
 *   bun scripts/notch/mail-study.ts go [#place]        open Gmail in Jarvis's own browser
 *   bun scripts/notch/mail-study.ts shape <name> [json] run src/notch/mail/page/shape-<name>.js and print what it found
 *   bun scripts/notch/mail-study.ts calendar           is a calendar connected, and how much is in it
 *
 * What this prints is shapes and counts. Mail itself is written to the study
 * folder inside the brain's data folder (<data>/study) and never printed: a
 * `shape-` script is the only kind whose answer reaches the screen, and those
 * are written to answer with counts and yes-or-no, never with text from a mail.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DATA = process.env.NOTCH_DATA_DIR ?? join(homedir(), '.jarvis-notch');
const PORT = Number(process.env.NOTCH_PORT ?? 3143);
const GMAIL = 'https://mail.google.com/mail/u/0/';

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
    if (res.status === 404) {
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

async function main(argv: string[]): Promise<number> {
  const [verb, ...rest] = argv;
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
  if (verb === 'calendar') {
    const to = new Date();
    const from = new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
    const answer = await brain.ask({ op: 'calendar', from: from.toISOString(), to: to.toISOString() });
    console.log(answer.connected ? `A calendar is connected: ${(answer.events as unknown[]).length} events in the last 30 days.` : 'No calendar is connected to this brain.');
    return 0;
  }
  console.error('Usage: mail-study.ts go [#place] [--headless|--visible] | shape <name> [json] | calendar');
  return 2;
}

if (import.meta.main) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
