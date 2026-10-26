/**
 * The enrolled device whose live panel session authorized a request, or
 * null. The HTTP auth block (websocket.ts) marks each request it
 * authenticated by session; under auth.insecure_open_access none is marked.
 * For a route that must be a person's dashboard session (#1096 purge), not
 * merely an open door. Holds the device id only, never the session secret.
 */
const devices = new WeakMap<Request, string>();
export function markPanelSession(req: Request, deviceId: string): void { devices.set(req, deviceId); }
export function panelSessionDevice(req: Request): string | null { return devices.get(req) ?? null; }
