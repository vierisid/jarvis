import { beforeAll, afterAll, test, expect } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import type { SettingsHook } from '../useSettingsData';
let React: typeof import('react'), createRoot: typeof import('react-dom/client').createRoot, Tab: typeof import('./IntegrationsTab').IntegrationsTab;
beforeAll(async()=>{GlobalRegistrator.register();(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;React=await import('react');({createRoot}=await import('react-dom/client'));({IntegrationsTab:Tab}=await import('./IntegrationsTab'));});
afterAll(()=>GlobalRegistrator.unregister());
test('Google credential fields have unique label associations and the secret stays masked',async()=>{
  const savedFetch=globalThis.fetch,calls:string[]=[];
  globalThis.fetch=(async(url:any)=>{calls.push(String(url));return Response.json({configured:false,connected:false});}) as typeof fetch;
  const host=document.createElement('div');document.body.append(host);const root=createRoot(host);
  const data={google:{status:'not_configured',managed:false},refresh(){}} as SettingsHook;
  try {
    await React.act(async()=>root.render(<><Tab data={data} onToast={()=>{}}/><Tab data={data} onToast={()=>{}}/></>));
    const labels=[...host.querySelectorAll('label')].filter(x=>['Client ID','Client secret'].includes(x.textContent!));
    expect(labels).toHaveLength(4);
    expect(new Set(labels.map(x=>x.htmlFor)).size).toBe(4);
    for(const label of labels){
      expect(label.htmlFor).not.toBe('');
      const input=document.getElementById(label.htmlFor) as HTMLInputElement;
      expect(input?.tagName).toBe('INPUT');expect(input.value).toBe('');
      expect(input.type).toBe(label.textContent==='Client secret'?'password':'text');
    }
    expect(calls.some(url=>url.includes('/init')||url.includes('/credentials'))).toBe(false);
  } finally {await React.act(async()=>root.unmount());host.remove();globalThis.fetch=savedFetch;}
});
