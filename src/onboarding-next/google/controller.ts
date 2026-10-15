import type { GoogleSnapshot, GoogleStart } from './types.ts';

type Timer = ReturnType<typeof setTimeout> | number;

export interface GoogleControllerPorts {
  read(signal: AbortSignal): Promise<GoogleSnapshot>;
  begin(signal: AbortSignal): Promise<GoogleStart>;
  cancel(attemptId: string): Promise<GoogleSnapshot>;
  externalFailed(attemptId: string): Promise<GoogleSnapshot>;
  open(url: string): boolean;
  /** Focus/visibility return only. Window messages never constitute grant evidence. */
  onReturn(refresh: () => void): () => void;
  render(snapshot: GoogleSnapshot): void;
  failure(): void;
  timer?: (callback: () => void, ms: number) => Timer;
  clearTimer?: (timer: Timer) => void;
}

/** Headless host helper. ON-U-10 binds it to the controlled Google view. */
export function createGoogleController(ports: GoogleControllerPorts) {
  const timer = ports.timer ?? setTimeout;
  const clearTimer = ports.clearTimer ?? clearTimeout;
  let active = false, generation = 0, busy: 'read' | 'begin' | false = false;
  let current: GoogleSnapshot | undefined;
  let poll: Timer | undefined;
  let deadline: Timer | undefined;
  let request: AbortController | undefined;
  let unlisten: (() => void) | undefined;
  function stopRequest() {
    generation++;
    request?.abort(); request = undefined;
    if (poll !== undefined) clearTimer(poll);
    if (deadline !== undefined) clearTimer(deadline);
    poll = deadline = undefined; busy = false;
  }
  function apply(snapshot: GoogleSnapshot) {
    current = snapshot;
    ports.render(snapshot);
    if (snapshot.connection.state === 'pending') poll = timer(() => { poll = undefined; void refresh(); }, 2000);
  }
  async function perform(start: boolean) {
    // A begin preempts an in-flight status read (focus/poll), so a Connect click is never dropped.
    if (!active || busy === 'begin' || (busy && !start)) return;
    stopRequest();
    busy = start ? 'begin' : 'read';
    const epoch = generation, controller = new AbortController();
    request = controller;
    deadline = timer(() => {
      if (active && generation === epoch) { stopRequest(); ports.failure(); }
    }, 15_000);
    try {
      const result = start ? await ports.begin(controller.signal) : { snapshot: await ports.read(controller.signal) };
      if (!active || epoch !== generation) {
        if ('launch' in result && result.launch) await ports.cancel(result.launch.attemptId).catch(() => {});
        return;
      }
      let snapshot = result.snapshot;
      if ('launch' in result && result.launch) {
        let opened = false;
        try { opened = ports.open(result.launch.url); } catch { /* Same safe recovery as popup denial. */ }
        if (!opened) snapshot = await ports.externalFailed(result.launch.attemptId);
      }
      if (active && epoch === generation) {
        stopRequest();
        apply(snapshot);
      }
    } catch {
      if (active && epoch === generation) { stopRequest(); ports.failure(); }
    }
  }
  async function refresh() { await perform(false); }
  function leave() { active = false; stopRequest(); unlisten?.(); unlisten = undefined; }
  return {
    async enter() {
      leave(); current = undefined; active = true;
      unlisten = ports.onReturn(() => { void refresh(); });
      await refresh();
    },
    connect() { return perform(true); },
    refresh,
    async cancel() {
      if (!active) return;
      stopRequest();
      const epoch = generation;
      const connection = current?.connection;
      if (connection && 'attemptId' in connection && connection.attemptId) {
        try {
          const snapshot = await ports.cancel(connection.attemptId);
          if (active && epoch === generation) apply(snapshot);
        } catch { if (active && epoch === generation) ports.failure(); }
      }
    },
    /** Host navigates only after this settles; no connection creation or revocation. */
    async skip() {
      const connection = current?.connection;
      leave();
      if (connection && 'attemptId' in connection && connection.attemptId && connection.state !== 'connected') {
        await ports.cancel(connection.attemptId);
      }
    },
    leave,
  };
}
