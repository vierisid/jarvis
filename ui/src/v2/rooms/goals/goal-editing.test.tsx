import { beforeAll, beforeEach, afterEach, afterAll, test, expect } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import type { Root } from 'react-dom/client';
import type { Goal } from './useGoalsData';
let React: typeof import('react'), createRoot: typeof import('react-dom/client').createRoot,
  Room: typeof import('./GoalsRoom').GoalsRoomBody, root: Root, host: HTMLDivElement;
let originalFetch: typeof fetch, goal: Goal, writes: Array<{method: string; body: any}>, fail: boolean, workspace: string, hostStatus: number, staleRead: Goal | null;
const wait = () => new Promise(r => setTimeout(r, 10));
beforeAll(async () => {
  GlobalRegistrator.register();
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  React = await import('react'); ({createRoot} = await import('react-dom/client'));
  ({GoalsRoomBody: Room} = await import('./GoalsRoom'));
  originalFetch = globalThis.fetch;
});
beforeEach(() => {
  goal = {id:'goal-1', parent_id:null, title:'Original goal', level:'task', description:'', success_criteria:'',
    time_horizon:'monthly', score:0, score_reason:null, status:'active', health:'on_track', deadline:new Date(2026,10,20,23,59).getTime(),
    started_at:null, estimated_hours:null, actual_hours:0, authority_level:0, tags:[], dependencies:[], sort_order:0,
    created_at:1, updated_at:1, completed_at:null};
  sessionStorage.clear();
  writes=[]; fail=false; workspace='ws-1'; hostStatus=200; staleRead=null;
  globalThis.fetch = (async (url: any, init?: RequestInit) => {
    const path=String(url), method=init?.method ?? 'GET';
    if(method !== 'GET') {
      const body=JSON.parse(String(init?.body)); writes.push({method,body});
      if(fail) return Response.json({error:'Unavailable'}, {status:503});
      // Like the server, a present deadline re-runs health even when unchanged.
      if(method === 'PATCH') goal={...goal,...body,...('deadline' in body?{health:'on_track' as const}:{})};
      else if(path.endsWith('/score')) {
        if(body.source !== 'user') return Response.json({error:'source must be user'}, {status:400});
        if(goal.measurement) return Response.json({error:'score: Use a new measurement to update measured goal progress'}, {status:400});
        if(body.expected_updated_at !== undefined && body.expected_updated_at !== goal.updated_at)
          return Response.json({error:'Goal score changed', code:'SCORE_CONFLICT', goal}, {status:409});
        goal={...goal,score:body.score,score_reason:body.reason,updated_at:goal.updated_at+1};
      }
      else if(path.endsWith('/status')) goal={...goal,status:body.status};
      else if(path.endsWith('/health')) goal={...goal,health:body.health};
      else if(method === 'POST') goal={...goal,...body};
      return Response.json(goal);
    }
    if(path.endsWith('/api/brief/host') && hostStatus !== 200) return Response.json({state:'unsupported'}, {status:hostStatus});
    if(path.endsWith('/api/brief/host')) return Response.json({schemaVersion:1,scopeId:'project-1',workspaceId:workspace,generation:'boot-1',installMode:'self',capabilities:{contractVersion:1}});
    if(path.endsWith('/metrics')) return Response.json({total:1,active:1,completed:0,failed:0,killed:0,avg_score:0,on_track:1,at_risk:0,behind:0,critical:0,overdue:0});
    if(staleRead && !path.endsWith('/overdue')) { const old=staleRead; staleRead=null; return Response.json([old]); }
    return Response.json(path.endsWith('/overdue')?[]:[goal]);
  }) as typeof fetch;
  host=document.createElement('div');document.body.append(host);root=createRoot(host);
});
afterEach(async()=>{await React.act(async()=>root.unmount());host.remove();globalThis.fetch=originalFetch;});
afterAll(()=>GlobalRegistrator.unregister());
async function render(){await React.act(async()=>{root.render(<Room mode="expanded"/>);await wait();});}
function button(label:string, within:ParentNode=host){const b=[...within.querySelectorAll<HTMLButtonElement>('button')].find(x=>(x.getAttribute('aria-label')||x.textContent)?.trim()===label);expect(b).toBeTruthy();return b!;}
async function click(label:string, within:ParentNode=host){await React.act(async()=>{const b=button(label,within);b.focus();b.click();await wait();});}
async function fill(input:HTMLInputElement,value:string){await React.act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));await wait();});}
async function select(){await React.act(async()=>{host.querySelector<HTMLElement>('.v2-goals__gnode')!.click();await wait();});}
async function key(key:string,shiftKey=false){await React.act(async()=>{window.dispatchEvent(new KeyboardEvent('keydown',{key,shiftKey,bubbles:true,cancelable:true}));await wait();});}

