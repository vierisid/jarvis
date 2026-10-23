import { afterAll, beforeAll, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
let React: typeof import('react'), createRoot: typeof import('react-dom/client').createRoot;
let Pickers: typeof import('./WorkflowEditor').MeetingAccountPickers;
beforeAll(async()=>{GlobalRegistrator.register();(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;React=await import('react');({createRoot}=await import('react-dom/client'));({MeetingAccountPickers:Pickers}=await import('./WorkflowEditor'));});
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
 await React.act(async()=>root.render(<Pickers fields={[["stripeConnection","@activepieces/piece-stripe","Stripe"],["hubspotConnection","@activepieces/piece-hubspot","HubSpot"],["googleConnection","@activepieces/piece-google-docs","Google Docs"]]} connections={connections} input={{googleConnection:'saved-2'}} onSetInput={(k,v)=>writes.push([k,v])}/>));
 try{const selects=host.querySelectorAll('select');expect(selects.length).toBe(3);expect(selects[2]!.value).toBe('saved-2');expect(host.textContent).not.toContain('Account 3');expect(host.textContent).toContain('SECRET_TEXT');
  await React.act(async()=>{selects[0]!.value='saved-0';selects[0]!.dispatchEvent(new Event('change',{bubbles:true}));});expect(writes).toEqual([['stripeConnection','saved-0']]);
 }finally{await React.act(async()=>root.unmount());host.remove();}
});
