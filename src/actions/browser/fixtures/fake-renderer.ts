/**
 * A scripted CDP renderer for forcing the order of a snapshot's steps against
 * an element action (#875). Shared by the session-level tests and the tool-level
 * ones that drive the module-level controller through its approval guard.
 */
import { BrowserController } from '../session.ts';

/** One element in the fake page. Positions are top-page viewport centres. */
export type El = { name: string; x: number; y: number };

type Pending = {
  method: string;
  params: Record<string, any>;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
};

/**
 * A renderer that runs CDP messages one at a time, in the order they were
 * sent, with a macrotask between messages so the controller's continuations
 * run and send their next message -- the shape of one CDP session.
 *
 * `pauseWhen` stops the queue BEFORE the first matching message runs, so a
 * test can act while the renderer has done everything sent before it and
 * nothing after.
 */
export class FakeRenderer {
  readonly isOpen = true;
  dom: El[];
  /** The isolated world's refs and recorded points, as the snapshot script armed them. */
  world: { elements: El[]; points: Array<[number, number]> } | null = null;
  focused: El | null = null;
  typed: Array<{ text: string; into: string | null }> = [];
  clicks: Array<{ x: number; y: number }> = [];
  log: string[] = [];
  private queue: Pending[] = [];
  private running = false;
  private pause: { when: (p: Pending) => boolean; reached: () => void } | null = null;
  private paused = false;
  /** Called after the renderer has run the type's focus script. */
  afterFocus: (() => void) | null = null;
  /** Called after the renderer has inserted typed text. */
  afterInsert: (() => void) | null = null;
  keys: string[] = [];
  /** Called after the renderer has answered any message, with its log label. */
  afterAnswer: ((label: string, params: Record<string, any>) => void) | null = null;
  /** When set, the snapshot evaluate never answers (a hung renderer). */
  hangSnapshots = false;

  constructor(dom: El[]) {
    this.dom = dom;
  }

  send(method: string, params: Record<string, any> = {}): Promise<any> {
    return new Promise((resolve, reject) => {
      this.queue.push({ method, params, resolve, reject });
      void this.drain();
    });
  }

  async close(): Promise<void> {}

  /** Resolves once the queue has stopped in front of a message matching `when`. */
  pauseBefore(when: (p: Pending) => boolean): Promise<void> {
    return new Promise((reached) => { this.pause = { when, reached }; });
  }

  resume(): void {
    this.pause = null;
    this.paused = false;
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length && !this.paused) {
        const next = this.queue[0]!;
        if (this.pause?.when(next)) {
          this.paused = true;
          this.pause.reached();
          return;
        }
        this.queue.shift();
        await new Promise((r) => setTimeout(r, 0));
        this.log.push(label(next));
        if (this.hangSnapshots && isSnapshotScript(next)) continue;
        try {
          next.resolve(this.answer(next.method, next.params));
          this.afterAnswer?.(label(next), next.params);
        } catch (err) {
          next.reject(err as Error);
        }
      }
    } finally {
      this.running = false;
    }
  }

  private answer(method: string, params: Record<string, any>): unknown {
    switch (method) {
      case 'Page.getFrameTree':
        return { frameTree: { frame: { id: 'F1', url: 'https://mail.example.test/', loaderId: 'L1' }, childFrames: [] } };
      case 'Page.createIsolatedWorld':
        return { executionContextId: 7 };
      case 'Input.insertText':
        this.typed.push({ text: params.text, into: this.focused?.name ?? null });
        this.afterInsert?.();
        return {};
      case 'Input.dispatchKeyEvent':
        if (params.type === 'rawKeyDown' || params.type === 'keyDown') this.keys.push(`${params.key}->${this.focused?.name ?? 'none'}`);
        return {};
      case 'Input.dispatchMouseEvent':
        if (params.type === 'mousePressed') this.clicks.push({ x: params.x, y: params.y });
        return {};
      case 'Runtime.evaluate':
        return { result: { value: this.evaluate(String(params.expression)) } };
      default:
        return {};
    }
  }

  private evaluate(expr: string): unknown {
    if (expr.includes('globalThis.__jarvis_elements = els.map')) {
      // The snapshot script: arms the world with the page as it is NOW.
      this.world = { elements: [...this.dom], points: this.dom.map((e) => [e.x, e.y]) };
      return {
        title: 'Mail',
        url: 'https://mail.example.test/',
        text: this.dom.map((e) => e.name).join(' '),
        elements: this.dom.map((e, i) => ({ id: i + 1, tag: 'input', text: e.name, attrs: {}, x: e.x, y: e.y })),
      };
    }
    if (expr.includes('globalThis.__jarvis_dom')) {
      // The #603 sentinel: the world's element against the world's point.
      const i = Number(/const i = (\d+);/.exec(expr)?.[1]);
      const el = this.world?.elements[i];
      const pt = this.world?.points[i];
      if (!el || !pt) return 'gone';
      return el.x === pt[0] && el.y === pt[1] ? 'ok' : 'moved';
    }
    const ref = /__jarvis_elements\[(\d+)\]/.exec(expr);
    const el = ref ? this.world?.elements[Number(ref[1])] ?? null : null;
    if (expr.includes('el.focus()')) {
      if (!el) return 'not_found';
      this.focused = el;
      this.afterFocus?.();
      return 'ok';
    }
    if (expr.includes('activeElement !== el')) {
      return el && this.focused === el ? 'ok' : 'no';
    }
    return null;
  }
}