test('goal modal contains focus, supports Escape and restores its opener',async()=>{
  await render();const opener=button('New');await click('New');
  const dialog=host.querySelector<HTMLElement>('[role="dialog"]')!;
  expect(document.activeElement).toBe(dialog.querySelector('input'));
  const first=button('Close',dialog),last=button('Cancel',dialog);
  first.focus();await key('Tab',true);expect(document.activeElement).toBe(last);
  await key('Tab');expect(document.activeElement).toBe(first);
  opener.focus();expect(dialog.contains(document.activeElement)).toBe(true);
  await key('Escape');expect(host.querySelector('[role="dialog"]')).toBeNull();expect(document.activeElement).toBe(opener);expect(writes).toHaveLength(0);
});
test('goal choices expose separate accessible names and selected states',async()=>{
  await render();await click('New');
  expect(button('task').getAttribute('aria-pressed')).toBe('true');
  expect(button('objective').closest('label')).toBeNull();
  expect(button('objective').closest('fieldset')?.querySelector('legend')?.textContent).toBe('Level');
  await click('objective');expect(button('objective').getAttribute('aria-pressed')).toBe('true');expect(button('task').getAttribute('aria-pressed')).toBe('false');
  await key('Escape');await select();
  const side=host.querySelector('.v2-goals__side')!;
  expect(button('active',side).getAttribute('aria-pressed')).toBe('true');await click('paused',side);expect(button('paused',side).getAttribute('aria-pressed')).toBe('true');
  expect(button('on track',side).getAttribute('aria-pressed')).toBe('true');await click('at risk',side);expect(button('at risk',side).getAttribute('aria-pressed')).toBe('true');
});
test('goal title and deadline persist, survive reopen, and deadline can be cleared',async()=>{
  await render();await select();await click('Edit title and deadline');
  let form=host.querySelector<HTMLFormElement>('form[aria-label="Edit goal details"]')!;
  await fill(form.querySelector('input')!,'  Revised goal  ');await fill(form.querySelector('input[type="date"]')!,'2027-02-28');await click('Save details');
  expect(writes).toEqual([{method:'PATCH',body:{title:'Revised goal',deadline:new Date(2027,1,28,23,59).getTime()}}]);
  expect(host.querySelector('.v2-goals__side-title')?.textContent).toBe('Revised goal');
  await click('Close detail');await select();await click('Edit title and deadline');
  expect(host.querySelector<HTMLInputElement>('form input[type="date"]')?.value).toBe('2027-02-28');
  await click('Clear deadline');await click('Save details');expect(goal.deadline).toBeNull();
});
test('cancel and blank titles never write; failed saves preserve user edits for retry',async()=>{
  await render();await select();await click('Edit title and deadline');
  await fill(host.querySelector('form input')!,'');expect(button('Save details').disabled).toBe(true);
  await fill(host.querySelector('form input')!,'Not saved');await click('Cancel');expect(writes).toHaveLength(0);expect(goal.title).toBe('Original goal');
  await click('Edit title and deadline');await fill(host.querySelector('form input')!,'Retry this');fail=true;await click('Save details');
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('503');expect(host.querySelector<HTMLInputElement>('form input')?.value).toBe('Retry this');expect(goal.title).toBe('Original goal');
  fail=false;await click('Save details');expect(goal.title).toBe('Retry this');expect(host.querySelector('form')).toBeNull();
});
test('a title-only edit sends no deadline, keeping a hand-set health and the exact deadline',async()=>{
  const deadline=new Date(2026,10,20,10,30).getTime();goal={...goal,deadline,health:'behind'};
  await render();await select();await click('Edit title and deadline');
  await fill(host.querySelector('form input')!,'Renamed only');await click('Save details');
  expect(writes).toEqual([{method:'PATCH',body:{title:'Renamed only'}}]);
  expect(goal.deadline).toBe(deadline);expect(goal.health).toBe('behind');
});
test('a deadline-only edit sends no title, and an unchanged form saves nothing',async()=>{
  await render();await select();await click('Edit title and deadline');await click('Save details');
  expect(writes).toHaveLength(0);expect(host.querySelector('form')).toBeNull();
  await click('Edit title and deadline');await fill(host.querySelector<HTMLInputElement>('form input[type="date"]')!,'2027-03-01');await click('Save details');
  expect(writes).toEqual([{method:'PATCH',body:{deadline:new Date(2027,2,1,23,59).getTime()}}]);
});
test('cancel and save return focus to the edit button',async()=>{
  await render();await select();await click('Edit title and deadline');
  await click('Cancel');expect(document.activeElement).toBe(button('Edit title and deadline'));
  await click('Edit title and deadline');await fill(host.querySelector('form input')!,'Focused save');await click('Save details');
  expect(host.querySelector('form')).toBeNull();expect(document.activeElement).toBe(button('Edit title and deadline'));
});
test('at phone width the create dialog overlay stacks above the fixed detail panel',async()=>{
  const css=await Bun.file(new URL('./GoalsRoom.css',import.meta.url)).text();
  const phone=[...css.matchAll(/@media \(max-width: 600px\) \{([\s\S]*?)\n\}/g)];
  const z=(selector:RegExp)=>{for(const m of [...phone].reverse()){const r=m[1]!.match(new RegExp(selector.source+'[^{]*\\{[^}]*z-index:\\s*(\\d+)'));if(r)return {z:Number(r[1]),at:m.index!};}return null;};
  const panel=z(/\.v2-goals__side/),overlay=z(/\.v2-goals__overlay/);
  expect(panel&&overlay).toBeTruthy();expect(overlay!.z).toBeGreaterThan(panel!.z);
  // Equal specificity: the override must come after the base overlay rule.
  expect(overlay!.at).toBeGreaterThan(css.indexOf('.v2-goals__overlay {'));
});
test('a refused deadline shows the server reason in plain words',async()=>{
  await render();await select();await click('Edit title and deadline');
  const real=globalThis.fetch;
  globalThis.fetch=(async(url:any,init?:RequestInit)=>init?.method==='PATCH'?Response.json({error:'goal.deadline: cannot be after its ancestor deadline'},{status:400}):real(url,init)) as typeof fetch;
  await fill(host.querySelector<HTMLInputElement>('form input[type="date"]')!,'2026-11-21');await click('Save details');
  expect(host.querySelector('[role="alert"]')?.textContent).toBe("The deadline cannot be later than its parent goal's deadline. Pick an earlier date.");
  expect(host.querySelector<HTMLInputElement>('form input[type="date"]')?.value).toBe('2026-11-21');
});
test('a partly cleared date is not saved as removing the deadline',async()=>{
  await render();await select();await click('Edit title and deadline');
  const input=host.querySelector<HTMLInputElement>('form input[type="date"]')!;
  Object.defineProperty(input,'validity',{configurable:true,get:()=>({badInput:true})});
  await fill(input,'');await click('Save details');
  expect(writes).toHaveLength(0);expect(host.querySelector('[role="alert"]')?.textContent).toContain('Enter a valid deadline');
  await click('Clear deadline');await click('Save details');expect(writes).toEqual([{method:'PATCH',body:{deadline:null}}]);
});
test('a deadline changed elsewhere while editing is not reverted by a title edit',async()=>{
  await render();await select();await click('Edit title and deadline');
  const moved=new Date(2026,11,5,9,0).getTime();goal={...goal,deadline:moved};
  await React.act(async()=>{(host.querySelector('button[title="Refresh"]') as HTMLButtonElement).click();await wait();});
  expect(goal.deadline).toBe(moved);
  await fill(host.querySelector('form input')!,'Only the title');await click('Save details');
  expect(writes).toEqual([{method:'PATCH',body:{title:'Only the title'}}]);expect(goal.deadline).toBe(moved);
});
test('Escape cancels the inline editor and returns focus to its button',async()=>{
  await render();await select();await click('Edit title and deadline');
  const input=host.querySelector<HTMLInputElement>('form input')!;
  await React.act(async()=>{input.focus();input.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));await wait();});
  expect(host.querySelector('form')).toBeNull();expect(document.activeElement).toBe(button('Edit title and deadline'));expect(writes).toHaveLength(0);
});
test('a dialog opened by a Brief request returns focus to New when its opener is gone',async()=>{
  const { requestGoalCreation } = await import('./create-request');
  await render();(document.activeElement as HTMLElement|null)?.blur?.();
  await React.act(async()=>{requestGoalCreation();await wait();});
  expect(host.querySelector('[role="dialog"]')).toBeTruthy();
  await key('Escape');expect(host.querySelector('[role="dialog"]')).toBeNull();expect(document.activeElement).toBe(button('New'));
});
test('at phone width room toasts stay above the fixed detail panel',async()=>{
  const css=await Bun.file(new URL('./GoalsRoom.css',import.meta.url)).text();
  const rule=[...css.matchAll(/@media \(max-width: 600px\) \{([\s\S]*?)\n\}/g)].map(m=>m[1]!.match(/\.v2-goals__toast\s*\{[^}]*z-index:\s*(\d+)/)).find(Boolean);
  expect(Number(rule?.[1])).toBeGreaterThan(111);
});

