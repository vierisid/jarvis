/**
 * D41, in a browser: the two rooms that explain themselves.
 *
 * Vieri's verdict on the third run was that the trial sets the rooms up and
 * never explains how the things in them work, and that goals and workflows are
 * the two that need it. Both answers are gestures on a REAL object: their own
 * objective, opened, with the pebble walking its three levels; their own
 * published flow, opened in the editor, with the pebble walking its real
 * nodes.
 *
 * That is entirely a question of what is on the screen, so it is measured on
 * the screen, against the goals and the flows actually sitting in the trial
 * vault from his own run.
 *
 *   bun run scripts/trial-room-walk-shots.ts <cdp-port> <daemon-url> <out-dir>
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { importPKCS8, SignJWT } from 'jose';

const PORT = process.argv[2] ?? '9333';
const BASE = process.argv[3] ?? 'http://localhost:3142';
const OUT = process.argv[4] ?? '/tmp/handover-shots';
const TRIAL_HOME = process.env.JARVIS_TRIAL_HOME ?? '/home/vierisid/.jarvis-trial';

mkdirSync(OUT, { recursive: true });

class Cdp {
  ws!: WebSocket;
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
    if (r.exceptionDetails) throw new Error(String(r.exceptionDetails.exception?.description ?? JSON.stringify(r.exceptionDetails)));
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
    .setSubject(`sidecar:${sid}`).setAudience('brain-api')
    .setIssuedAt().setExpirationTime('1800s').sign(key);
}

async function preview(jwt: string, type: string, payload: unknown): Promise<void> {
  const r = await fetch(`${BASE}/api/trial/preview?token=${jwt}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: `token=${jwt}` },
    body: JSON.stringify({ type, payload }),
  });
  if (!r.ok) throw new Error(`preview ${type}: ${r.status} ${await r.text()}`);
}

async function api<T>(jwt: string, path: string): Promise<T> {
  const r = await fetch(`${BASE}${path}`, { headers: { Cookie: `token=${jwt}` } });
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.json() as Promise<T>;
}

/** Where the pebble is, what it is holding, and what it is standing next to. */
const PEBBLE = `(() => {
  const p = document.querySelector('.tc-pebble');
  if (!p) return null;
  const r = p.getBoundingClientRect();
  const label = document.querySelector('.tc-bubble-point')?.textContent ?? null;
  const anchors = [...document.querySelectorAll('[data-trial-anchor]')].map((el) => {
    const b = el.getBoundingClientRect();
    return { anchor: el.dataset.trialAnchor, label: el.dataset.trialLabel ?? null, x: Math.round(b.x), y: Math.round(b.y), right: Math.round(b.right), midY: Math.round(b.top + b.height / 2) };
  });
  // Which anchor is the pebble standing beside? It stops 14px to the right of
  // its target, vertically centred on it.
  // A room's row is approached from the right; a part is approached from
  // above. Accept either, so this measures where it landed rather than which
  // rule it used.
  const beside = (a) => Math.abs(a.right + 14 - r.left) < 26 && Math.abs(a.midY - (r.top + r.height / 2)) < 26;
  const above = (a) => Math.abs(a.x - r.left) < 26 && Math.abs(a.y - 14 - r.bottom) < 30;
  const near = anchors.filter((a) => beside(a) || above(a));
  return {
    pebble: { x: Math.round(r.x), y: Math.round(r.y), midY: Math.round(r.top + r.height / 2) },
    pointing: p.classList.contains('is-pointing'),
    label,
    anchors,
    standingBeside: near.map((a) => a.anchor),
  };
})()`;

/**
 * Sample the pebble for `seconds` and record where each stop of the walk
 * actually ended up.
 *
 * One row per LABEL, holding the best answer seen while that label was up: a
 * stop is sampled several times, once mid-flight (standing beside nothing) and
 * again once it has arrived. What is under test is where it comes to rest.
 */
async function watch(cdp: Cdp, seconds: number, note: string, shotAt?: string | undefined): Promise<{ label: string; beside: string[] }[]> {
  const byLabel = new Map<string, string[]>();
  const order: string[] = [];
  for (let i = 0; i < seconds * 8; i++) {
    const s = await cdp.eval<any>(PEBBLE);
    if (s?.pointing && s.label) {
      if (!byLabel.has(s.label)) { byLabel.set(s.label, []); order.push(s.label); }
      if (s.standingBeside.length > 0) byLabel.set(s.label, s.standingBeside);
    }
    // Photograph it standing beside something, not mid-flight between two
    // things: the frame that matters is the one the founder reads.
    if (shotAt && s?.pointing && s.standingBeside.length > 0) {
      await cdp.shot(shotAt);
      shotAt = undefined;
    }
    await sleep(125);
  }
  const seen = order.map((label) => ({ label, beside: byLabel.get(label) ?? [] }));
  console.log(`  ${note}:`);
  for (const stop of seen) console.log(`    "${stop.label}"  came to rest beside ${JSON.stringify(stop.beside)}`);
  return seen;
}

