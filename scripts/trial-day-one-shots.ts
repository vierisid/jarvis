/**
 * Drive the rest of day one in a real browser and photograph it.
 *
 * Beat 14 is reachable only after an hour of realtime conversation, a
 * handover, a spawned sub-agent and five more minutes; beat 17 needs most of a
 * working day. Neither is reviewable by waiting for one, and an unreviewable
 * surface is how this trial ended up with two pebbles on screen in the first
 * place. So the frames go through `/api/trial/preview`, which is what that
 * route exists for.
 *
 * Two things here are NOT faked, deliberately:
 *
 *  - The agent. It spawns a real sub-agent through the real `/api/agents`
 *    route, and on a machine with no model credit that agent really dies. That
 *    is the defect this branch fixes, photographed rather than asserted: a run
 *    that used to report `completed` with our own error prose where its result
 *    goes.
 *  - The pebble. The gesture moves the SHELL's own docked pebble, so the
 *    script measures where `.rs-peb` actually is before, during and after.
 *
 *   bun run scripts/trial-day-one-shots.ts <cdp-port> <daemon-url> <out-dir>
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { importPKCS8, SignJWT } from 'jose';

const PORT = process.argv[2] ?? '9334';
const BASE = process.argv[3] ?? 'http://localhost:3142';
const OUT = process.argv[4] ?? '/tmp/day-one-shots';
const TRIAL_HOME = process.env.JARVIS_TRIAL_HOME ?? '/home/vierisid/.jarvis-trial';

mkdirSync(OUT, { recursive: true });

class Cdp {
  private ws!: WebSocket;
  private id = 0;
  private pending = new Map<number, { ok: (v: any) => void; no: (e: Error) => void }>();

  static async attach(url: string): Promise<Cdp> {
    const c = new Cdp();
    c.ws = new WebSocket(url);
    await new Promise<void>((res, rej) => {
      c.ws.addEventListener('open', () => res(), { once: true });
      c.ws.addEventListener('error', () => rej(new Error('cdp socket failed')), { once: true });
    });
    c.ws.addEventListener('message', (e) => {
      const msg = JSON.parse(String(e.data));
      const p = c.pending.get(msg.id);
      if (!p) return;
      c.pending.delete(msg.id);
      if (msg.error) p.no(new Error(JSON.stringify(msg.error)));
      else p.ok(msg.result);
    });
    return c;
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const id = ++this.id;
    return new Promise((ok, no) => {
      this.pending.set(id, { ok, no });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.delete(id)) no(new Error(`${method} timed out`)); }, 30_000);
    });
  }

  async eval<T>(expression: string): Promise<T> {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails));
    return r.result.value as T;
  }

  async shot(name: string): Promise<void> {
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(OUT, `${name}.png`), Buffer.from(r.data, 'base64'));
    console.log(`  ▸ ${name}.png`);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function token(): Promise<string> {
  const key = await importPKCS8(readFileSync(join(TRIAL_HOME, 'sidecar-keys/private.pem'), 'utf-8'), 'ES256');
  const sid = crypto.randomUUID();
  return new SignJWT({ sid }).setProtectedHeader({ alg: 'ES256' })
    .setSubject(`sidecar:${sid}`).setAudience('brain-api').setIssuedAt()
    .setExpirationTime('1800s').sign(key);
}

async function api(jwt: string, path: string, body?: unknown): Promise<any> {
  const r = await fetch(`${BASE}${path}${path.includes('?') ? '&' : '?'}token=${jwt}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: `token=${jwt}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${path}: ${r.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

const preview = (jwt: string, payload: unknown) =>
  api(jwt, '/api/trial/preview', { type: 'trial_day_one', payload });

/** Where the shell's own pebble actually is, and what the trial has drawn. */
const LOOK = `(() => {
  const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };
  const peb = document.querySelector('.rs-peb');
  const row = document.querySelector('[data-trial-anchor^="agent:"]');
  const card = document.querySelector('.td1');
  return {
    pebble: box(peb),
    pebbleTransform: peb ? (peb.style.transform || 'none') : null,
    row: box(row),
    rowAnchor: row ? row.getAttribute('data-trial-anchor') : null,
    rowText: row ? row.innerText.replace(/\\s+/g, ' ').trim().slice(0, 200) : null,
    label: document.querySelector('.td1-label')?.textContent ?? null,
    labelBox: box(document.querySelector('.td1-label')),
    card: card ? card.innerText.replace(/\\s+/g, ' ').trim().slice(0, 420) : null,
    offers: [...document.querySelectorAll('.td1-offer')].map((b) => b.innerText.replace(/\\s+/g, ' ').trim()),
    pebbleCount: [...document.querySelectorAll('.rs-peb, .tc-pebble .tc-drop, .rs-talk-mic')]
      .filter((el) => { const s = getComputedStyle(el); const r = el.getBoundingClientRect();
        return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 4; }).length,
  };
})()`;

async function look(cdp: Cdp, label: string): Promise<any> {
  const s = await cdp.eval<any>(LOOK);
  console.log(`\n── ${label} ──`);
  console.log(`  pebbles on screen ${s.pebbleCount}`);
  console.log(`  shell pebble      ${JSON.stringify(s.pebble)}  transform: ${s.pebbleTransform}`);
  console.log(`  agent row         ${s.rowAnchor ?? '(none)'} ${JSON.stringify(s.row)}`);
  if (s.rowText) console.log(`  row says          ${s.rowText}`);
  if (s.label) console.log(`  pebble label      "${s.label}" ${JSON.stringify(s.labelBox)}`);
  if (s.card) console.log(`  card              ${s.card}`);
  if (s.offers.length) for (const o of s.offers) console.log(`  offer             ${o}`);
  return s;
}

