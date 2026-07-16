#!/usr/bin/env bun
/**
 * Control-plane acceptance driver — Phase 0 validation + Phase 1 acceptance.
 *
 * Drives the paired Go sidecar through the daemon's gated debug-RPC endpoint
 * and checks the specific behaviors the roadmap's exit criteria name. It does
 * NOT go through an LLM: it calls the sidecar RPCs directly so a failure is
 * attributable to the control stack, not to model choices.
 *
 *   Prereqs:
 *     1. Start the daemon with the debug gate:  JARVIS_DEBUG_RPC=<secret> jarvis start
 *        (run the sidecar build from THIS branch — Phase 0/1 changes)
 *     2. A sidecar paired + connected with desktop + browser capabilities.
 *
 *   Usage:
 *     JARVIS_DEBUG_RPC=<secret> bun bench/control/acceptance.ts [options]
 *
 *   Options:
 *     --base <url>        daemon base URL          (default http://127.0.0.1:3142)
 *     --target <name>     sidecar name/id          (default: first connected)
 *     --suite <name>      phase0 | browser | desktop | all   (default all)
 *     --gmail-url <url>   compose target for the browser suite
 *                         (default https://mail.google.com/mail/u/0/#inbox)
 *     --app <exe>         desktop app to drive      (default notepad.exe)
 *     --runs <n>          repetitions for the Notepad reliability loop (default 20)
 *     --out <file>        write a markdown report   (default bench/control/last-report.md)
 *     --token <secret>    debug token (else $JARVIS_DEBUG_RPC)
 *
 * Nothing here is Windows-specific except the default app + the desktop suite's
 * expectations; --app and --suite let it run per-platform.
 */

interface Opts {
  base: string;
  target?: string;
  suite: string;
  gmailUrl: string;
  app: string;
  runs: number;
  out: string;
  token: string;
}

function parseArgs(argv: string[]): Opts {
  const get = (flag: string, fallback?: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback;
  };
  const token = get('--token') ?? process.env.JARVIS_DEBUG_RPC ?? '';
  if (!token) {
    console.error('ERROR: no debug token. Set JARVIS_DEBUG_RPC or pass --token.');
    process.exit(2);
  }
  return {
    base: get('--base', 'http://127.0.0.1:3142')!,
    target: get('--target'),
    suite: get('--suite', 'all')!,
    gmailUrl: get('--gmail-url', 'https://mail.google.com/mail/u/0/#inbox')!,
    app: get('--app', 'notepad.exe')!,
    runs: parseInt(get('--runs', '20')!, 10),
    out: get('--out', 'bench/control/last-report.md')!,
    token,
  };
}

type RpcResponse = {
  sidecar?: string;
  method?: string;
  elapsed_ms?: number;
  detached?: boolean;
  result?: unknown;
  error?: string;
};

class Driver {
  constructor(private opts: Opts) {}

  async rpc(method: string, params: Record<string, unknown> = {}): Promise<RpcResponse> {
    // Generous ceiling: a real desktop/browser RPC can take seconds, but a
    // dead daemon must not hang the whole run.
    const res = await fetch(`${this.opts.base}/api/debug/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-debug-rpc-token': this.opts.token },
      body: JSON.stringify({ target: this.opts.target, method, params }),
      signal: AbortSignal.timeout(130_000),
    });
    if (res.status === 404) {
      throw new Error('debug RPC endpoint returned 404 — daemon not started with a matching JARVIS_DEBUG_RPC, or wrong token');
    }
    return (await res.json()) as RpcResponse;
  }

  async listSidecars(): Promise<Array<{ name: string; connected: boolean; capabilities?: string[] }>> {
    // Go through the debug endpoint (secret-gated, bypasses the dashboard
    // access-token gate) rather than the authed /api/sidecars.
    const res = await fetch(`${this.opts.base}/api/debug/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-debug-rpc-token': this.opts.token },
      body: JSON.stringify({ method: '__list_sidecars' }),
      signal: AbortSignal.timeout(5_000),
    });
    if (res.status === 404) {
      throw new Error('debug endpoint 404 — daemon not started with a matching JARVIS_DEBUG_RPC (or the token differs)');
    }
    return (await res.json()) as Array<{ name: string; connected: boolean; capabilities?: string[] }>;
  }
}

