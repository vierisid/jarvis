import { beforeAll, beforeEach, afterEach, afterAll, test, expect } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { GETTING_STARTED_IDS, type GettingStartedState } from '../../../../../src/brief/getting-started-contract';
import type { HostTransport } from '../../host/http';
import type { BriefRoute } from '../../contracts';
let React:typeof import('react'), createRoot:typeof import('react-dom/client').createRoot, GettingStarted:typeof import('./GettingStarted').GettingStarted;
let root:ReturnType<typeof createRoot>, host:HTMLDivElement, stored:GettingStartedState, destinations:BriefRoute[], writes:number, fail:boolean, http:HostTransport;
beforeAll(async()=>{ GlobalRegistrator.register(); (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true; React=await import('react'); ({createRoot}=await import('react-dom/client')); ({GettingStarted}=await import('./GettingStarted')); });
beforeEach(()=>{ host=document.createElement('div'); document.body.append(host); root=createRoot(host); stored={revision:0,completed:[],hidden:false};destinations=[];writes=0;fail=false;
  http={ json:async(_path:string,init?:RequestInit)=>{if(init?.method==='PATCH'){writes++;if(fail)throw Error('network');const {revision,change}=JSON.parse(init.body as string);if(revision!==stored.revision)throw Error('conflict');stored={revision:revision+1,hidden:change.hidden??stored.hidden,completed:change.item ? GETTING_STARTED_IDS.filter(id=>id===change.item?change.done:stored.completed.includes(id)):stored.completed};} return structuredClone(stored);} } as HostTransport;
});
afterEach(async()=>{await React.act(async()=>root.unmount());host.remove();});afterAll(()=>GlobalRegistrator.unregister());
const button=(text:string)=>[...host.querySelectorAll<HTMLButtonElement>('button')].find(b=>(b.getAttribute('aria-label')??b.textContent).includes(text))!;
async function render(compact=false){await React.act(async()=>root.render(<div className="brief-root"><GettingStarted transport={http} navigate={r=>destinations.push(r)} goalId="existing-goal" compact={compact}/></div>));}
async function click(text:string){await React.act(async()=>button(text).click());}
async function check(){await React.act(async()=>host.querySelector<HTMLInputElement>('input')!.click());}

test('ten real destinations, initial three steps, opening never claims completion or creates work',async()=>{
  await render();expect(host.querySelectorAll('li')).toHaveLength(3);await click('Show all 10');expect(host.querySelectorAll('li')).toHaveLength(10);
  const opens=[...host.querySelectorAll<HTMLButtonElement>('.brief-setup-open')];
  for(const open of opens)await React.act(async()=>open.click());
  expect(destinations.map(r=>r.room)).toEqual(['goals','authority','authority','connected-workspace','profile','memory','all-workflows','needs-you','opportunities','settings']);
  expect(destinations[0]?.selection).toEqual({goalId:'existing-goal'});expect(writes).toBe(0);expect(stored.completed).toEqual([]);
});
test('completion and undo survive remount; hiding is reversible and persisted',async()=>{
  await render();await check();expect(stored.completed).toEqual(['goal']);expect(host.textContent).toContain('1 of 10');
  await React.act(async()=>root.render(null));await render();expect(host.textContent).toContain('1 of 10');
  await click('Show all 10');await check();expect(stored.completed).toEqual([]);
  await click('Hide setup');expect(stored.hidden).toBe(true);expect(host.querySelector('ul')).toBeNull();
  await React.act(async()=>root.render(null));await render();expect(host.querySelector('ul')).toBeNull();await click('Continue setting');expect(stored.hidden).toBe(false);expect(host.querySelectorAll('li')).toHaveLength(10);
});
test('failed acknowledgement never checks a box and requires refresh; duplicate clicks issue one write',async()=>{
  await render();fail=true;await React.act(async()=>{host.querySelector<HTMLInputElement>('input')!.click();host.querySelector<HTMLInputElement>('input')!.click();});
  expect(writes).toBe(1);expect(stored.completed).toEqual([]);expect(host.querySelector<HTMLInputElement>('input')!.checked).toBe(false);expect(host.textContent).toContain('not confirmed');
  fail=false;await click('Refresh checklist');await check();expect(stored.completed).toEqual(['goal']);
});
test('real decisions and completed setup use a compact, recoverable checklist',async()=>{
  await render(true);expect(host.querySelector('ul')).toBeNull();await click('Continue setting');expect(host.querySelectorAll('li')).toHaveLength(10);
  stored={revision:3,completed:[...GETTING_STARTED_IDS],hidden:false};await React.act(async()=>root.render(null));await render();expect(host.textContent).toContain('Setup complete');expect(host.querySelector('ul')).toBeNull();await click('Review checklist');expect(host.querySelectorAll('input:checked')).toHaveLength(10);
});
