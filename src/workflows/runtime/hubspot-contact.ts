/** Qualified contact write, not a general HubSpot API proxy. Engine-safe input
 * validation; provider execution takes place only inside the daemon's Authority effect. */
export const HUBSPOT_PIECE = '@activepieces/piece-hubspot';
export const HUBSPOT_UPSERT = 'create-or-update-contact';
export const isHubspotContact = (piece: unknown, action: unknown) => piece === HUBSPOT_PIECE && action === HUBSPOT_UPSERT;
/** The provider definitely refused every write this call sent: nothing changed. */
export class HubspotWriteRefusedError extends Error {}
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
    checkpoint();
    return fetchImpl(url, {method, headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},
      ...(properties ? {body:JSON.stringify({properties})} : {}), redirect:'error', signal:AbortSignal.timeout(15_000)});
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
    try { res=await request(method,url,properties); } catch { return null; }
    if(res.status>=500 || res.status===408) { await res.body?.cancel(); return null; }
    return res;
  };
  let res = Object.keys(input.objectProperties).length
    ? await write('PATCH',byEmail,input.objectProperties) : await request('GET',byEmail);
  if(!res) return reconcile();
  if(res.status===404) {
    await res.body?.cancel();
    res=await write('POST',base,{...input.objectProperties,email:input.email});
    if(!res) return reconcile();
    if(res.status===409) {
      await res.body?.cancel();
      res=Object.keys(input.objectProperties).length ? await write('PATCH',byEmail,input.objectProperties) : await request('GET',byEmail);
      if(!res) return reconcile();
    }
  }
  if(!res.ok) { const status=res.status; await res.body?.cancel(); throw new HubspotWriteRefusedError('HubSpot contact write refused: HTTP '+status+'; inspect the run before retrying'); }
  try { return await read(res); } catch { return reconcile(); }
}
