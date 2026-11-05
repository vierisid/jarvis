import { beforeAll, afterAll, beforeEach, afterEach, test, expect } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import type { Root } from 'react-dom/client';
let React: typeof import('react'), createRoot: typeof import('react-dom/client').createRoot;
let useStatus: typeof import('./EmergencyStatus').useEmergencyStatus, Banner: typeof import('./EmergencyStatus').EmergencyStatusBanner;
let root: Root, host: HTMLDivElement, status: any, writes: string[], opened: number;
beforeAll(async () => { GlobalRegistrator.register(); (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
  React=await import('react'); ({createRoot}=await import('react-dom/client')); ({useEmergencyStatus:useStatus,EmergencyStatusBanner:Banner}=await import('./EmergencyStatus')); });
beforeEach(() => { host=document.createElement('div');document.body.append(host);root=createRoot(host);status={enabled:true,emergency_state:'paused',config:{emergency_state:'normal'}};writes=[];opened=0; });
afterEach(async () => { await React.act(async()=>root.unmount());host.remove(); });
afterAll(()=>GlobalRegistrator.unregister());
const http:any={json:async(path:string,init?:RequestInit)=>{writes.push(init?.method??'GET');expect(path).toBe('/api/authority/status');if(status instanceof Error)throw status;return status;}};
function App(){const state=useStatus(http);return <Banner state={state} open={()=>opened++}/>;}
const settle=()=>new Promise(r=>setTimeout(r,5));
async function render(){await React.act(async()=>{root.render(<App/>);await settle();});}
async function focus(){await React.act(async()=>{window.dispatchEvent(new Event('focus'));await settle();});}
test('pause is visible after reload, reads the current state and links without resuming work',async()=>{
 await render();expect(host.textContent).toContain('Jarvis is paused globally');expect(host.textContent).toContain('save input and approval responses');
 await React.act(async()=>host.querySelector('button')!.click());expect(opened).toBe(1);expect(writes.every(method=>method==='GET')).toBe(true);
 await React.act(async()=>root.unmount());root=createRoot(host);await render();expect(host.textContent).toContain('paused globally');
 status={enabled:true,emergency_state:'normal',config:{emergency_state:'paused'}};await focus();expect(host.querySelector('aside')).toBeNull();
});
test('kill and failed reads cannot masquerade as normal operation',async()=>{
 status={enabled:true,emergency_state:'killed'};await render();expect(host.textContent).toContain('will not restart automatically');
 status=new Error('offline');await focus();expect(host.textContent).toContain('Emergency status is unavailable');
 status={enabled:true,emergency_state:'unexpected'};await focus();expect(host.textContent).toContain('Emergency status is unavailable');
 status={enabled:false};await focus();expect(host.querySelector('aside')).toBeNull();
});
