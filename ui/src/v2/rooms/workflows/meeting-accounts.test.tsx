import { afterAll, beforeAll, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
let React: typeof import('react'), createRoot: typeof import('react-dom/client').createRoot;
let Pickers: typeof import('./WorkflowEditor').MeetingAccountPickers, authType: typeof import('./WorkflowEditor').accountPickerAuthType;
import { REPORT_ACCOUNT_FIELDS } from '../../../../../src/workflows/report-accounts';
import { IMPORT_ACCOUNT_FIELDS, importAccountFields } from '../../../../../src/workflows/import-accounts';
import { ONBOARDING_ACCOUNT_FIELDS } from '../../../../../src/workflows/onboarding-accounts';
beforeAll(async()=>{GlobalRegistrator.register();(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;React=await import('react');({createRoot}=await import('react-dom/client'));({MeetingAccountPickers:Pickers,accountPickerAuthType:authType}=await import('./WorkflowEditor'));});
afterAll(()=>GlobalRegistrator.unregister());
test('meeting setup selects saved accounts by provider, stores only reference and restores selection',async()=>{
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host),writes:Array<[string,string]>=[];
 const connections=['google-calendar','gmail','hubspot'].map((name,i)=>({id:String(i),externalId:'saved-'+i,pieceName:'@activepieces/piece-'+name,displayName:'Account '+i,status:'ACTIVE'})) as any;
 connections.push({...connections[0],id:'revoked',externalId:'revoked',status:'MISSING'});
 await React.act(async()=>root.render(<Pickers connections={connections} input={{calendarConnection:'saved-0'}} onSetInput={(k,v)=>writes.push([k,v])}/>));
 try{
  const selects=host.querySelectorAll('select');expect(selects.length).toBe(3);expect(selects[0]!.value).toBe('saved-0');expect(selects[0]!.options.length).toBe(2);
  expect(selects[1]!.textContent).not.toContain('Account 0');
  await React.act(async()=>{selects[1]!.value='saved-1';selects[1]!.dispatchEvent(new Event('change',{bubbles:true}));});
  expect(writes).toEqual([['gmailConnection','saved-1']]);expect(JSON.stringify(writes)).not.toContain('{{connections');
 }finally{await React.act(async()=>root.unmount());host.remove();}
});

test('sales setup reuses saved-account controls for HubSpot and Gmail only',async()=>{
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host),writes:Array<[string,string]>=[];
 const connections=['hubspot','gmail','google-calendar'].map((name,i)=>({id:String(i),externalId:'saved-'+i,pieceName:'@activepieces/piece-'+name,displayName:'Account '+i,status:'ACTIVE'})) as any;
 await React.act(async()=>root.render(<Pickers fields={[["hubspotConnection","@activepieces/piece-hubspot","HubSpot"],["gmailConnection","@activepieces/piece-gmail","Gmail"]]} connections={connections} input={{gmailConnection:'saved-1'}} onSetInput={(k,v)=>writes.push([k,v])}/>));
 try{
  const selects=host.querySelectorAll('select');expect(selects.length).toBe(2);expect(selects[1]!.value).toBe('saved-1');expect(host.textContent).not.toContain('Account 2');
  await React.act(async()=>{selects[0]!.value='saved-0';selects[0]!.dispatchEvent(new Event('change',{bubbles:true}));});
  expect(writes).toEqual([['hubspotConnection','saved-0']]);
 }finally{await React.act(async()=>root.unmount());host.remove();}
});

test('weekly report selects saved Stripe, HubSpot and Google Docs references separately',async()=>{
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host),writes:Array<[string,string]>=[];
 const connections=['stripe','hubspot','google-docs','gmail'].map((name,i)=>({id:String(i),externalId:'saved-'+i,pieceName:'@activepieces/piece-'+name,displayName:'Account '+i,status:'ACTIVE'})) as any;
 await React.act(async()=>root.render(<Pickers fields={REPORT_ACCOUNT_FIELDS} connections={connections} input={{googleConnection:'saved-2'}} onSetInput={(k,v)=>writes.push([k,v])}/>));
 try{const selects=host.querySelectorAll('select');expect(selects.length).toBe(3);expect(selects[2]!.value).toBe('saved-2');expect(host.textContent).not.toContain('Account 3');
  await React.act(async()=>{selects[0]!.value='saved-0';selects[0]!.dispatchEvent(new Event('change',{bubbles:true}));});expect(writes).toEqual([['stripeConnection','saved-0']]);
 }finally{await React.act(async()=>root.unmount());host.remove();}
});

