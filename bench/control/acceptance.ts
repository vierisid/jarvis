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
 *        (bench/control/README.md lists which sidecar build each suite needs)
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
 * Checks the connected sidecar cannot run (an RPC or feature its build lacks,
 * or a missing capability) are reported as SKIP, not FAIL.
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

const SUITES = ['phase0', 'browser', 'desktop', 'all'];

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
  const suite = get('--suite', 'all')!;
  if (!SUITES.includes(suite)) {
    console.error(`ERROR: unknown --suite "${suite}" (expected ${SUITES.join(' | ')}).`);
    process.exit(2);
  }
  return {
    base: get('--base', 'http://127.0.0.1:3142')!,
    target: get('--target'),
    suite,
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

type SidecarRow = { id?: string; name: string; connected: boolean; capabilities?: string[] };

/** The endpoint answered 404: the gate is off or the token is wrong, so nothing else can run. */
class GateClosedError extends Error {}

class Driver {
  constructor(private opts: Opts) {}

  /** POST to the debug endpoint. Throws on a closed gate, a transport failure or a non-JSON reply. */
  private async post(body: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    const res = await fetch(`${this.opts.base}/api/debug/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-debug-rpc-token': this.opts.token },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 404) {
      throw new GateClosedError('debug RPC endpoint returned 404: daemon not started with a matching JARVIS_DEBUG_RPC, or wrong token');
    }
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`HTTP ${res.status} with a non-JSON body: ${text.slice(0, 200)}`);
    }
  }

  async rpc(method: string, params: Record<string, unknown> = {}): Promise<RpcResponse> {
    // Generous ceiling: a real desktop/browser RPC can take seconds, but a
    // dead daemon must not hang the whole run.
    try {
      return (await this.post({ target: this.opts.target, method, params }, 130_000)) as RpcResponse;
    } catch (e) {
      // A closed gate stops the run. Anything else (timeout, dead daemon,
      // garbage reply) fails only the check that made this call.
      if (e instanceof GateClosedError) throw e;
      return { error: `request failed: ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  async listSidecars(): Promise<SidecarRow[]> {
    // Go through the debug endpoint (secret-gated, bypasses the dashboard
    // access-token gate) rather than the authed /api/sidecars.
    return (await this.post({ method: '__list_sidecars' }, 5_000)) as SidecarRow[];
  }
}

// ── result model ─────────────────────────────────────────────────────
type Status = 'pass' | 'fail' | 'skip';
type Check = {
  name: string;
  status: Status;
  detail: string;
  ms?: number;
};
const checks: Check[] = [];
const TAGS: Record<Status, string> = {
  pass: '\x1b[32mPASS\x1b[0m',
  fail: '\x1b[31mFAIL\x1b[0m',
  skip: '\x1b[33mSKIP\x1b[0m',
};
function push(c: Check): Check {
  checks.push(c);
  console.log(`  ${TAGS[c.status]}  ${c.name}${c.ms !== undefined ? ` (${c.ms}ms)` : ''} - ${c.detail}`);
  return c;
}
function record(name: string, pass: boolean, detail: string, ms?: number): Check {
  return push({ name, status: pass ? 'pass' : 'fail', detail, ms });
}
/** A check the connected sidecar cannot run. Listed in the report, but not a failure. */
function skip(name: string, reason: string): Check {
  return push({ name, status: 'skip', detail: reason });
}
const countStatus = (s: Status) => checks.filter((c) => c.status === s).length;
const asObj = (r: unknown): Record<string, unknown> =>
  r && typeof r === 'object' ? (r as Record<string, unknown>) : {};

/** True when the sidecar rejected the call as an unknown method, i.e. its build predates the RPC. */
const methodMissing = (r: RpcResponse) => (r.error ?? '').includes('METHOD_NOT_FOUND');
const OLD_BUILD_HINT =
  'the connected sidecar build predates this feature. If you built a newer one, a stale auto-started ' +
  'sidecar probably reconnected in its place: stop every jarvis-sidecar process and start only the fresh binary';

/**
 * Share of the first snapshot's elements whose sig is distinct and still
 * present in the second snapshot. Dividing distinct surviving sigs by the
 * element count means missing or duplicated sigs pull the rate down instead of
 * scoring as stable.
 */
function sigReresolution(first: Array<Record<string, unknown>>, second: Array<Record<string, unknown>>) {
  const sigsOf = (es: Array<Record<string, unknown>>) =>
    new Set(es.map((e) => e.sig).filter((s): s is string => typeof s === 'string' && s !== ''));
  const before = sigsOf(first);
  const after = sigsOf(second);
  let kept = 0;
  for (const s of before) if (after.has(s)) kept++;
  const rate = first.length ? kept / first.length : 0;
  return { rate, detail: `${Math.round(rate * 100)}% of ${first.length} elements (${before.size} distinct sigs)` };
}

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

  // 2. Notepad reliability loop: launch must report a visible window, then
  //    typing into that window must not error.
  let launchOk = 0, typeOk = 0;
  let lastLaunchMs = 0;
  const typeFailures: string[] = [];
  for (let i = 0; i < opts.runs; i++) {
    const launch = await d.rpc('launch_app', { executable: opts.app });
    lastLaunchMs = launch.elapsed_ms ?? 0;
    const lr = asObj(launch.result);
    const visible = lr.window_visible === true && lr.success === true;
    if (visible) launchOk++;
    const pid = windowPidOf(launch.result);

    if (visible && pid !== undefined) {
      // Type only into the window just focused. If focus did not succeed, the
      // foreground window is unknown (it may be the user's own), so this run
      // sends no input at all and counts as a typing failure. Linux and macOS
      // report a refused focus as {success:false} with no RPC error, and a
      // detached reply has no result, so require an explicit success.
      const focus = await d.rpc('focus_window', { pid });
      if (focus.error || asObj(focus.result).success !== true) {
        const why = focus.error ?? `result ${JSON.stringify(focus.result ?? null)}`;
        typeFailures.push(`run ${i + 1}: focus_window(pid ${pid}) did not succeed: ${why.slice(0, 100)}`);
      } else {
        const type = await d.rpc('type_text', { text: `jarvis acceptance run ${i + 1}\n` });
        if (!type.error && asObj(type.result).success === true) typeOk++;
        else typeFailures.push(`run ${i + 1}: ${type.error?.slice(0, 100) ?? 'type_text did not report success'}`);
      }
    }
    await sleep(200);
  }
  record(`launch_app reports visible window (${launchOk}/${opts.runs})`,
    launchOk / opts.runs >= 0.95, `${Math.round((100 * launchOk) / opts.runs)}% visible`, lastLaunchMs);
  record(`type after launch succeeds (${typeOk}/${opts.runs})`,
    typeOk / opts.runs >= 0.95,
    `${Math.round((100 * typeOk) / opts.runs)}% typed without error${typeFailures.length ? `; first failure: ${typeFailures[0]}` : ''}`);
  // There is no close RPC, and closing by keystroke could land in the wrong
  // window, so the launched windows stay open.
  if (launchOk > 0) console.log(`  note: ${launchOk} launch(es) of ${opts.app} left open; close them without saving`);

  // 3. list_windows latency (native path should be ~ms, not ~second).
  {
    const r = await d.rpc('list_windows', {});
    const count = Array.isArray(asObj(r.result).windows) ? (asObj(r.result).windows as unknown[]).length : 0;
    record('list_windows is fast (native path)', !r.error && (r.elapsed_ms ?? 9999) < 300,
      r.error ? `error: ${r.error.slice(0, 120)}` : `${count} windows`, r.elapsed_ms);
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
    if (pid === undefined) {
      record('find_element miss returns hint/similar', false,
        `launch_app returned no pid: ${launch.error ?? JSON.stringify(launch.result)}`.slice(0, 160));
    } else {
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
  }

  // 6. press_keys win chord (real Windows key). Opens Run dialog; we just
  //    assert no error, then Esc to dismiss.
  {
    const r = await d.rpc('press_keys', { keys: 'win,r' });
    record('win+r chord dispatches without error', !r.error, r.error ?? 'ok', r.elapsed_ms);
    // Only dismiss a dialog the chord could have opened; after a failed chord
    // the Esc would land in whatever window is in front.
    if (!r.error) {
      await sleep(300);
      await d.rpc('press_keys', { keys: 'escape' });
    }
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

  // Everything below needs the browser_ax_* RPCs.
  let axSnap = await d.rpc('browser_ax_snapshot', {});
  if (methodMissing(axSnap)) {
    skip('browser AX checks (refs, payload size, sig stability, compose flow)',
      `browser_ax_snapshot is not implemented: ${OLD_BUILD_HINT}`);
    return;
  }

  // Gmail is a heavy SPA — the inbox (and the Compose button) render several
  // seconds after navigation, well after the top-bar shell. Poll the AX tree
  // until Compose appears (or the element count stops growing) so we snapshot
  // a settled page, not the loading shell.
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
    `${axSnap.error ? `error: ${axSnap.error.slice(0, 100)}; ` : ''}${elems.length} elements, ${axBytes}B, ${elems.length ? 'refs present' : 'NO refs'}`, axSnap.elapsed_ms);

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
  } else {
    // Without a baseline the criterion is unmeasured; fail it rather than drop the row.
    record('AX snapshot ≥8× smaller than screenshot payload', false,
      `no screenshot to compare against: ${shot.error?.slice(0, 100) ?? 'empty image data'}`);
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
    const { rate, detail } = sigReresolution(e1, e2);
    const snapError = s1.error ?? s2.error;
    record('sig re-resolution across re-snapshot ≥95%', rate >= 0.95,
      snapError ? `error: ${snapError.slice(0, 120)}` : `${detail} re-resolved (settled page)`);
  }

  // Find the Compose control and click it by ref.
  const compose = elems.find((e) =>
    typeof e.name === 'string' && /compose/i.test(e.name) && e.interactive === true);
  if (compose) {
    const click = await d.rpc('browser_ax_click', { backend_node_id: compose.backend_node_id });
    record('AX-click Compose by backend_node_id', !click.error, click.error ?? 'clicked', click.elapsed_ms);

    // Re-snapshot until the To / Subject fields render. Require an EDITABLE,
    // real (backend>0) element — Gmail exposes non-editable "To"/"Subject"
    // labels and AX wrappers with the same name, which aren't settable. The
    // compose dialog renders asynchronously, so poll instead of a fixed sleep.
    const editableRoles = new Set(['textbox', 'combobox', 'searchbox', 'textfield']);
    let e2: Array<Record<string, unknown>> = [];
    const field = (re: RegExp) => {
      const matches = e2.filter((e) =>
        typeof e.name === 'string' && re.test(e.name as string) &&
        e.interactive === true && typeof e.backend_node_id === 'number' && (e.backend_node_id as number) > 0);
      return matches.find((e) => editableRoles.has(e.role as string)) ?? matches[0];
    };
    let to: Record<string, unknown> | undefined;
    for (const deadline = Date.now() + 8_000; ; ) {
      await sleep(700);
      const s2 = await d.rpc('browser_ax_snapshot', {});
      e2 = (asObj(s2.result).elements as Array<Record<string, unknown>>) ?? [];
      to = field(/^to\b|recipients/i);
      if (to || Date.now() >= deadline) break;
    }
    const subj = field(/^subject/i);
    if (to) {
      const r = await d.rpc('browser_ax_set_value', { backend_node_id: to.backend_node_id, value: 'nobody@example.com' });
      record('AX-set To field (read-back verified)', !r.error && asObj(asObj(r.result).readback).value === 'nobody@example.com',
        r.error ?? `readback=${JSON.stringify(asObj(r.result).readback)}`);
    } else {
      // Dump the editable fields in the compose window so we can see the real
      // accessible names/roles (Gmail's To/Subject naming isn't standardized).
      const editable = e2
        .filter((e) => e.interactive === true && editableRoles.has(e.role as string))
        .map((e) => `${e.role} "${e.name}"`)
        .slice(0, 30);
      record('AX-set To field', false,
        `no editable field matching /to|recipients/. Editable fields in compose: ${editable.join(' | ') || '(none — compose may not have rendered; ' + e2.length + ' total elements)'}`);
    }
    if (subj) {
      const r = await d.rpc('browser_ax_set_value', { backend_node_id: subj.backend_node_id, value: 'JARVIS acceptance test' });
      record('AX-set Subject field', !r.error, r.error ?? 'set');
    }
    // Deliberately do NOT send — leave the draft for manual inspection.
    console.log('  note: compose draft left unsent for manual inspection');
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
  const SNAPSHOT_CHECK = 'semantic snapshot emits sig/path/ordinal';
  const RERESOLVE_CHECK = 'desktop sig re-resolution ≥95%';

  const launch = await d.rpc('launch_app', { executable: opts.app });
  const pid = windowPidOf(launch.result); // window pid — packaged apps differ from launcher pid
  if (pid === undefined || asObj(launch.result).window_visible !== true) {
    record(SNAPSHOT_CHECK, false,
      `no window to snapshot: launch_app ${launch.error ? `error: ${launch.error}` : `returned ${JSON.stringify(launch.result)}`}`.slice(0, 200));
    skip(RERESOLVE_CHECK, 'no first snapshot to compare against');
    return;
  }
  await sleep(600);

  const snap = await d.rpc('get_window_tree', { pid, semantic: true, depth: 8 });
  if (snap.error) {
    record(SNAPSHOT_CHECK, false, `RPC error (pid ${pid}): ${snap.error.slice(0, 140)}`, snap.elapsed_ms);
    skip(RERESOLVE_CHECK, 'no first snapshot to compare against');
    return;
  }
  const res = asObj(snap.result);
  const els = Array.isArray(res.elements) ? (res.elements as Array<Record<string, unknown>>) : [];
  // A build without semantic refs ignores `semantic` and emits no sig key at all.
  if (els.length > 0 && !els.some((e) => 'sig' in e)) {
    const reason = `get_window_tree ignored semantic:true (no element has a sig): ${OLD_BUILD_HINT}`;
    skip(SNAPSHOT_CHECK, reason);
    skip(RERESOLVE_CHECK, reason);
    return;
  }
  const withSig = els.filter((e) => typeof e.sig === 'string' && e.sig !== '').length;
  record(SNAPSHOT_CHECK,
    els.length > 0 && withSig === els.length,
    els.length === 0 ? `0 elements for pid ${pid} (window under a different pid? launch returned pid=${asObj(launch.result).pid}, window_pid=${asObj(launch.result).window_pid})` : `${withSig}/${els.length} elements carry a sig`, snap.elapsed_ms);

  // Re-snapshot and confirm sigs are stable for an unchanged window.
  const snap2 = await d.rpc('get_window_tree', { pid, semantic: true, depth: 8 });
  const els2 = (asObj(snap2.result).elements as Array<Record<string, unknown>>) ?? [];
  const { rate, detail } = sigReresolution(els, els2);
  record(RERESOLVE_CHECK, rate >= 0.95,
    snap2.error ? `error on re-snapshot: ${snap2.error.slice(0, 120)}` : `${detail} re-resolved`);
}

// ── report ───────────────────────────────────────────────────────────
const REPORT_MARK: Record<Status, string> = { pass: '✅', fail: '❌', skip: 'SKIP' };

async function writeReport(opts: Opts, meta: Record<string, string>) {
  const lines: string[] = [];
  lines.push('# Control-plane acceptance report', '');
  lines.push(`- Run: ${new Date().toISOString()}`);
  for (const [k, v] of Object.entries(meta)) lines.push(`- ${k}: ${v}`);
  lines.push(`- Result: **${countStatus('pass')}/${checks.length} checks passed**, ${countStatus('fail')} failed, ${countStatus('skip')} skipped`, '');
  lines.push('| Check | Result | ms | Detail |', '|---|---|---|---|');
  for (const c of checks) {
    lines.push(`| ${c.name} | ${REPORT_MARK[c.status]} | ${c.ms ?? ''} | ${c.detail.replace(/\|/g, '\\|')} |`);
  }
  lines.push('', '> Latency/token numbers are single-run; average across a few runs before recording in docs/control-plane/PHASE1_ADOPT_VS_BUILD.md.');
  const text = lines.join('\n');
  try {
    await Bun.write(opts.out, text);
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
  // The sidecar list is an array on success, or {error} (e.g. the sidecar
  // subsystem isn't up). Surface the real response instead of crashing.
  if (!Array.isArray(sidecars)) {
    const body = sidecars as unknown as { error?: string };
    console.error(
      `Daemon reachable but the sidecar list did not come back as a list: ${JSON.stringify(sidecars)}.\n` +
      (body?.error
        ? `The daemon reports: "${body.error}". The sidecar subsystem may not have started — check the daemon's startup logs.`
        : 'Is this the branch daemon (bun run src/daemon/index.ts), not the global "jarvis"?'),
    );
    process.exit(2);
  }
  const connected = sidecars.filter((s) => s.connected);
  if (connected.length === 0) {
    const names = sidecars.map((s) => s.name).join(', ') || 'none enrolled';
    console.error(`No connected sidecar (enrolled: ${names}). Start the sidecar and confirm it connects, then retry.`);
    process.exit(2);
  }
  const wanted = opts.target?.toLowerCase();
  const chosen = wanted
    ? connected.find((s) => s.id?.toLowerCase() === wanted || s.name.toLowerCase() === wanted)
    : connected[0];
  if (!chosen) {
    console.error(`Target "${opts.target}" not connected. Connected: ${connected.map((s) => s.name).join(', ')}`);
    process.exit(2);
  }
  // Pin every RPC to the sidecar whose capabilities are checked below; with no
  // target the daemon would pick its own first connected sidecar.
  opts.target = chosen.id ?? chosen.name;
  console.log(`Driving sidecar "${chosen.name}" [caps: ${(chosen.capabilities ?? []).join(', ')}]`);
  const caps = new Set(chosen.capabilities ?? []);

  const suites: Array<[name: string, capability: string, run: (d: Driver, opts: Opts) => Promise<void>]> = [
    ['phase0', 'desktop', suitePhase0],
    ['browser', 'browser', suiteBrowser],
    ['desktop', 'desktop', suiteDesktop],
  ];
  let gateClosed = false;
  for (const [name, capability, run] of suites) {
    if (opts.suite !== 'all' && opts.suite !== name) continue;
    if (!caps.has(capability)) {
      skip(`${name} suite`, `sidecar lacks the ${capability} capability`);
      continue;
    }
    try {
      await run(d, opts);
    } catch (e) {
      // A closed gate (daemon restarted without the secret?) ends the run but
      // keeps what was already measured; any other throw fails only its suite.
      // Either way the abort is a row in the report, not just console output.
      record(`${name} suite ran to completion`, false, `aborted: ${e instanceof Error ? e.message : String(e)}`);
      if (e instanceof GateClosedError) {
        gateClosed = true;
        break;
      }
    }
  }

  await writeReport(opts, {
    sidecar: chosen.name,
    suite: opts.suite,
    app: opts.app,
    'gmail-url': opts.gmailUrl,
  });

  const failed = countStatus('fail');
  const verified = checks.length - countStatus('skip');
  console.log(`\n${countStatus('pass')}/${checks.length} checks passed, ${failed} failed, ${countStatus('skip')} skipped.`);
  // A run that verified nothing is not a pass.
  if (verified === 0) console.error('Nothing was verified: every check was skipped.');
  process.exit(gateClosed ? 2 : failed > 0 || verified === 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(`acceptance driver crashed: ${e instanceof Error ? e.stack : String(e)}`);
  process.exit(2);
});