async function main(): Promise<void> {
  const jwt = await token();
  const goals = await api<any>(jwt, '/api/goals');
  const list: any[] = Array.isArray(goals) ? goals : (goals.goals ?? []);
  const objective = list.find((g) => g.level === 'objective');
  const kr = list.find((g) => g.level === 'key_result' && g.parent_id === objective?.id);
  const ms = list.find((g) => g.level === 'milestone');
  const flows = await api<any[]>(jwt, '/api/workflows');
  const flow = flows[0];
  if (!objective || !kr || !flow) throw new Error('the trial vault has no tree or no flow to walk');

  console.log(`their objective : ${objective.title}`);
  console.log(`a key result    : ${kr.title}`);
  console.log(`their flow      : ${flow.displayName} (${flow.id})\n`);

  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json() as any[];
  const cdp = await Cdp.attach(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

  await cdp.send('Page.navigate', { url: `${BASE}/?token=${jwt}` });
  await sleep(3500);
  if (await cdp.eval<boolean>(`!!document.querySelector('.tc-gate .tc-btn')`)) {
    await cdp.eval(`document.querySelector('.tc-gate .tc-btn').click(); true`);
    await sleep(3500);
  }

  /* ───────────── the goal tree ───────────── */

  console.log('\n══ GOALS ══');
  // The lead-in gesture the goals beat already sends, which opens the room.
  await preview(jwt, 'trial_point', { target: 'room:goals', label: 'your quarter', room: 'goals' });
  await sleep(2500);
  // What `create_goals` now sends the instant their tree lands.
  await preview(jwt, 'notification', {
    source: 'room_action', room: 'goals', action: 'focus_goal',
    args: { id: objective.id, title: objective.title },
  });
  await sleep(1200);
  const opened = await cdp.eval<any>(`(() => ({
    detail: document.querySelector('.v2-goals__side-title')?.textContent ?? null,
    tab: document.querySelector('.v2-goals__sky') ? 'constellation' : 'other',
    nodes: document.querySelectorAll('[data-trial-anchor^="goal:"]').length,
  }))()`);
  console.log(`  their objective is open : ${JSON.stringify(opened)}`);
  await cdp.shot('07-goal-opened');

  await preview(jwt, 'trial_walk', {
    room: 'goals',
    parts: [
      { anchor: `goal:${objective.id}`, label: 'the objective · where the quarter ends' },
      { anchor: `goal:${kr.id}`, label: 'a key result · 4 today' },
      ...(ms ? [{ anchor: `goal:${ms.id}`, label: 'the first move · fri 28 aug' }] : []),
    ],
  });
  const goalStops = await watch(cdp, 11, 'the pebble walked', '08-goal-walk');

  /* ───────────── the flow ───────────── */

  console.log('\n══ WORKFLOWS ══');
  await preview(jwt, 'trial_point', { target: 'room:workflows', label: 'the flow', room: 'workflows' });
  await sleep(2500);
  await preview(jwt, 'notification', {
    source: 'room_action', room: 'workflows', action: 'open_flow',
    args: { id: flow.id, name: flow.displayName },
  });
  await sleep(3500);
  const editor = await cdp.eval<any>(`(() => ({
    editorOpen: !!document.querySelector('.wf-editor'),
    title: document.querySelector('.wf-editor__title')?.innerText?.trim().slice(0, 60) ?? null,
    nodes: [...document.querySelectorAll('[data-trial-anchor^="flow-step:"]')].map((el) => el.dataset.trialLabel),
  }))()`);
  console.log(`  their flow is open as a graph : ${JSON.stringify(editor, null, 2)}`);
  await cdp.shot('09-flow-opened');

  // No anchors from the daemon: the surface reads the real graph.
  await preview(jwt, 'trial_walk', { room: 'workflows', kind: 'flow', parts: [] });
  const flowStops = await watch(cdp, 11, 'the pebble walked', '10-flow-walk');

  console.log('\n════════ verdict ════════');
  console.log(`  their objective opened in the room : ${opened.detail !== null}`);
  console.log(`  the tree carries walkable anchors  : ${opened.nodes}`);
  console.log(`  the pebble stopped on their goals  : ${goalStops.filter((s) => s.beside.length > 0).length}/${goalStops.length}`);
  console.log(`  their flow opened as a node graph  : ${editor.editorOpen}`);
  console.log(`  nodes the surface found            : ${editor.nodes.length}`);
  console.log(`  the pebble stopped on their nodes  : ${flowStops.filter((s) => s.beside.length > 0).length}/${flowStops.length}`);
}

main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