test('a Stripe account is picked as a secret key, the other report accounts as OAuth',()=>{
 expect(REPORT_ACCOUNT_FIELDS.map(([,provider])=>authType(provider))).toEqual(['SECRET_TEXT','OAUTH2','OAUTH2']);
});

test('contact import keeps source OAuth and destination HubSpot account references separate',async()=>{
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host),writes:Array<[string,string]>=[];
 const connections=['hubspot','http-oauth2','gmail'].map((name,i)=>({id:String(i),externalId:'saved-'+i,pieceName:'@activepieces/piece-'+name,displayName:'Account '+i,status:'ACTIVE'})) as any;
 await React.act(async()=>root.render(<Pickers fields={IMPORT_ACCOUNT_FIELDS.filter(([field])=>importAccountFields({sourceAuth:'oauth2'}).includes(field))} connections={connections} input={{hubspotConnection:'saved-0'}} onSetInput={(k,v)=>writes.push([k,v])}/>));
 try{const selects=host.querySelectorAll('select');expect(selects.length).toBe(2);expect(selects[0]!.value).toBe('saved-0');expect(selects[1]!.textContent).not.toContain('Account 0');expect(host.textContent).not.toContain('Account 2');
  await React.act(async()=>{selects[1]!.value='saved-1';selects[1]!.dispatchEvent(new Event('change',{bubbles:true}));});expect(writes).toEqual([['sourceConnection','saved-1']]);
 }finally{await React.act(async()=>root.unmount());host.remove();}
});

test('contact import asks for the source account only for an OAuth2 source',()=>{
 expect(importAccountFields({sourceAuth:'none'})).toEqual(['hubspotConnection']);
 expect(importAccountFields({sourceAuth:'oauth2'})).toEqual(['hubspotConnection','sourceConnection']);
 expect(importAccountFields(undefined)).toEqual(['hubspotConnection']);
});

test('customer onboarding uses separate saved ClickUp and Drive account references',async()=>{
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host),writes:Array<[string,string]>=[];
 const connections=['clickup','google-drive','gmail'].map((name,i)=>({id:String(i),externalId:'saved-'+i,pieceName:'@activepieces/piece-'+name,displayName:'Account '+i,status:'ACTIVE'})) as any;
 await React.act(async()=>root.render(<Pickers fields={ONBOARDING_ACCOUNT_FIELDS} connections={connections} input={{clickupConnection:'saved-0'}} onSetInput={(k,v)=>writes.push([k,v])}/>));
 try{const selects=host.querySelectorAll('select');expect(selects.length).toBe(2);expect(selects[0]!.value).toBe('saved-0');expect(host.textContent).not.toContain('Account 2');
  await React.act(async()=>{selects[1]!.value='saved-1';selects[1]!.dispatchEvent(new Event('change',{bubbles:true}));});expect(writes).toEqual([['driveConnection','saved-1']]);
 }finally{await React.act(async()=>root.unmount());host.remove();}
});

test('an empty managed-app picker points at Connect controls only when this instance offers hosted setup',async()=>{
 const originalFetch=globalThis.fetch;
 for(const configured of [false,true]){
  globalThis.fetch=(async()=>Response.json({configured,connected:false,connect_url:configured?'https://app.usejarvis.dev/account?integration=clickup':null,external_id:'jarvis:clickup',account:null,workspaces:[],generation:null})) as unknown as typeof fetch;
  const host=document.createElement('div');document.body.append(host);const root=createRoot(host);
  try{
   await React.act(async()=>root.render(<Pickers fields={[["clickupConnection","@activepieces/piece-clickup","ClickUp"]]} connections={[]} input={{}} onSetInput={()=>{}}/>));
   await React.act(async()=>{await new Promise(r=>setTimeout(r,0));});
   const hint=host.querySelector('.wf-props__connection-empty')?.textContent??'';
   if(configured){expect(hint).toContain('Connect ClickUp using the connection controls above');expect(host.textContent).toContain('Connect ClickUp');}
   else{expect(hint).toContain('No connection saved for ClickUp yet');expect(hint).not.toContain('controls above');}
  }finally{await React.act(async()=>root.unmount());host.remove();globalThis.fetch=originalFetch;}
 }
});