const storedDrafts = () => Object.keys(sessionStorage).filter(k => k.startsWith('jarvis:goal-score-draft'));
const draftKey = (ws = 'ws-1', id = 'goal-1') => `jarvis:goal-score-draft:v2:${encodeURIComponent(JSON.stringify(['project-1', ws]))}:${id}`;
const refreshRoom = () => React.act(async()=>{host.querySelector<HTMLButtonElement>('button[title="Refresh"]')!.click();await wait();});
/** Storage whose reads and removals work but every write throws, like a full quota. */
async function withFailingWrites(run: () => Promise<void>, removals = true) {
  const original=Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage')!, real=sessionStorage;
  const failing={getItem:(k:string)=>real.getItem(k),removeItem:(k:string)=>{if(!removals)throw new Error('Storage blocked');real.removeItem(k);},setItem:()=>{throw new Error('QuotaExceededError');}};
  Object.defineProperty(globalThis, 'sessionStorage', {configurable:true,get:()=>failing});
  try { await run(); } finally { Object.defineProperty(globalThis, 'sessionStorage', original); }
}
const toastText = () => host.querySelector('.v2-goals__toast')?.textContent ?? null;
const scoreInput = () => host.querySelector<HTMLInputElement>('input[aria-label="Goal score"]')!;
const reasonInput = () => host.querySelector<HTMLInputElement>('section[aria-label="Update goal score"] input[type="text"]')!;
test('score saves with the user source and the entered reason, then clears its draft', async () => {
  await render(); await select(); await fill(scoreInput(), '50'); await fill(reasonInput(), 'Milestone shipped');
  await click('Save score');
  expect(writes).toEqual([{method:'POST',body:{score:0.5,reason:'Milestone shipped',source:'user',expected_updated_at:1}}]);
  expect(goal.score).toBe(0.5); expect(goal.score_reason).toBe('Milestone shipped');
  expect(storedDrafts()).toEqual([]);
  expect(button('Save score').disabled).toBe(true); expect(reasonInput().value).toBe('');
});
test('score and reason survive closing the detail and unmounting the entire room without a write', async () => {
  await render(); await select(); await fill(scoreInput(), '75'); await fill(reasonInput(), 'Keep this update');
  await click('Close detail'); await select(); expect(scoreInput().value).toBe('75'); expect(reasonInput().value).toBe('Keep this update');
  await React.act(async () => root.unmount()); root=createRoot(host); await render(); await select();
  expect(scoreInput().value).toBe('75'); expect(reasonInput().value).toBe('Keep this update'); expect(writes).toHaveLength(0);
  await click('Discard score draft'); expect(scoreInput().value).toBe('0'); expect(reasonInput().value).toBe('');
  expect(storedDrafts()).toEqual([]);
});
test('failed score saves show a reason and preserve the draft for a successful retry', async () => {
  await render(); await select(); await fill(scoreInput(), '25'); await fill(reasonInput(), 'Progress made');
  fail=true; await click('Save score');
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('Unavailable'); expect(toastText()).toBeNull();
  expect(scoreInput().value).toBe('25'); expect(reasonInput().value).toBe('Progress made'); expect(goal.score).toBe(0);
  await click('Close detail'); await select(); expect(reasonInput().value).toBe('Progress made');
  fail=false; await click('Save score'); expect(goal.score).toBe(0.25); expect(goal.score_reason).toBe('Progress made');
});
test('drafts are isolated by goal and a clean score follows refreshed server data', async () => {
  await render(); await select(); await fill(scoreInput(), '80'); await fill(reasonInput(), 'First goal only');
  await click('Close detail'); goal={...goal,id:'goal-2',title:'Other goal',score:0.2};
  await refreshRoom(); await select(); expect(scoreInput().value).toBe('20'); expect(reasonInput().value).toBe('');
  goal={...goal,score:0.4}; await refreshRoom(); expect(scoreInput().value).toBe('40');
  await fill(scoreInput(), '60'); goal={...goal,score:0.5}; await refreshRoom(); expect(scoreInput().value).toBe('60');
  await click('Discard score draft'); expect(scoreInput().value).toBe('50');
});

