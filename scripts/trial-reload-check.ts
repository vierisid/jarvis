/**
 * A reload at hour 20, after the conductor has stood down.
 *
 * The decision under test: re-entering the trial later leaves the founder in
 * the ordinary shell rather than replaying the conducted hour. The three
 * things that have to be true, and the third is the one that would be a
 * disaster if it were wrong:
 *
 *   1. No microphone gate. They are not being asked to start a conversation
 *      they have already had.
 *   2. No conductor layer, so their own pebble, Talk and the palette are all
 *      theirs from the first frame.
 *   3. NOT the nine-step onboarding wizard. Everything Jarvis knows about them
 *      was learned by voice (D8), and dropping them into a setup form halfway
 *      through their own trial would be the reported bug in different clothes.
 *
 * And the trial itself carries on: the clock is still on screen and the
 * entitlement is still active.
 *
 *   bun run scripts/trial-reload-check.ts <cdp-port> <daemon-url> <out-dir>
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { importPKCS8, SignJWT } from 'jose';

const PORT = process.argv[2] ?? '9333';
const BASE = process.argv[3] ?? 'http://localhost:3142';
const OUT = process.argv[4] ?? '/tmp/handover-shots';
const TRIAL_HOME = process.env.JARVIS_TRIAL_HOME ?? '/home/vierisid/.jarvis-trial';

mkdirSync(OUT, { recursive: true });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const key = await importPKCS8(readFileSync(join(TRIAL_HOME, 'sidecar-keys/private.pem'), 'utf-8'), 'ES256');
  const sid = crypto.randomUUID();
  const jwt = await new SignJWT({ sid }).setProtectedHeader({ alg: 'ES256' })
    .setSubject(`sidecar:${sid}`).setAudience('brain-api')
    .setIssuedAt().setExpirationTime('900s').sign(key);

  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json() as any[];
  const target = targets.find((t) => t.type === 'page');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise<void>((res) => ws.addEventListener('open', () => res(), { once: true }));
  let id = 0;
  const pending = new Map<number, (v: any) => void>();
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(String(e.data));
    pending.get(m.id)?.(m.result);
    pending.delete(m.id);
  });
  const send = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<any>((ok) => { const n = ++id; pending.set(n, ok); ws.send(JSON.stringify({ id: n, method, params })); });
  const ev = async (expr: string) =>
    (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }))?.result?.value;

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

  const status = await (await fetch(`${BASE}/api/trial/status`, { headers: { Cookie: `token=${jwt}` } })).json();
  console.log(`the entitlement, as the daemon reports it:\n  ${JSON.stringify(status)}\n`);

  console.log('reloading, as a founder coming back at hour 20…');
  await send('Page.navigate', { url: `${BASE}/?token=${jwt}` });
  await sleep(5000);

  const seen = await ev(`(() => {
    const vis = (el) => { if (!el) return false; const s = getComputedStyle(el); const r = el.getBoundingClientRect(); return s.display !== 'none' && r.width > 4; };
    return {
      micGate:  !!document.querySelector('.tc-gate'),
      wizard:   !!document.querySelector('[class*="ob-"], [class*="onboarding"], [class*="wizard"]'),
      marker:   document.documentElement.dataset.trialConductor ?? null,
      conductorPebble: [...document.querySelectorAll('.tc-pebble .tc-drop')].filter(vis).length,
      dockedPebble:    [...document.querySelectorAll('.rs-peb')].filter(vis).length,
      shell:    !!document.querySelector('.rshell'),
      index:    [...document.querySelectorAll('[data-nav-room]')].length,
      clock:    document.querySelector('.tc-foot-clock')?.textContent ?? null,
      card:     !!document.querySelector('.tc-prop'),
      top:      (document.querySelector('.rs-top')?.innerText || '').replace(/[ \\t\\r\\n]+/g, ' ').trim().slice(0, 60),
    };
  })()`);
  console.log(JSON.stringify(seen, null, 2));

  const png = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(OUT, '11-reload-after-handover.png'), Buffer.from(png.data, 'base64'));
  console.log('  ▸ 11-reload-after-handover.png');

  // And it is usable: ⌘J summons Talk from the first frame, with no handover
  // needed and nobody to ask.
  for (const type of ['keyDown', 'keyUp']) {
    await send('Input.dispatchKeyEvent', { type, key: 'j', code: 'KeyJ', windowsVirtualKeyCode: 74, nativeVirtualKeyCode: 74, modifiers: 2 });
  }
  await sleep(900);
  const talk = await ev(`!!document.querySelector('.rs-talk') && getComputedStyle(document.querySelector('.rs-talk')).display !== 'none'`);
  const png2 = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(OUT, '12-reload-talk.png'), Buffer.from(png2.data, 'base64'));
  console.log('  ▸ 12-reload-talk.png');

  console.log('\n════════ verdict ════════');
  console.log(`  no microphone gate       : ${seen.micGate === false}`);
  console.log(`  no onboarding wizard     : ${seen.wizard === false}`);
  console.log(`  no conductor layer       : ${seen.marker === null && seen.conductorPebble === 0}`);
  console.log(`  the ordinary shell       : ${seen.shell} (${seen.index} rooms in the Index)`);
  console.log(`  their own pebble         : ${seen.dockedPebble}`);
  console.log(`  ⌘J summons Talk          : ${talk}`);
  console.log(`  the trial is still on    : ${seen.clock}`);
  console.log(`  entitlement state        : ${status.state}, conductor finished ${status.conductor_finished_at !== null}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
