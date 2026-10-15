import { openExternal, openedOrHandedOff } from '../../../ui/src/v2/onboarding/external-open.ts';

/** Client-only adapter over the existing browser/WebView handoff service. */
export const googleBrowserPorts = {
  open(url: string): boolean { return openedOrHandedOff(openExternal(url)); },
  onReturn(refresh: () => void): () => void {
    const visible = () => { if (document.visibilityState === 'visible') refresh(); };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', visible);
    return () => {
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', visible);
    };
  },
};