test('a pending score save disables duplicate submissions and editing', async () => {
  await render(); await select(); await fill(scoreInput(), '45');
  const original=globalThis.fetch; let resolve!: (response:Response)=>void;
  globalThis.fetch=(async(url:any,init?:RequestInit)=>String(url).endsWith('/score')?new Promise<Response>(r=>{resolve=r;}):original(url,init)) as typeof fetch;
  await click('Save score');expect(button('Saving…').disabled).toBe(true);expect(scoreInput().disabled).toBe(true);expect(reasonInput().disabled).toBe(true);
  await React.act(async()=>{resolve(Response.json({error:'Temporary failure'},{status:503}));await wait();});
  expect(button('Save score').disabled).toBe(false);expect(scoreInput().value).toBe('45');
  await click('Discard score draft');
});
test('unavailable browser storage retains SPA drafts and warns before refreshing', async () => {
  await render(); await select();
  const original=Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage')!;
  Object.defineProperty(globalThis, 'sessionStorage', {configurable:true,get:()=>{throw new Error('Storage blocked');}});
  try {
    await fill(scoreInput(), '65'); await fill(reasonInput(), 'Keep even with storage full');
    expect(host.textContent).toContain('Browser storage is unavailable');
    const event=new Event('beforeunload',{cancelable:true});window.dispatchEvent(event);expect(event.defaultPrevented).toBe(true);
    await click('Close detail');await select();expect(reasonInput().value).toBe('Keep even with storage full');
    expect(host.textContent).toContain('Browser storage is unavailable');
    await click('Discard score draft');
  } finally { Object.defineProperty(globalThis, 'sessionStorage', original); }
});

