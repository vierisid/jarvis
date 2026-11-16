type PostSetupServicesOptions = {
  startCore: () => Promise<void>;
  coreRunning: () => boolean;
  noLocalTools?: boolean;
  awareness: {
    enabled: () => boolean | undefined;
    start: () => Promise<void>;
    running: () => boolean;
  };
};

/** Track the whole startup attempt, including deployments that skip Awareness. */
export function createPostSetupServices(options: PostSetupServicesOptions) {
  let completed = false;
  let inFlight: Promise<void> | null = null;
  const needsAwareness = () => !options.noLocalTools && options.awareness.enabled() !== false;
  return {
    start(): Promise<void> {
      if (!inFlight) {
        inFlight = (async () => {
          await options.startCore();
          if (needsAwareness()) await options.awareness.start();
          completed = true;
        })().finally(() => { inFlight = null; });
      }
      return inFlight;
    },
    /**
     * Start Awareness when it is turned on after a boot with it off: boot
     * skipped it, so the switch alone (long-press, toggle route, settings)
     * would only save the choice until a restart. Nothing before setup has
     * completed (onboarding starts it), and nothing in a deployment without
     * local tools. The caller starts it only when no service exists.
     */
    startAwarenessIfNeeded(): Promise<void> {
      if (!completed || !needsAwareness()) return Promise.resolve();
      return options.awareness.start();
    },
    readiness(): 'running' | 'stopped' | 'unavailable' {
      if (!completed || !options.coreRunning()) return 'stopped';
      if (needsAwareness() && !options.awareness.running()) return 'unavailable';
      return 'running';
    },
  };
}