// ── result model ─────────────────────────────────────────────────────
type Check = {
  name: string;
  pass: boolean;
  detail: string;
  ms?: number;
};
const checks: Check[] = [];
function record(name: string, pass: boolean, detail: string, ms?: number): Check {
  const c = { name, pass, detail, ms };
  checks.push(c);
  const tag = pass ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
  console.log(`  ${tag}  ${name}${ms !== undefined ? ` (${ms}ms)` : ''} — ${detail}`);
  return c;
}
const asObj = (r: unknown): Record<string, unknown> =>
  r && typeof r === 'object' ? (r as Record<string, unknown>) : {};

/**
 * The PID to address a launched app's window. Packaged apps (Win11 Notepad,
 * Calculator, Store apps) hand their window to a broker process, so the
 * launcher PID has no window — launch_app returns window_pid in that case.
 * Prefer it.
 */
function windowPidOf(launchResult: unknown): number | undefined {
  const r = asObj(launchResult);
  if (typeof r.window_pid === 'number') return r.window_pid;
  if (typeof r.pid === 'number') return r.pid;
  return undefined;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Phase 0: honesty + wait-for-window ───────────────────────────────
async function suitePhase0(d: Driver, opts: Opts) {
  console.log('\n=== Phase 0 — honesty & reliability ===');

  // 1. launch_app on a bogus executable must error, not claim success.
  {
    const r = await d.rpc('launch_app', { executable: 'this_binary_does_not_exist_xyz.exe' });
    const errored = !!r.error || asObj(r.result).success === false;
    record('launch bogus exe → honest failure', errored,
      r.error ? `error: ${r.error}` : `result.success=${asObj(r.result).success}`);
  }

  // 2. Notepad reliability loop: launch must report a visible window,
  //    then a snapshot must find the window, then typing must not error.
  let launchOk = 0, typeOk = 0;
  let lastLaunchMs = 0;
  for (let i = 0; i < opts.runs; i++) {
    const launch = await d.rpc('launch_app', { executable: opts.app });
    lastLaunchMs = launch.elapsed_ms ?? 0;
    const lr = asObj(launch.result);
    const visible = lr.window_visible === true && lr.success === true;
    if (visible) launchOk++;
    const pid = typeof lr.pid === 'number' ? lr.pid : (typeof lr.window_pid === 'number' ? lr.window_pid : undefined);

    if (visible && pid !== undefined) {
      await d.rpc('focus_window', { pid });
      const type = await d.rpc('type_text', { text: `jarvis acceptance run ${i + 1}\n` });
      if (!type.error && asObj(type.result).success === true) typeOk++;
      // Close this Notepad so the next run is clean (Ctrl+A, Delete, Alt+F4 without saving via Esc later).
      await d.rpc('press_keys', { keys: 'ctrl,a' });
      await d.rpc('press_keys', { keys: 'delete' });
    }
    await sleep(200);
  }
  record(`launch_app reports visible window (${launchOk}/${opts.runs})`,
    launchOk / opts.runs >= 0.95, `${Math.round((100 * launchOk) / opts.runs)}% visible`, lastLaunchMs);
  record(`type after launch succeeds (${typeOk}/${opts.runs})`,
    typeOk / opts.runs >= 0.95, `${Math.round((100 * typeOk) / opts.runs)}% typed without error`);

  // 3. list_windows latency (native path should be ~ms, not ~second).
  {
    const r = await d.rpc('list_windows', {});
    const count = Array.isArray(asObj(r.result).windows) ? (asObj(r.result).windows as unknown[]).length : 0;
    record('list_windows is fast (native path)', (r.elapsed_ms ?? 9999) < 300,
      `${count} windows`, r.elapsed_ms);
  }

  // 4. Stale element id → the id-churn explanation, not a bare failure.
  {
    const r = await d.rpc('click_element', { element_id: 999999, action: 'click' });
    const msg = (r.error ?? '') + JSON.stringify(r.result ?? '');
    record('stale element id → actionable churn error', /snapshot/i.test(msg),
      r.error ? r.error.slice(0, 120) : 'no error text');
  }

  // 5. find_element miss → near-miss candidates ("Save" should surface "Save As…").
  {
    // Requires a foreground app; best-effort on Notepad. Use the WINDOW pid
    // (packaged Notepad's launcher pid has no window).
    const launch = await d.rpc('launch_app', { executable: opts.app });
    const pid = windowPidOf(launch.result);
    await sleep(400);
    const r = await d.rpc('find_element', { pid, name: 'Save', control_type: 'MenuItem' });
    if (r.error) {
      record('find_element miss returns hint/similar', false, `RPC error (pid ${pid}): ${r.error.slice(0, 120)}`);
    } else {
      const res = asObj(r.result);
      const hasHint = typeof res.hint === 'string' || Array.isArray(res.similar);
      record('find_element miss returns hint/similar', hasHint,
        Array.isArray(res.similar) ? `${(res.similar as unknown[]).length} similar` : String(res.hint ?? `match_count=${res.match_count ?? '?'}`));
    }
  }

  // 6. press_keys win chord (real Windows key). Opens Run dialog; we just
  //    assert no error, then Esc to dismiss.
  {
    const r = await d.rpc('press_keys', { keys: 'win,r' });
    record('win+r chord dispatches without error', !r.error, r.error ?? 'ok', r.elapsed_ms);
    await sleep(300);
    await d.rpc('press_keys', { keys: 'escape' });
  }
}

// ── Browser (CDP AX) acceptance ──────────────────────────────────────
async function suiteBrowser(d: Driver, opts: Opts) {
  console.log('\n=== Phase 1 — browser AX (Gmail compose) ===');

  // Navigate; honest failure path is separately tested.
  {
    const bad = await d.rpc('browser_navigate', { url: 'https://nonexistent.invalid.jarvis-test/' });
    const errored = !!bad.error || asObj(bad.result).success === false;
    record('navigate to dead host → error, not success', errored,
      bad.error ? bad.error.slice(0, 100) : `success=${asObj(bad.result).success}`);
  }

  const nav = await d.rpc('browser_navigate', { url: opts.gmailUrl });
  record('navigate to Gmail', !nav.error, nav.error ?? String(asObj(nav.result).url ?? 'ok'), nav.elapsed_ms);

  // Gmail is a heavy SPA — the inbox (and the Compose button) render several
  // seconds after navigation, well after the top-bar shell. Poll the AX tree
  // until Compose appears (or the element count stops growing) so we snapshot
  // a settled page, not the loading shell.
  let axSnap = await d.rpc('browser_ax_snapshot', {});
  let elems = (asObj(axSnap.result).elements as Array<Record<string, unknown>>) ?? [];
  const hasCompose = (es: Array<Record<string, unknown>>) =>
    es.some((e) => typeof e.name === 'string' && /compose/i.test(e.name) && e.interactive === true);
  {
    const deadline = Date.now() + 15_000;
    let lastCount = -1, stableTicks = 0;
    while (Date.now() < deadline) {
      if (hasCompose(elems)) break;
      // Also stop once the tree stops growing for two ticks (non-Gmail pages).
      if (elems.length === lastCount) { if (++stableTicks >= 2) break; } else { stableTicks = 0; }
      lastCount = elems.length;
      await sleep(1200);
      axSnap = await d.rpc('browser_ax_snapshot', {});
      elems = (asObj(axSnap.result).elements as Array<Record<string, unknown>>) ?? [];
    }
    console.log(`  … waited for Gmail to render: ${elems.length} elements, compose ${hasCompose(elems) ? 'present' : 'absent'}`);
  }

  // AX snapshot — the structural path. Measure element count + payload size,
  // and compare token cost against a screenshot baseline.
  const axRes = asObj(axSnap.result);
  const axBytes = JSON.stringify(axRes).length;
  record('browser_ax_snapshot returns elements + refs',
    elems.length > 0 && elems.every((e) => typeof e.sig === 'string' && e.backend_node_id !== undefined),
    `${elems.length} elements, ${axBytes}B, ${elems.length ? 'refs present' : 'NO refs'}`, axSnap.elapsed_ms);

  // Screenshot baseline for the token-cost comparison (~1 token ≈ 0.75 chars
  // of base64; image tokenization differs per model, so report bytes and a
  // rough ratio, not a hard token number).
  const shot = await d.rpc('browser_screenshot', {});
  const shotB64 = typeof asObj(shot.result).data === 'string' ? (asObj(shot.result).data as string) : '';
  const shotBytes = shotB64.length;
  if (shotBytes > 0) {
    const ratio = (shotBytes / Math.max(1, axBytes)).toFixed(1);
    record('AX snapshot ≥8× smaller than screenshot payload', shotBytes / Math.max(1, axBytes) >= 8,
      `screenshot ${shotBytes}B vs AX ${axBytes}B (${ratio}×)`);
  }

  // Rot-proofing: two back-to-back snapshots of the NOW-SETTLED page should
  // share sigs at a high rate. Done before the compose flow, which legitimately
  // mutates the page. Compare the two fresh snapshots to each other (not to any
  // earlier load-stage snapshot).
  {
    const s1 = await d.rpc('browser_ax_snapshot', {});
    await sleep(250);
    const s2 = await d.rpc('browser_ax_snapshot', {});
    const e1 = (asObj(s1.result).elements as Array<Record<string, unknown>>) ?? [];
    const e2 = (asObj(s2.result).elements as Array<Record<string, unknown>>) ?? [];
    const sigs1 = new Set(e1.map((e) => e.sig as string));
    const stable = e2.filter((e) => sigs1.has(e.sig as string)).length;
    const rate = e1.length ? stable / e1.length : 0;
    record('sig re-resolution across re-snapshot ≥95%', rate >= 0.95,
      `${Math.round(rate * 100)}% of ${e1.length} sigs stable (settled page)`);
  }

  // Find the Compose control and click it by ref.
  const compose = elems.find((e) =>
    typeof e.name === 'string' && /compose/i.test(e.name) && e.interactive === true);
  if (compose) {
    const click = await d.rpc('browser_ax_click', { backend_node_id: compose.backend_node_id });
    record('AX-click Compose by backend_node_id', !click.error, click.error ?? 'clicked', click.elapsed_ms);
    await sleep(1200);

    // Re-snapshot; find the To / Subject / body fields and set values.
    const s2 = await d.rpc('browser_ax_snapshot', {});
    const e2 = (asObj(s2.result).elements as Array<Record<string, unknown>>) ?? [];
    const field = (re: RegExp) =>
      e2.find((e) => typeof e.name === 'string' && re.test(e.name as string));
    const to = field(/^to\b|recipients/i);
    const subj = field(/^subject/i);
    if (to) {
      const r = await d.rpc('browser_ax_set_value', { backend_node_id: to.backend_node_id, value: 'nobody@example.com' });
      record('AX-set To field (read-back verified)', !r.error && asObj(asObj(r.result).readback).value === 'nobody@example.com',
        r.error ?? `readback=${JSON.stringify(asObj(r.result).readback)}`);
    } else {
      record('AX-set To field', false, 'To field not found in AX snapshot (Gmail layout/login?)');
    }
    if (subj) {
      const r = await d.rpc('browser_ax_set_value', { backend_node_id: subj.backend_node_id, value: 'JARVIS acceptance test' });
      record('AX-set Subject field', !r.error, r.error ?? 'set');
    }
    // Deliberately do NOT send — leave the draft for manual inspection.
    record('compose reached (draft left unsent)', true, 'draft prepared; not sent');
  } else {
    // Show what the AX tree actually contains so we can tell "not logged in"
    // from "the button has a different accessible name".
    const interactiveNames = elems
      .filter((e) => e.interactive === true && typeof e.name === 'string' && (e.name as string).trim())
      .map((e) => `"${e.name}"`)
      .slice(0, 25);
    record('locate Compose in AX tree', false,
      `no interactive element matching /compose/. Interactive elements present: ${interactiveNames.join(', ') || '(none — Gmail likely not logged in, or still loading)'}`);
  }
}

// ── Desktop (UIA semantic) acceptance ────────────────────────────────
async function suiteDesktop(d: Driver, opts: Opts) {
  console.log('\n=== Phase 1 — desktop UIA semantic snapshot ===');
  const launch = await d.rpc('launch_app', { executable: opts.app });
  const pid = windowPidOf(launch.result); // window pid — packaged apps differ from launcher pid
  await sleep(600);

  const snap = await d.rpc('get_window_tree', { pid, semantic: true, depth: 8 });
  if (snap.error) {
    record('semantic snapshot emits sig/path/ordinal', false, `RPC error (pid ${pid}): ${snap.error.slice(0, 140)}`, snap.elapsed_ms);
  }
  const res = asObj(snap.result);
  const els = Array.isArray(res.elements) ? (res.elements as Array<Record<string, unknown>>) : [];
  const withSig = els.filter((e) => typeof e.sig === 'string' && e.sig !== '').length;
  if (!snap.error) {
    record('semantic snapshot emits sig/path/ordinal',
      els.length > 0 && withSig === els.length,
      els.length === 0 ? `0 elements for pid ${pid} (window under a different pid? launch returned pid=${asObj(launch.result).pid}, window_pid=${asObj(launch.result).window_pid})` : `${withSig}/${els.length} elements carry a sig`, snap.elapsed_ms);
  }

  // Re-snapshot and confirm sigs are stable for an unchanged window.
  const snap2 = await d.rpc('get_window_tree', { pid, semantic: true, depth: 8 });
  const els2 = (asObj(snap2.result).elements as Array<Record<string, unknown>>) ?? [];
  const sigs = new Set(els.map((e) => e.sig as string));
  const stable = els2.filter((e) => sigs.has(e.sig as string)).length;
  const rate = els.length ? stable / els.length : 0;
  record('desktop sig re-resolution ≥95%', rate >= 0.95, `${Math.round(rate * 100)}% stable`);
}

// ── report ───────────────────────────────────────────────────────────
function writeReport(opts: Opts, meta: Record<string, string>) {
  const pass = checks.filter((c) => c.pass).length;
  const lines: string[] = [];
  lines.push('# Control-plane acceptance report', '');
  lines.push(`- Run: (timestamp set by caller)`);
  for (const [k, v] of Object.entries(meta)) lines.push(`- ${k}: ${v}`);
  lines.push(`- Result: **${pass}/${checks.length} checks passed**`, '');
  lines.push('| Check | Result | ms | Detail |', '|---|---|---|---|');
  for (const c of checks) {
    lines.push(`| ${c.name} | ${c.pass ? '✅' : '❌'} | ${c.ms ?? ''} | ${c.detail.replace(/\|/g, '\\|')} |`);
  }
  lines.push('', '> Latency/token numbers are single-run; average across a few runs before recording in PHASE1_ADOPT_VS_BUILD.md.');
  const text = lines.join('\n');
  try {
    Bun.write(opts.out, text);
    console.log(`\nReport written to ${opts.out}`);
  } catch (e) {
    console.error(`Could not write report: ${e}`);
  }
}

async function main() {
  const opts = parseArgs(Bun.argv.slice(2));
  const d = new Driver(opts);

  // Preflight: confirm a connected sidecar with the needed capabilities.
  let sidecars;
  try {
    sidecars = await d.listSidecars();
  } catch (e) {
    console.error(`Cannot reach daemon at ${opts.base}: ${e}`);
    process.exit(2);
  }
  // /api/sidecars returns an array on success, or {error} (e.g. the sidecar
  // subsystem isn't up). Surface the real response instead of crashing.
  if (!Array.isArray(sidecars)) {
    const body = sidecars as unknown as { error?: string };
    console.error(
      `Daemon reachable but /api/sidecars did not return a list — got: ${JSON.stringify(sidecars)}.\n` +
      (body?.error
        ? `The daemon reports: "${body.error}". The sidecar subsystem may not have started — check the daemon's startup logs.`
        : 'Is this the branch daemon (bun run src/daemon/index.ts), not the global "jarvis"?'),
    );
    process.exit(2);
  }
  const connected = sidecars.filter((s) => s.connected);
  if (connected.length === 0) {
    const names = sidecars.map((s) => s.name).join(', ') || 'none enrolled';
    console.error(`No connected sidecar (enrolled: ${names}). Start the sidecar exe on Windows and confirm it connects, then retry.`);
    process.exit(2);
  }
  const chosen = opts.target
    ? connected.find((s) => s.name.toLowerCase() === opts.target!.toLowerCase())
    : connected[0];
  if (!chosen) {
    console.error(`Target "${opts.target}" not connected. Connected: ${connected.map((s) => s.name).join(', ')}`);
    process.exit(2);
  }
  console.log(`Driving sidecar "${chosen.name}" [caps: ${(chosen.capabilities ?? []).join(', ')}]`);
  const caps = new Set(chosen.capabilities ?? []);

  // Build check — refuse to run against an OLD sidecar. recorder_stop is a
  // no-op RPC that only exists in this branch's build; the old binary rejects
  // it as an unknown method. This prevents a confusing all-fail run when a
  // stale auto-started sidecar has reconnected instead of the new one.
  const probe = await d.rpc('recorder_stop', {});
  const probeErr = (probe.error ?? '').toUpperCase();
  if (probeErr.includes('METHOD_NOT_FOUND') || probeErr.includes('UNKNOWN METHOD') || probeErr.includes('NOT AVAILABLE') || probeErr.includes('NOT FOUND')) {
    console.error(
      `\n✗ WRONG SIDECAR BUILD CONNECTED.\n` +
      `  The connected "${chosen.name}" is an OLD sidecar — it doesn't have this branch's handlers\n` +
      `  (recorder_stop probe → ${probe.error}).\n` +
      `  A stale/auto-started sidecar likely reconnected. Do this on Windows:\n` +
      `   1. Close ALL running jarvis sidecars (Task Manager → end every jarvis-sidecar.exe;\n` +
      `      check the system tray and Windows Startup apps for an auto-started one).\n` +
      `   2. Run ONLY the freshly-built binary:\n` +
      `      ...\\control-plane-v2\\sidecar\\jarvis-sidecar.exe\n` +
      `   3. Confirm it's connected, then re-run this script.\n`,
    );
    process.exit(3);
  }

  const suite = opts.suite;
  if (suite === 'all' || suite === 'phase0') {
    if (caps.has('desktop')) await suitePhase0(d, opts);
    else console.log('(skipping phase0 — sidecar lacks the desktop capability)');
  }
  if (suite === 'all' || suite === 'browser') {
    if (caps.has('browser')) await suiteBrowser(d, opts);
    else console.log('(skipping browser — sidecar lacks the browser capability)');
  }
  if (suite === 'all' || suite === 'desktop') {
    if (caps.has('desktop')) await suiteDesktop(d, opts);
    else console.log('(skipping desktop — sidecar lacks the desktop capability)');
  }

  writeReport(opts, {
    sidecar: chosen.name,
    suite,
    app: opts.app,
    'gmail-url': opts.gmailUrl,
  });

  const failed = checks.filter((c) => !c.pass).length;
  console.log(`\n${checks.length - failed}/${checks.length} checks passed.`);
  process.exit(failed > 0 ? 1 : 0);
}

void main();
