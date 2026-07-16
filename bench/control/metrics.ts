#!/usr/bin/env bun
/**
 * Control-plane self-benchmark — the reliability claims, as regression-tested
 * numbers (roadmap §6 / Phase 5).
 *
 * Runs a task list N times each through the structural path (via the gated
 * debug-RPC endpoint), and publishes a success matrix + the structural-vs-
 * vision ratio + a token-cost proxy (accessibility payload bytes vs a
 * screenshot). Unlike acceptance.ts (pass/fail gate), this produces the
 * *matrix* the decision doc and marketing want, and is meant to be run
 * repeatedly to catch regressions.
 *
 *   JARVIS_DEBUG_RPC=<secret> bun bench/control/metrics.ts [--runs 5] [--out report.md]
 *
 * Tasks are simple, deterministic structural probes so a number regression is
 * attributable to the control stack, not model variance (no LLM in the loop).
 */

interface Task {
  name: string;
  kind: 'desktop' | 'browser';
  /** RPC method + params that exercises the structural path. */
  method: string;
  params: Record<string, unknown>;
  /** Extract (success, elementCount, structuralBytes) from the RPC result. */
  measure: (result: unknown) => { ok: boolean; elements: number; bytes: number };
}

type Opts = { base: string; token: string; runs: number; out: string; target?: string };

function parseArgs(argv: string[]): Opts {
  const get = (f: string, d?: string) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
  const token = get('--token') ?? process.env.JARVIS_DEBUG_RPC ?? '';
  if (!token) { console.error('ERROR: set JARVIS_DEBUG_RPC or pass --token'); process.exit(2); }
  return {
    base: get('--base', 'http://127.0.0.1:3142')!,
    token,
    runs: parseInt(get('--runs', '5')!, 10),
    out: get('--out', 'bench/control/metrics-report.md')!,
    target: get('--target'),
  };
}

async function rpc(opts: Opts, method: string, params: Record<string, unknown>): Promise<{ result: unknown; ms: number; error?: string }> {
  const started = Date.now();
  try {
    const res = await fetch(`${opts.base}/api/debug/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-debug-rpc-token': opts.token },
      body: JSON.stringify({ target: opts.target, method, params }),
      signal: AbortSignal.timeout(60_000),
    });
    const body = (await res.json()) as { result?: unknown; elapsed_ms?: number; error?: string };
    return { result: body.result, ms: body.elapsed_ms ?? Date.now() - started, error: body.error };
  } catch (e) {
    return { result: null, ms: Date.now() - started, error: String(e) };
  }
}

const asObj = (r: unknown): Record<string, unknown> => (r && typeof r === 'object' ? (r as Record<string, unknown>) : {});

const TASKS: Task[] = [
  {
    name: 'desktop foreground snapshot',
    kind: 'desktop',
    method: 'get_window_tree',
    params: { semantic: true, depth: 8 },
    measure: (r) => {
      const o = asObj(r);
      const els = Array.isArray(o.elements) ? (o.elements as unknown[]) : [];
      return { ok: els.length > 0, elements: els.length, bytes: JSON.stringify(o).length };
    },
  },
  {
    name: 'browser AX snapshot',
    kind: 'browser',
    method: 'browser_ax_snapshot',
    params: {},
    measure: (r) => {
      const o = asObj(r);
      const els = Array.isArray(o.elements) ? (o.elements as unknown[]) : [];
      return { ok: els.length > 0, elements: els.length, bytes: JSON.stringify(o).length };
    },
  },
];

type Row = {
  task: string;
  runs: number;
  successes: number;
  avgMs: number;
  avgElements: number;
  avgStructuralBytes: number;
  screenshotBytes: number;
};

async function main() {
  const opts = parseArgs(Bun.argv.slice(2));

  // Preflight: confirm the debug endpoint is reachable (fail fast + clearly).
  {
    const res = await fetch(`${opts.base}/api/debug/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-debug-rpc-token': opts.token },
      body: JSON.stringify({ method: '__list_sidecars' }),
      signal: AbortSignal.timeout(5_000),
    }).catch(() => null);
    if (!res) { console.error(`Cannot reach daemon at ${opts.base}`); process.exit(2); }
    if (res.status === 404) { console.error('debug endpoint 404 — start the branch daemon with a matching JARVIS_DEBUG_RPC'); process.exit(2); }
    const list = (await res.json()) as Array<{ connected: boolean }>;
    if (!Array.isArray(list) || !list.some((s) => s.connected)) {
      console.error('No connected sidecar — start jarvis-sidecar.exe and confirm it connects, then retry.');
      process.exit(2);
    }
  }

  // One screenshot per kind for the token-cost proxy.
  const shotBytes: Record<string, number> = {};
  for (const kind of ['desktop', 'browser']) {
    const method = kind === 'browser' ? 'browser_screenshot' : 'desktop_screenshot';
    const { result } = await rpc(opts, method, {});
    const data = asObj(result).data;
    shotBytes[kind] = typeof data === 'string' ? data.length : 0;
  }

  const rows: Row[] = [];
  for (const task of TASKS) {
    let successes = 0, totalMs = 0, totalEls = 0, totalBytes = 0, done = 0;
    for (let i = 0; i < opts.runs; i++) {
      const { result, ms, error } = await rpc(opts, task.method, task.params);
      if (error) continue;
      const m = task.measure(result);
      done++;
      if (m.ok) successes++;
      totalMs += ms; totalEls += m.elements; totalBytes += m.bytes;
    }
    if (done === 0) { rows.push({ task: task.name, runs: 0, successes: 0, avgMs: 0, avgElements: 0, avgStructuralBytes: 0, screenshotBytes: shotBytes[task.kind] ?? 0 }); continue; }
    rows.push({
      task: task.name,
      runs: done,
      successes,
      avgMs: Math.round(totalMs / done),
      avgElements: Math.round(totalEls / done),
      avgStructuralBytes: Math.round(totalBytes / done),
      screenshotBytes: shotBytes[task.kind] ?? 0,
    });
  }

  // Report.
  const lines: string[] = ['# Control-plane metrics', ''];
  lines.push('| Task | Runs | Success | Avg ms | Avg elements | Structural bytes | Screenshot bytes | Reduction |', '|---|---|---|---|---|---|---|---|');
  for (const r of rows) {
    const reduction = r.avgStructuralBytes > 0 && r.screenshotBytes > 0 ? `${(r.screenshotBytes / r.avgStructuralBytes).toFixed(1)}×` : 'n/a';
    lines.push(`| ${r.task} | ${r.runs} | ${r.successes}/${r.runs} | ${r.avgMs} | ${r.avgElements} | ${r.avgStructuralBytes} | ${r.screenshotBytes} | ${reduction} |`);
  }
  lines.push('', '> "Reduction" is the payload-size proxy for the token-cost claim (structural vs screenshot). Structural-vs-vision *usage* ratio is tracked live by perceptionStats() during real agent runs; this harness drives the structural path directly.');

  const text = lines.join('\n');
  console.log('\n' + text);
  try { await Bun.write(opts.out, text); console.log(`\nWritten to ${opts.out}`); } catch (e) { console.error(`write failed: ${e}`); }

  const allOk = rows.every((r) => r.runs > 0 && r.successes === r.runs);
  process.exit(allOk ? 0 : 1);
}

void main();
