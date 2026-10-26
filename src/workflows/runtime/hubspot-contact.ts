/** Qualified contact write, not a general HubSpot API proxy. Engine-safe input
 * validation; provider execution takes place only inside the daemon's Authority effect. */
export const HUBSPOT_PIECE = '@activepieces/piece-hubspot';
export const HUBSPOT_UPSERT = 'create-or-update-contact';
export const isHubspotContact = (piece: unknown, action: unknown) => piece === HUBSPOT_PIECE && action === HUBSPOT_UPSERT;
/** The provider definitely refused every write this call sent: nothing changed. */
export class HubspotWriteRefusedError extends Error {}
/** Nothing this call sent could have written: the run's checkpoint refused
 * before a request left (every earlier request was a definite non-write), or
 * a read-only lookup failed. `refusal` is the checkpoint's own error, if any. */
export class HubspotNotStartedError extends Error {
  constructor(message: string, public readonly refusal?: unknown) { super(message); }
}
/** Per-request timeout, and the most requests one upsert sends (PATCH, POST,
 * PATCH after a 409, then a reconciling GET). Bounds how long a call can own
 * a contact identity. */
export const HUBSPOT_REQUEST_TIMEOUT_MS = 15_000;
export const HUBSPOT_UPSERT_MAX_MS = 4 * HUBSPOT_REQUEST_TIMEOUT_MS;
/** How long an upsert waits for a competing claim of the same contact that is
 * still dispatching: the longest the owning upsert can take, plus slack for
 * its bookkeeping. Shorter, a second submission for the same email during a
 * slow write would fail, and its webhook submission ID is already consumed, so
 * its update would be lost. */
export const HUBSPOT_CLAIM_WAIT_MS = HUBSPOT_UPSERT_MAX_MS + 5_000;
/** Idle timeout the sandbox API gives a piece authorize request: a contact
 * upsert may wait for a competing claim and then run its own upsert, both in
 * that one request. Bun's 10 s default would drop the engine's connection
 * while the daemon kept writing. */
export const PIECE_AUTHORIZE_IDLE_TIMEOUT_S = Math.ceil((HUBSPOT_CLAIM_WAIT_MS + HUBSPOT_UPSERT_MAX_MS) / 1000) + 15;
export interface ContactInput extends Record<string, unknown> { email: string; objectProperties: Record<string,string> }
export function hubspotContactInput(raw: unknown): ContactInput {
  const input = raw as Record<string,unknown> | null;
  const email = typeof input?.email === 'string' ? input.email.trim().toLowerCase() : '';
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.includes('..')) throw new Error('HubSpot requires a valid contact email');
  const properties = input?.objectProperties ?? {};
  if (!properties || typeof properties !== 'object' || Array.isArray(properties) || Object.keys(properties).length > 100) throw new Error('Invalid HubSpot contact properties');
  const normalized: Record<string,string> = {};
  for (const [key,value] of Object.entries(properties)) {
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,99}$/.test(key) || ['email','__proto__','prototype','constructor','hs_additional_emails'].includes(key)) throw new Error('Contact identity cannot be overridden by properties');
    const v = Array.isArray(value) && value.every(x=>typeof x === 'string') ? value.join(';') : value;
    if (!['string','number','boolean'].includes(typeof v) || typeof v === 'number' && !Number.isFinite(v)) throw new Error('Contact property values must be scalar');
    normalized[key] = String(v);
  }
  const result = { email, objectProperties: normalized };
  if (JSON.stringify(result).length > 32_768) throw new Error('Contact properties exceed 32768 characters');
  return result;
}

/** PATCH by email preserves unspecified properties. Only a definite 404 permits
 * POST with email (HubSpot's primary unique identifier). A competing create's
 * 409 is reconciled by PATCH, never another POST. Email batch/upsert is not used:
 * HubSpot documents that it does not support partial upserts.
 * https://developers.hubspot.com/docs/api-reference/legacy/crm/objects/contacts/guide */