async function main(): Promise<void> {
  const jwt = await token();

  /* ── 1. a REAL sub-agent, which on this machine really dies ── */
  console.log('spawning a real sub-agent through /api/agents…');
  const spawned = await api(jwt, '/api/agents', {
    specialist: 'research-analyst',
    task: 'What do the other studio schedulers charge a seat?',
    context: 'They sell scheduling software to recording studios.',
  });
  const taskId = spawned?.task?.task_id ?? spawned?.task_id ?? null;
  console.log(`  agent ${spawned?.agent_id ?? '?'} task ${taskId}`);

  // Wait for it to settle, either way.
  let task: any = null;
  for (let i = 0; i < 40; i++) {
    await sleep(1500);
    const tasks = await api(jwt, '/api/agents/tasks');
    task = tasks.tasks.find((t: any) => t.task_id === taskId);
    if (task && task.status !== 'running') break;
  }
  console.log(`\n── the task, as the daemon now reports it ──`);
  console.log(`  status            ${task?.status}`);
  console.log(`  agent_name        ${task?.agent_name}`);
  console.log(`  failure_kind      ${task?.failure_kind ?? '(none)'}`);
  console.log(`  result_preview    ${task?.result_preview ?? '(none)'}`);

  /* ── 2. the browser ── */
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json() as any[];
  const page = list.find((t) => t.type === 'page');
  if (!page) throw new Error('no page target');
  const cdp = await Cdp.attach(page.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

  console.log('\nopening the handed-over shell…');
  await cdp.send('Page.navigate', { url: `${BASE}/?token=${jwt}` });
  await sleep(4000);
  await look(cdp, 'the shell, before anything is said');
  await cdp.shot('01-shell-at-rest');

  /* ── 3. beat 14, the frame the daemon would send ── */
  const failed = task?.status === 'failed';
  const frame = {
    kind: 'agent_back',
    via: 'push',
    says: failed
      ? 'Your question did not get an answer, and it was not the question. '
        + `${task?.result_preview ?? 'The run stopped.'} I have kept it and I will run it again.`
      : 'That question you gave me has come back.',
    question: 'What do the other studio schedulers charge a seat?',
    finding: failed ? null : (task?.result_preview ?? null),
    answered: !failed,
    failure: failed ? { kind: task?.failure_kind ?? 'unknown', says: task?.result_preview ?? '' } : null,
    offers: [
      {
        id: 'back-toward', kind: 'toward', direction: 'inward',
        label: 'I will take this one and put it against your key result.',
        where: 'On your board under my name, noted on "Paying customers 11 to 40".',
        target: { title: 'Paying customers 11 to 40' },
      },
      {
        id: 'back-write', kind: 'workspace_write', direction: 'outward',
        label: 'I will write the changed version into your workspace.',
        where: 'A new file in C:\\Users\\v\\Company organised. Your originals are not touched.',
      },
    ],
    agent: { taskId, agentName: task?.agent_name ?? 'your agent' },
    gesture: { room: 'agent_strip', anchor: `agent:${taskId}`, label: failed ? 'this one' : 'here it is', holdMs: 4000 },
    permanentHome: 'agents',
  };

  console.log('\nbeat 14: pushing the frame the director would broadcast…');
  await preview(jwt, frame);

  await sleep(2500);
  const mid = await look(cdp, 'the pebble, mid-gesture');
  await cdp.shot('02-pebble-over-the-row');

  await sleep(4000);
  const after = await look(cdp, 'after the hold, the pebble back in its corner');
  await cdp.shot('03-card-and-offers');

  /* ── 4. beat 17, the close ── */
  console.log('\nbeat 17: the close of day one…');
  await preview(jwt, {
    kind: 'day_close',
    says: 'Here is where your day went. Let me take one of them off you.',
    summary: [
      'Rewriting the pricing page · about 95 minutes in Cursor and Chrome',
      'Northwind deliverable · about 40 minutes in Notion',
    ],
    thin: false,
    offers: [{
      id: 'close-toward', kind: 'toward', direction: 'inward',
      label: 'I will take the pricing page and have a draft for you.',
      where: 'On your board under my name, noted on "Paying customers 11 to 40".',
      target: { title: 'Paying customers 11 to 40' },
    }],
  });
  await sleep(1500);
  await look(cdp, 'the close of day one');
  await cdp.shot('04-day-close');

  /* ── 5. the agent strip on its own, so the failed row is legible ── */
  await cdp.eval(`location.hash = '#/_room_agent_strip'`);
  await sleep(1500);
  await cdp.shot('05-agent-strip');

  console.log('\nverdicts');
  console.log(`  the pebble MOVED for the gesture      ${mid.pebbleTransform !== 'none' && mid.pebbleTransform !== null}`);
  console.log(`  and CAME BACK afterwards              ${after.pebbleTransform === '' || after.pebbleTransform === 'none'}`);
  console.log(`  it held a label while it was there    ${!!mid.label}`);
  console.log(`  still exactly one pebble on screen    ${after.pebbleCount === 1}`);
  console.log(`  the card carries offers               ${after.offers.length}`);
  console.log(`\nshots in ${OUT}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
