/** Keep the native AbortSignal brand for IO APIs, but contain failures from
 * logger-owned cancellation callbacks before EventTarget can report them as
 * uncaught exceptions. A try/catch around controller.abort() cannot do that.
 * No process-wide exception/rejection handlers are installed. */
export function createLoggerAbortController(): AbortController {
  const controller = new AbortController(), signal = controller.signal;
  const add = signal.addEventListener.bind(signal), remove = signal.removeEventListener.bind(signal);
  const listeners = new WeakMap<EventListenerOrEventListenerObject, Map<boolean, EventListener>>();
  function invoke(listener: EventListenerOrEventListenerObject, event: Event) {
    try {
      const result = typeof listener === 'function' ? listener.call(signal, event) : listener.handleEvent(event);
      void Promise.resolve(result).catch(() => {});
    } catch { /* Cancellation is best effort; never report raw logger errors. */ }
  }
  const capture = (options?: boolean | EventListenerOptions) => typeof options === 'boolean' ? options : !!options?.capture;
  let onabort: AbortSignal['onabort'] = null;
  const notify: EventListener = event => { if (onabort) invoke(onabort, event); };
  Object.defineProperties(signal, {
    addEventListener: { value(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions) {
      if (!listener) return;
      if (type !== 'abort') return add(type, listener, options);
      let byCapture = listeners.get(listener);
      if (!byCapture) { byCapture = new Map(); listeners.set(listener, byCapture); }
      const capturing = capture(options);
      let wrapped = byCapture.get(capturing);
      if (!wrapped) { wrapped = event => invoke(listener, event); byCapture.set(capturing, wrapped); }
      // Stable wrappers preserve native duplicate, once and removal semantics.
      add(type, wrapped, options);
    } },
    removeEventListener: { value(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | EventListenerOptions) {
      if (!listener) return;
      const wrapped = type === 'abort' ? listeners.get(listener)?.get(capture(options)) : undefined;
      remove(type, wrapped ?? listener, options);
    } },
    onabort: {
      get: () => onabort,
      set(value: AbortSignal['onabort']) {
        const next = typeof value === 'function' ? value : null;
        if (!onabort && next) add('abort', notify);
        if (onabort && !next) remove('abort', notify);
        onabort = next;
      },
    },
  });
  return controller;
}