export function isSnapshotScript(p: Pending): boolean {
  return p.method === 'Runtime.evaluate' && String(p.params.expression).includes('globalThis.__jarvis_elements = els.map');
}

function label(p: Pending): string {
  if (p.method !== 'Runtime.evaluate') return p.method;
  const expr = String(p.params.expression);
  if (expr.includes('globalThis.__jarvis_elements = els.map')) return 'evaluate:snapshot';
  if (expr.includes('globalThis.__jarvis_dom')) return 'evaluate:sentinel';
  if (expr.includes('el.focus()')) return 'evaluate:focus';
  return 'evaluate:other';
}

/**
 * Wire an existing controller to the fake renderer, as if `connect()` had
 * succeeded. Returns a function that puts the controller's own fields back, for
 * a test that borrows the module-level one.
 */
export function wireController(browser: BrowserController, fake: FakeRenderer): () => void {
  const b = browser as unknown as Record<string, unknown>;
  // EVERY own field, with the collections copied: the snapshot fills the
  // coordinate map and the frame set in place, and a borrowed module-level
  // controller must go back cold (no surface, no reported URL, its own
  // generation) for whichever test runs next in the same process.
  const saved: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(b)) {
    saved[key] = value instanceof Map ? new Map(value) : value instanceof Set ? new Set(value) : value;
  }
  b.cdp = fake;
  b.requestGuard = { isOpen: true };
  b._connected = true;
  return () => {
    Object.assign(b, saved);
    // A FRESH lock, not the saved one: a test that left a snapshot paused would
    // otherwise hand a held lock to whichever test borrows this controller next.
    const Lock = (saved.snapshotLock as { constructor: new () => unknown }).constructor;
    b.snapshotLock = new Lock();
  };
}

/** A fresh controller wired to the fake renderer. */
export function controllerOver(fake: FakeRenderer): BrowserController {
  const browser = new BrowserController(0, undefined, { autoLaunch: false });
  wireController(browser, fake);
  return browser;
}

/**
 * Start a second caller's snapshot (a sub-agent's) and stop the renderer just
 * after its script has armed the world, before the frame-tree re-read whose
 * answer lets it fill the map and move the generation.
 */
export async function snapshotInFlight(fake: FakeRenderer, browser: BrowserController): Promise<{ done: Promise<unknown> }> {
  let sawSnapshot = false;
  const reached = fake.pauseBefore((p) => {
    if (isSnapshotScript(p)) { sawSnapshot = true; return false; }
    return sawSnapshot && p.method === 'Page.getFrameTree';
  });
  const second = browser.snapshot().catch((err) => err);
  await reached;
  return { done: second };
}
