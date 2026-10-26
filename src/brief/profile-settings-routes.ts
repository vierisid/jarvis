import type { BriefCapabilities } from './capabilities';
import { ProfileEditError } from '../vault/profile-edit';
import { ProfileSettingsError, type ProfileSettings } from './profile-settings';

export function createProfileSettingsRoutes(capabilities: BriefCapabilities, json: (body: unknown, status?: number) => Response, provider?: ProfileSettings) {
  const requireProvider = () => {
    if (!provider || !capabilities.hasProvider('profileSettings', provider)) throw new ProfileSettingsError('unsupported', 501);
    if (!capabilities.snapshot().capabilities.profileSettings.enabled) throw new ProfileSettingsError('unavailable', 503);
    return provider;
  };
  const wrap = (fn: (req: Request) => unknown | Promise<unknown>) => async (req: Request) => {
    let res: Response;
    try {
      requireProvider();
      if (new URL(req.url).search) throw new ProfileSettingsError('unexpected_query');
      res = json(await fn(req));
    } catch (e) {
      res = e instanceof ProfileSettingsError || e instanceof ProfileEditError ? json({ code: e.code }, e.status) : json({ code: 'unavailable' }, 503);
    }
    res.headers.set('Cache-Control', 'no-store'); res.headers.set('X-Content-Type-Options', 'nosniff'); return res;
  };
  const body = async (req: Request, keys: string[]) => {
    if (!req.body) throw new ProfileSettingsError('invalid_patch');
    const reader = req.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
    try {
      while (true) {
        const next = await reader.read(); if (next.done) break;
        size += next.value.byteLength;
        if (size > 64_000) { await reader.cancel(); throw new ProfileSettingsError('body_too_large', 413); }
        chunks.push(next.value);
      }
    } finally { reader.releaseLock(); }
    let value: Record<string, unknown>;
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
    catch { throw new ProfileSettingsError('invalid_patch'); }
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !keys.includes(k)) || keys.some(k => !Object.hasOwn(value, k))) throw new ProfileSettingsError('invalid_patch');
    requireProvider(); // The flag/readiness may have changed while the request body arrived.
    return value;
  };
  return {
    '/api/brief/getting-started': {
      GET: wrap(() => provider!.gettingStarted()),
      PATCH: wrap(async req => { const value = await body(req, ['revision', 'change']); return provider!.saveGettingStarted(value.revision, value.change); }),
    },
    '/api/brief/profile-settings': { GET: wrap(() => ({ status: 'ready', data: provider!.read() })) },
    '/api/brief/profile-settings/profile': { PATCH: wrap(async req => {
      const value = await body(req, ['revision', 'answers']);
      return { saved: true, profile: provider!.saveProfile(value.revision, value.answers) };
    }) },
    '/api/brief/profile-settings/voice': { PATCH: wrap(async req => {
      const value = await body(req, ['revision', 'voice']); return provider!.saveVoice(value.revision, value.voice);
    }) },
  };
}
