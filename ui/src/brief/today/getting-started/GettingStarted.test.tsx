import { beforeAll, beforeEach, afterEach, afterAll, test, expect } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { GETTING_STARTED_IDS, type GettingStartedState } from '../../../../../src/brief/getting-started-contract';
import type { HostTransport } from '../../host/http';
import type { BriefRoute } from '../../contracts';

let React:typeof import('react'), createRoot:typeof import('react-dom/client').createRoot;
let UI:typeof import('./GettingStarted');
let root:ReturnType<typeof createRoot>, host:HTMLDivElement, stored:GettingStartedState, destinations:BriefRoute[], writes:number, fail:boolean, http:HostTransport;
let journey:InstanceType<typeof UI.GettingStartedJourney>, route:BriefRoute, allowLeave:boolean;
beforeAll(async()=>{ GlobalRegistrator.register(); (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true; React=await import('react'); ({createRoot}=await import('react-dom/client')); UI=await import('./GettingStarted'); });
beforeEach(()=>{ host=document.createElement('div'); document.body.append(host); root=createRoot(host); stored={revision:0,completed:[],hidden:false};destinations=[];writes=0;fail=false;allowLeave=true;route={room:'today',selection:{}};
  window.localStorage.clear();
  http={ json:async(_path:string,init?:RequestInit)=>{if(init?.method==='PATCH'){writes++;if(fail)throw Error('network');const {revision,change}=JSON.parse(init.body as string);if(revision!==stored.revision)throw Error('conflict');stored={revision:revision+1,hidden:change.hidden??stored.hidden,completed:change.item ? GETTING_STARTED_IDS.filter(id=>id===change.item?change.done:stored.completed.includes(id)):stored.completed};} return structuredClone(stored);} } as HostTransport;
  journey=new UI.GettingStartedJourney(http,window.localStorage,'scope');
});
afterEach(async()=>{await React.act(async()=>root.unmount());journey.retire();host.remove();});afterAll(()=>GlobalRegistrator.unregister());
const button=(text:string)=>[...host.querySelectorAll<HTMLButtonElement>('button')].find(b=>(b.getAttribute('aria-label')??b.textContent).includes(text))!;
function navigate(r:BriefRoute){destinations.push(r);route=r;}
async function render(compact=false){await React.act(async()=>root.render(<div className="brief-root"><UI.GettingStarted journey={journey} navigate={navigate} goalId="existing-goal" compact={compact}/></div>));}
async function destination(){await React.act(async()=>root.render(<div className="brief-root"><UI.GettingStartedDestination journey={journey} shell={{route,navigate} as any} canLeave={async()=>allowLeave}><h1>Real page</h1></UI.GettingStartedDestination></div>));}
async function click(text:string){await React.act(async()=>button(text).click());}
async function open(){await click('Review setup action');const b=host.querySelector<HTMLButtonElement>('.brief-today-paper-actions button')!;await React.act(async()=>b.click());}

test('one paper at a time; ten destinations advance only after the review is completed',async()=>{
  const expected=['goals','authority','authority','connected-workspace','profile','memory','all-workflows','needs-you','opportunities','settings'] as const;
  for(let i=0;i<10;i++){
    await render();expect(host.querySelectorAll('.brief-setup-hero')).toHaveLength(1);expect(host.querySelector('input')).toBeNull();
    expect(host.textContent).toContain(`${10-i} ${i===9?'action':'actions'}`);
    await open();expect(route.room).toBe(expected[i]!);if(!i)expect(route.selection).toEqual({goalId:'existing-goal'});
    expect(writes).toBe(i);await destination();expect(host.textContent).toContain('Real page');await click('Done, back');
    expect(route.room).toBe('today');expect(stored.completed).toEqual(GETTING_STARTED_IDS.slice(0,i+1));
  }
  await render();expect(host.textContent).toContain('All 10 setup actions complete');expect(host.querySelector('.brief-setup-hero')).toBeNull();
  await click('Undo last');expect(stored.completed).toHaveLength(9);expect(host.textContent).toContain('Set your dashboard preferences');
});
test('hover/focus details have a keyboard/touch review control and Escape closes them',async()=>{
  await render();expect(host.querySelector('.brief-today-paper-clip')?.getAttribute('data-raised')).toBe('false');
  await click('Review setup action');expect(host.querySelector('.brief-today-paper-clip')?.getAttribute('data-raised')).toBe('true');
  await React.act(async()=>host.querySelector('section')!.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})));
  expect(button('Review setup').getAttribute('aria-expanded')).toBe('false');expect(document.activeElement).toBe(button('Review setup'));expect(writes).toBe(0);
});
test('returning without completing and blocked unsaved edits never advance; unrelated rooms hide the return action',async()=>{
  await render();await open();await destination();allowLeave=false;await click('Done, back');expect(writes).toBe(0);expect(route.room).toBe('goals');
  allowLeave=true;await click('Back without');expect(journey.snapshot().active).toBeNull();expect(route.room).toBe('today');await render();expect(host.textContent).toContain('Review your goal');
  route={room:'settings',selection:{}};await destination();expect(button('Done, back')).toBeUndefined();
});
test('review destination and completed progress survive owner recreation, without cross-scope leakage',async()=>{
  await render();await open();journey.retire();journey=new UI.GettingStartedJourney(http,window.localStorage,'scope');await destination();expect(button('Done, back')).toBeDefined();await click('Done, back');
  journey.retire();journey=new UI.GettingStartedJourney(http,window.localStorage,'scope');await render();expect(host.textContent).toContain('Choose your default authority');expect(host.textContent).toContain('1 of 10');
  expect(new UI.GettingStartedJourney(http,window.localStorage,'other').snapshot().active).toBeNull();
});
test('failed or lost completion never advances; refresh reconciles and double presses issue one write',async()=>{
  await render();await open();await destination();fail=true;
  await React.act(async()=>{button('Done, back').click();button('Done, back').click();});
  expect(writes).toBe(1);expect(stored.completed).toEqual([]);expect(route.room).toBe('goals');expect(host.textContent).toContain('not confirmed');
  // A lost acknowledgement may have committed. Refresh recovers it without another write.
  stored={revision:1,completed:['goal'],hidden:false};fail=false;await click('Refresh setup');await click('Done, back');
  expect(writes).toBe(1);expect(route.room).toBe('today');await render();expect(host.textContent).toContain('1 of 10');
});
test('existing progress and dismissal survive; real decisions keep the sequence compact',async()=>{
  stored={revision:5,completed:['goal','authority'],hidden:false};await render(true);expect(host.querySelector('.brief-setup-hero')).toBeNull();await click('Continue setting');expect(host.querySelector('.brief-setup-hero')?.getAttribute('data-step')).toBe('governed-actions');
  await click('Hide setup');expect(stored.hidden).toBe(true);await React.act(async()=>root.render(null));await render();expect(host.querySelector('.brief-setup-hero')).toBeNull();await click('Continue setting');expect(stored.hidden).toBe(false);expect(stored.completed).toEqual(['goal','authority']);
});
test('retired owner ignores late completion and cannot mutate or navigate a new scope',async()=>{
  let release:(value:unknown)=>void=()=>{};
  const original=http.json;http.json=(async(path:string,init?:RequestInit)=>init?.method==='PATCH'?new Promise(resolve=>{release=resolve;}):original(path,init)) as typeof http.json;
  await render();await open();await destination();await React.act(async()=>button('Done, back').click());
  journey.retire();await React.act(async()=>release({revision:1,completed:['goal'],hidden:false}));expect(route.room).toBe('goals');expect(journey.snapshot().state?.completed).toEqual([]);
});

test('background checks preserve the empty hero; errors and actual decisions are never treated as empty',async()=>{
  const {todayDecisionSnapshot}=await import('../../host/data-rooms');
  const empty={state:'stale' as const,data:null,asOf:123,refreshing:true,reason:null};
  expect(todayDecisionSnapshot(empty).state).toBe('empty');
  expect(todayDecisionSnapshot({...empty,reason:'read_failed',refreshing:false}).state).toBe('stale');
  expect(todayDecisionSnapshot({...empty,asOf:null}).state).toBe('stale');
  expect(todayDecisionSnapshot({...empty,data:[{id:'real-decision'}]}).state).toBe('stale');
});