export async function upsertHubspotContact(input: ContactInput, token: string, checkpoint: () => void, fetchImpl: typeof fetch = fetch): Promise<{id:string;properties:Record<string,unknown>}> {
  const base = 'https://api.hubapi.com/crm/v3/objects/contacts';
  const byEmail = base + '/' + encodeURIComponent(input.email) + '?idProperty=email';
  const request = async (method: string, url: string, properties?: object) => {
    // A refusal here comes before this request is sent. Callers keep it apart
    // from a lost reply: only an earlier uncertain request makes it uncertain.
    try { checkpoint(); }
    catch (error) { throw new HubspotNotStartedError(error instanceof Error ? error.message : String(error), error); }
    return fetchImpl(url, {method, headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},
      ...(properties ? {body:JSON.stringify({properties})} : {}), redirect:'error', signal:AbortSignal.timeout(HUBSPOT_REQUEST_TIMEOUT_MS)});
  };
  const read = async (res: Response) => {
    const reader=res.body?.getReader(); if (!reader) throw new Error('Missing HubSpot response');
    let text=''; let bytes=0; const decoder=new TextDecoder();
    while(true) { const part=await reader.read(); if(part.done) break; bytes+=part.value.length;
      if(bytes>131_072) { await reader.cancel(); throw new Error('HubSpot response exceeds limit'); }
      text+=decoder.decode(part.value,{stream:true}); }
    const data=JSON.parse(text+decoder.decode());
    if(typeof data.id !== 'string' || !/^\d{1,30}$/.test(data.id) || !data.properties || typeof data.properties !== 'object' || Array.isArray(data.properties)) throw new Error('Invalid HubSpot contact receipt');
    return {id:data.id as string,properties:data.properties as Record<string,unknown>};
  };
  const reconcile = async () => {
    try {
      const res=await request('GET',byEmail+'&properties='+encodeURIComponent(['email',...Object.keys(input.objectProperties)].join(',')));
      if(!res.ok) { await res.body?.cancel(); throw new Error(); }
      const found=await read(res);
      if(String(found.properties.email).toLowerCase() !== input.email || !Object.entries(input.objectProperties).every(([k,v])=>String(found.properties[k])===v)) throw new Error();
      return found;
    } catch { throw new Error('HubSpot write is unconfirmed; no automatic resend. Inspect the original contact and run.'); }
  };
  const write = async (method:string,url:string,properties:object):Promise<Response|null> => {
    let res:Response;
    try { res=await request(method,url,properties); }
    catch (error) { if (error instanceof HubspotNotStartedError) throw error; return null; }
    if(res.status>=500 || res.status===408) { await res.body?.cancel(); return null; }
    return res;
  };
  // With no properties the contact is only read: a GET writes nothing, so any
  // failure of it (transport, HTTP or body) leaves nothing to reconcile.
  const readFailed = (error: unknown) => error instanceof HubspotNotStartedError ? error
    : new HubspotNotStartedError('HubSpot contact lookup failed before any write: '+(error instanceof Error ? error.message : String(error)));
  const lookup = async (): Promise<Response> => {
    let res: Response;
    try { res = await request('GET',byEmail); } catch (error) { throw readFailed(error); }
    if (!res.ok && res.status !== 404) { await res.body?.cancel(); throw readFailed(new Error('HTTP '+res.status)); }
    return res;
  };
  const writes = Object.keys(input.objectProperties).length > 0;
  let res = writes ? await write('PATCH',byEmail,input.objectProperties) : await lookup();
  if(!res) return reconcile();
  if(res.status===404) {
    await res.body?.cancel();
    res=await write('POST',base,{...input.objectProperties,email:input.email});
    if(!res) return reconcile();
    if(res.status===409) {
      await res.body?.cancel();
      res=writes ? await write('PATCH',byEmail,input.objectProperties) : await lookup();
      if(!res) return reconcile();
      if(!writes) {
        if(!res.ok) { await res.body?.cancel(); throw readFailed(new Error('HTTP '+res.status)); }
        try { return await read(res); } catch (error) { throw readFailed(error); }
      }
    }
  } else if(!writes) {
    try { return await read(res); } catch (error) { throw readFailed(error); }
  }
  if(!res.ok) { const status=res.status; await res.body?.cancel(); throw new HubspotWriteRefusedError('HubSpot contact write refused: HTTP '+status+'; inspect the run before retrying'); }
  try { return await read(res); } catch { return reconcile(); }
}
