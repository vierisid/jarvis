import { beforeAll, beforeEach, afterEach, afterAll, test, expect } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import type { Root } from 'react-dom/client';
import type { Goal } from './useGoalsData';
let React: typeof import('react'), createRoot: typeof import('react-dom/client').createRoot,
  Room: typeof import('./GoalsRoom').GoalsRoomBody, root: Root, host: HTMLDivElement;
let originalFetch: typeof fetch, goal: Goal, writes: Array<{method: string; body: any}>, fail: boolean;
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
  writes=[]; fail=false;
  globalThis.fetch = (async (url: any, init?: RequestInit) => {
    const path=String(url), method=init?.method ?? 'GET';
    if(method !== 'GET') {
      const body=JSON.parse(String(init?.body)); writes.push({method,body});
      if(fail) return Response.json({error:'Unavailable'}, {status:503});
      if(method === 'PATCH') goal={...goal,...body};
      else if(path.endsWith('/status')) goal={...goal,status:body.status};
      else if(path.endsWith('/health')) goal={...goal,health:body.health};
      else if(method === 'POST') goal={...goal,...body};
      return Response.json(goal);
    }
    if(path.endsWith('/metrics')) return Response.json({total:1,active:1,completed:0,failed:0,killed:0,avg_score:0,on_track:1,at_risk:0,behind:0,critical:0,overdue:0});
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
