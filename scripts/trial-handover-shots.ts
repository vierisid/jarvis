/**
 * Drive the handover in a real browser and photograph it.
 *
 * The suppression this branch removes (`.rs-peb` and `.rs-talk` hidden while
 * `data-trial-conductor` is on `<html>`) exists because a second pebble
 * shipped. So the one thing that cannot be taken on trust here is what is
 * actually on the screen: this script counts the pebbles.
 *
 * It talks CDP over a raw WebSocket rather than pulling in a driver, and it
 * pushes the trial's own frames through `/api/trial/preview`, which is what
 * that route is for: the handover is otherwise reachable only at the end of an
 * hour of realtime conversation with a microphone and a funded model account.
 *
 *   bun run scripts/trial-handover-shots.ts <cdp-port> <daemon-url> <out-dir>
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { importPKCS8, SignJWT } from 'jose';

const PORT = process.argv[2] ?? '9333';
const BASE = process.argv[3] ?? 'http://localhost:3142';
const OUT = process.argv[4] ?? '/tmp/handover-shots';
const TRIAL_HOME = process.env.JARVIS_TRIAL_HOME ?? '/home/vierisid/.jarvis-trial';

mkdirSync(OUT, { recursive: true });

/* ───────────────────────────── CDP ───────────────────────────── */

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
      setTimeout(() => {
        if (this.pending.delete(id)) no(new Error(`${method} timed out`));
      }, 30_000);
    });
  }

  async eval<T>(expression: string): Promise<T> {
    const r = await this.send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true,
    });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails));
    return r.result.value as T;
  }

  async shot(name: string): Promise<void> {
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(OUT, `${name}.png`), Buffer.from(r.data, 'base64'));
    console.log(`  ▸ ${name}.png`);
  }

  async key(key: string, code: string, keyCode: number, mods: number): Promise<void> {
    for (const type of ['keyDown', 'keyUp'] as const) {
      await this.send('Input.dispatchKeyEvent', {
        type, key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, modifiers: mods,
      });
    }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ─────────────────── the page's own credential ─────────────────── */

async function token(): Promise<string> {
  const key = await importPKCS8(readFileSync(join(TRIAL_HOME, 'sidecar-keys/private.pem'), 'utf-8'), 'ES256');
  const sid = crypto.randomUUID();
  return new SignJWT({ sid })
    .setProtectedHeader({ alg: 'ES256' })
    .setSubject(`sidecar:${sid}`)
    .setAudience('brain-api')
    .setIssuedAt()
    .setExpirationTime('900s')
    .sign(key);
}

// The daemon authenticates a sidecar ACCESS token from a cookie or `?token=`,
// never from an Authorization header (see src/comms/websocket.ts).
async function preview(jwt: string, type: string, payload: unknown): Promise<void> {
  const r = await fetch(`${BASE}/api/trial/preview?token=${jwt}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: `token=${jwt}` },
    body: JSON.stringify({ type, payload }),
  });
  if (!r.ok) throw new Error(`preview ${type}: ${r.status} ${await r.text()}`);
}

/* ─────────────────── what is actually on the screen ─────────────────── */

const COUNT_PEBBLES = `(() => {
  const vis = (el) => {
    if (!el) return false;
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
    const r = el.getBoundingClientRect();
    return r.width > 4 && r.height > 4;
  };
  const box = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };
  const conductor = [...document.querySelectorAll('.tc-pebble .tc-drop')].filter(vis);
  const docked = [...document.querySelectorAll('.rs-peb')].filter(vis);
  const inTalk = [...document.querySelectorAll('.rs-talk-mic')].filter(vis);
  return {
    marker: document.documentElement.dataset.trialConductor ?? null,
    conductor: conductor.map(box),
    docked: docked.map(box),
    talkMic: inTalk.map(box),
    talkOpen: !!document.querySelector('.rs-talk'),
    composer: !!document.querySelector('.rs-talk .rs-talk-foot'),
    total: conductor.length + docked.length + inTalk.length,
    card: (() => {
      const c = document.querySelector('.tc-prop');
      if (!c) return null;
      return { text: c.innerText.replace(/\\s+/g, ' ').trim().slice(0, 220), box: box(c) };
    })(),
    clock: document.querySelector('.tc-foot-clock')?.textContent ?? null,
    connection: (document.querySelector('.rs-top')?.innerText || '').replace(/[ \\t\\r\\n]+/g, ' ').trim().slice(0, 70),
    bubble: document.querySelector('.tc-bubble')?.textContent ?? null,
  };
})()`;

async function report(cdp: Cdp, label: string): Promise<any> {
  const s = await cdp.eval<any>(COUNT_PEBBLES);
  console.log(`\n── ${label} ──`);
  console.log(`  marker            ${s.marker ?? '(none)'}`);
  console.log(`  conductor pebble  ${s.conductor.length} ${JSON.stringify(s.conductor)}`);
  console.log(`  docked pebble     ${s.docked.length} ${JSON.stringify(s.docked)}`);
  console.log(`  pebble in Talk    ${s.talkMic.length} ${JSON.stringify(s.talkMic)}`);
  console.log(`  PEBBLES ON SCREEN ${s.total}`);
  console.log(`  Talk / composer   ${s.talkOpen} / ${s.composer}`);
  console.log(`  clock             ${s.clock ?? '(none)'}`);
  console.log(`  shell says        ${JSON.stringify(s.connection)}`);
  if (s.card) console.log(`  card              ${s.card.text}`);
  return s;
}

/* ───────────────────────────── the walk ───────────────────────────── */

const HANDOVER_CARD = {
  proposal: {
    beat: 'handover',
    keys: [
      { chord: 'mod+J', what: 'brings me back', where: 'wherever you are in here', press: true },
      { chord: 'ctrl+space', what: 'the same, from anywhere', where: 'even with this shut' },
      { chord: 'mod+K', what: 'anything, by name', where: 'the command palette' },
    ],
    pressed: false,
  },
};

async function main(): Promise<void> {
  const jwt = await token();

  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json() as any[];
  const page = list.find((t) => t.type === 'page');
  if (!page) throw new Error('no page target');
  const cdp = await Cdp.attach(page.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1440, height: 900, deviceScaleFactor: 1, mobile: false,
  });

  console.log('opening the dashboard with a fresh credential…');
  await cdp.send('Page.navigate', { url: `${BASE}/?token=${jwt}` });
  await sleep(3500);

  // The microphone gate (D10). The browser is launched with a fake device, so
  // this grants without a prompt; the realtime session behind it may well fail
  // (his OpenAI account is out of credit), which does not matter here: what is
  // under test is the SURFACE, and the layer mounts either way.
  const gate = await cdp.eval<boolean>(`!!document.querySelector('.tc-gate')`);
  console.log(`  microphone gate on screen: ${gate}`);
  if (gate) {
    await cdp.shot('01-gate');
    await cdp.eval(`document.querySelector('.tc-gate .tc-btn').click(); true`);
    await sleep(4000);
  }
  await report(cdp, 'the conducted conversation, before the handover');
  await cdp.shot('02-conducting');

  console.log('\nputting the handover card up…');
  await preview(jwt, 'trial_proposal', HANDOVER_CARD);
  await sleep(900);
  await report(cdp, 'the three keys, one of them to press');
  await cdp.shot('03-teach-summon');

  console.log('\npressing control and J, as the founder is asked to…');
  await cdp.key('j', 'KeyJ', 74, 2 /* Ctrl */);
  await sleep(700);
  const pressed = await report(cdp, 'the moment they press it');
  await cdp.shot('04-pressed');

  console.log('\nthe daemon asks for the stand-down…');
  await preview(jwt, 'trial_standdown', { pressed: true, at: Date.now() });
  // Nothing is being spoken, so the rules hold for the speech grace and then
  // hand over. See ui/src/v2/trial/standDown.ts.
  await sleep(11_000);
  const after = await report(cdp, 'AFTER THE HANDOVER');
  await cdp.shot('05-handed-over');

  // With Talk open the shell shows the pair it has always shown: the docked
  // pebble and the one in Talk's header, ~750px apart. The state that answers
  // "is there one pebble" is the resting one, so close Talk and count again.
  console.log('\nclosing Talk again, which is the resting state…');
  await cdp.key('Escape', 'Escape', 27, 0);
  await sleep(800);
  const resting = await report(cdp, 'AT REST, AFTER THE HANDOVER');
  await cdp.shot('05b-handed-over-at-rest');

  console.log('\nand the shell is theirs: ⌘K over it…');
  await cdp.key('k', 'KeyK', 75, 2);
  await sleep(900);
  await cdp.shot('06-palette');
  const palette = await cdp.eval<boolean>(
    `!!document.querySelector('[class*="palette"], [class*="cmdk"], [role="dialog"][aria-label*="alette"]')`,
  );
  console.log(`  palette opened: ${palette}`);

  console.log('\n════════ verdict ════════');
  console.log(`  card ticked on the press : ${JSON.stringify(pressed.card?.text ?? '').includes('✓')}`);
  console.log(`  marker gone              : ${after.marker === null}`);
  console.log(`  pebbles on screen        : ${after.total}`);
  console.log(`  the shell's pebble back  : ${after.docked.length === 1}`);
  console.log(`  the conductor's gone     : ${after.conductor.length === 0}`);
  console.log(`  Talk open for them       : ${after.talkOpen}`);
  console.log(`  pebbles at rest          : ${resting.total} (docked ${resting.docked.length}, conductor ${resting.conductor.length})`);
  console.log(`  the clock still running  : ${after.clock}`);
  console.log(`  trial status             : ${JSON.stringify(await (await fetch(`${BASE}/api/trial/status`, { headers: { Cookie: `token=${jwt}` } })).json())}`);
}

main().then(() => process.exit(0)).catch((err) => {
  console.error(err);
  process.exit(1);
});