test('a score saved elsewhere while a draft exists is refused with 409 and shown before an explicit resave', async () => {
  await render(); await select(); await fill(scoreInput(), '70'); await fill(reasonInput(), 'My estimate');
  goal={...goal,score:0.3,updated_at:5}; // another tab saved; this room has not polled yet
  await click('Save score');
  expect(writes.at(-1)!.body.expected_updated_at).toBe(1); expect(goal.score).toBe(0.3);
  expect(host.querySelector('[data-score-conflict]')?.textContent).toContain('Score changed to 30% since your draft');
  expect(scoreInput().value).toBe('70'); expect(reasonInput().value).toBe('My estimate'); expect(toastText()).toBeNull();
  await click('Close detail'); await select();
  expect(host.querySelector('[data-score-conflict]')?.textContent).toContain('Score changed to 30%');
  await click('Save over new score');
  expect(writes.at(-1)!.body).toEqual({score:0.7,reason:'My estimate',source:'user',expected_updated_at:5});
  expect(goal.score).toBe(0.7); expect(storedDrafts()).toEqual([]); expect(host.querySelector('[data-score-conflict]')).toBeNull();
});
test('a refresh that moves the score past the draft base shows the change; one that moves only health does not', async () => {
  await render(); await select(); await fill(scoreInput(), '40');
  goal={...goal,health:'at_risk',updated_at:3}; await refreshRoom();
  expect(host.querySelector('[data-score-conflict]')).toBeNull(); expect(button('Save score').disabled).toBe(false);
  goal={...goal,score:0.9,updated_at:4}; await refreshRoom();
  expect(host.querySelector('[data-score-conflict]')?.textContent).toContain('Score changed to 90% since your draft (it was 0%)');
  expect(scoreInput().value).toBe('40');
  await click('Discard score draft'); expect(scoreInput().value).toBe('90'); expect(writes).toHaveLength(0);
  // A server score that reaches the draft (with no reason) leaves nothing to save.
  await fill(scoreInput(), '50'); goal={...goal,score:0.5,updated_at:6}; await refreshRoom();
  expect(storedDrafts()).toEqual([]); expect(host.querySelector('[data-score-conflict]')).toBeNull(); expect(button('Save score').disabled).toBe(true);
  // A sub-percent score write elsewhere (an agent tool) is still a change to show.
  await fill(scoreInput(), '80'); goal={...goal,score:0.503,updated_at:7}; await refreshRoom();
  expect(host.querySelector('[data-score-conflict]')?.textContent).toContain('Score changed to 50% since your draft');
});
test('a refresh still in flight from before a save does not put the old score back', async () => {
  await render(); await select(); await fill(scoreInput(), '50');
  staleRead={...goal}; await click('Save score');
  expect(goal.score).toBe(0.5); expect(scoreInput().value).toBe('50'); expect(host.textContent).not.toContain('Unsaved score draft');
});
test('a daemon without a host descriptor keeps drafts under one local owner', async () => {
  hostStatus=501; await render(); await select(); await fill(scoreInput(), '30');
  expect(storedDrafts()).toEqual([`jarvis:goal-score-draft:v2:local:goal-1`]);
  await click('Discard score draft');
});
test('an unconfirmed workspace keeps the draft in memory only and says why', async () => {
  hostStatus=503; await render(); await select(); await fill(scoreInput(), '30');
  expect(storedDrafts()).toEqual([]); expect(host.textContent).toContain('This workspace could not be confirmed');
  await click('Discard score draft');
});
test('measured goals show their score without an editor', async () => {
  goal={...goal,score:0.6,measurement:{basis:'value',revision:1}};
  await render(); await select();
  expect(host.querySelector('input[aria-label="Goal score"]')).toBeNull();
  expect(host.textContent).toContain('Score · 60%'); expect(host.textContent).toContain('Log progress from the Brief Goals room');
  expect(host.textContent).not.toContain('Save score');
});
test('returning to the saved score with no reason drops the draft; a reason alone can still be saved', async () => {
  await render(); await select(); await fill(scoreInput(), '50'); expect(storedDrafts()).toHaveLength(1);
  await fill(scoreInput(), '0');
  expect(storedDrafts()).toEqual([]); expect(host.textContent).not.toContain('Unsaved score draft'); expect(button('Save score').disabled).toBe(true);
  await fill(reasonInput(), 'Reviewed, no change');
  expect(button('Save score').disabled).toBe(false); await click('Save score');
  expect(writes).toEqual([{method:'POST',body:{score:0,reason:'Reviewed, no change',source:'user',expected_updated_at:1}}]);
});
test('a failed storage write never lets an older stored draft come back', async () => {
  sessionStorage.setItem(draftKey(), JSON.stringify({score:0.2,reason:'Older draft',baseScore:0,baseUpdatedAt:1}));
  await render(); await select(); expect(scoreInput().value).toBe('20'); expect(reasonInput().value).toBe('Older draft');
  await withFailingWrites(async () => {
    await fill(scoreInput(), '65'); expect(host.textContent).toContain('Browser storage is unavailable');
    expect(sessionStorage.getItem(draftKey())).toContain('Older draft');
    await click('Close detail'); await select(); expect(scoreInput().value).toBe('65'); expect(reasonInput().value).toBe('Older draft');
  }, false);
  // When removal still works, the stale stored copy is removed so a reload cannot restore it.
  await withFailingWrites(async () => { await fill(scoreInput(), '70'); expect(sessionStorage.getItem(draftKey())).toBeNull(); });
  // Discarding while storage refuses both writes and removals must not let the stored copy return.
  sessionStorage.setItem(draftKey(), JSON.stringify({score:0.2,reason:'Older draft',baseScore:0,baseUpdatedAt:1}));
  await withFailingWrites(async () => {
    await click('Discard score draft'); await click('Close detail'); await select();
    expect(scoreInput().value).toBe('0'); expect(reasonInput().value).toBe('');
  }, false);
});
test('drafts belong to one workspace and in-memory drafts are dropped when the owner changes', async () => {
  await render(); await select(); await fill(scoreInput(), '35'); await fill(reasonInput(), 'Workspace one');
  await React.act(async () => root.unmount()); root=createRoot(host); workspace='ws-2'; await render(); await select();
  expect(scoreInput().value).toBe('0'); expect(reasonInput().value).toBe('');
  await withFailingWrites(async () => { await fill(reasonInput(), 'Held only in memory'); expect(host.textContent).toContain('Browser storage is unavailable'); });
  await React.act(async () => root.unmount()); root=createRoot(host); workspace='ws-1'; await render(); await select();
  expect(scoreInput().value).toBe('35'); expect(reasonInput().value).toBe('Workspace one');
  await React.act(async () => root.unmount()); root=createRoot(host); workspace='ws-2'; await render(); await select();
  expect(reasonInput().value).toBe('');
});

test('the create dialog says new goals start as drafts, and refuses a past deadline or a long title before writing', async () => {
  await render(); await click('New');
  const dialog = host.querySelector<HTMLElement>('[role="dialog"]')!;
  expect(dialog.textContent).toContain('A new goal starts as a draft');
  const title = dialog.querySelector<HTMLInputElement>('input[type="text"]')!;
  await fill(title, 'x'.repeat(201)); await click('Create', dialog);
  expect(dialog.querySelector('[role="alert"]')?.textContent).toBe('Titles can be up to 200 characters. Shorten it and try again.');
  await fill(title, 'Late goal');
  await fill(dialog.querySelector<HTMLInputElement>('input[type="date"]')!, '2020-01-01'); await click('Create', dialog);
  expect(dialog.querySelector('[role="alert"]')?.textContent).toBe('That date has passed. Pick today or a later date.');
  expect(writes).toHaveLength(0);
});
test('a server refusal of a new goal is shown in plain words inside the dialog toast', async () => {
  await render(); await click('New');
  const dialog = host.querySelector<HTMLElement>('[role="dialog"]')!;
  globalThis.fetch = (async (_url: any, _init?: RequestInit) => Response.json({ error: 'goal.title: must be 200 characters or fewer', code: 'INVALID_GOAL' }, { status: 400 })) as typeof fetch;
  await fill(dialog.querySelector<HTMLInputElement>('input[type="text"]')!, 'Fine title'); await click('Create', dialog);
  expect(host.querySelector('.v2-goals__toast')?.textContent).toBe('Titles can be up to 200 characters. Shorten it and try again.');
});
test('a goal whose title was saved before the 200 character cap can still move its deadline', async () => {
  goal={...goal,title:'x'.repeat(250)};
  await render();await select();await click('Edit title and deadline');
  await fill(host.querySelector<HTMLInputElement>('form input[type="date"]')!,'2027-03-01');await click('Save details');
  expect(writes).toEqual([{method:'PATCH',body:{deadline:new Date(2027,2,1,23,59).getTime()}}]);
});
