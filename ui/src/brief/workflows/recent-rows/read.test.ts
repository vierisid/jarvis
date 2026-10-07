import { expect, test } from "bun:test";
import { readRecentWorkflows } from "./read";
test("current API reads canonical IDs/status, excludes never-run drafts, never forwards captured output",async()=>{
  const urls:string[]=[];const state=await readRecentWorkflows(async url=>{urls.push(url);
    return Response.json(url.startsWith('/api/workflows?')?[{id:"a"},{id:"b"}]:url.includes('/a/runs')?[{id:"run-a",flowId:"a",flowVersionId:"v-a",status:"FAILED",environment:"PRODUCTION",startTime:42,steps:{private:"CANARY"}}]:url.includes('/b/runs')?[]:{latestDraft:{displayName:"Brief"}});
  });expect(state).toMatchObject({status:"ready",data:[{flowId:"a",versionId:"v-a",runId:"run-a",name:"Brief",status:"FAILED",result:"Run failed",at:42}]});expect(JSON.stringify(state)).not.toContain("CANARY");expect(urls.every(url=>url.startsWith('/api/workflows'))).toBe(true);
});
test("unavailable run reads are not an empty collection",async()=>{const state=await readRecentWorkflows(async url=>Response.json(url.includes('?limit=50')?[{id:"a"}]:{}, {status:url.includes('/runs')?503:200}));expect(state.status).toBe("unavailable");});
test("partial reads preserve known rows and disclose incompleteness",async()=>{const state=await readRecentWorkflows(async url=>Response.json(url.includes('?limit=50')?[{id:"a"},{id:"b"}]:url.includes('/a/runs')?[{id:"r",flowId:"a",flowVersionId:"v",status:"SUCCEEDED",environment:"TESTING",created:1,startTime:null}]:{}, {status:url.includes('/b/runs')?503:200}));expect(state.status).toBe("stale");expect('data' in state&&state.data[0]?.environment).toBe("TESTING");});
test("cross-flow or malformed runs cannot be displayed",async()=>{const state=await readRecentWorkflows(async url=>Response.json(url.includes('?limit=50')?[{id:"a"}]:[{id:"r",flowId:"other",status:"SUCCEEDED"}]));expect(state.status).toBe("unavailable");});
test("inventory is paginated and capped; workers never run more than four reads",async()=>{
 let active=0,max=0,calls=0;const state=await readRecentWorkflows(async url=>{calls++;active++;max=Math.max(max,active);await Bun.sleep(1);active--;const params=new URL(url,"http://test").searchParams;const offset=Number(params.get('offset'));return Response.json(url.includes('/runs')?[]:Array.from({length:offset===200?1:50},(_,i)=>({id:`f${offset+i}`})));});expect(state.status).toBe("unavailable");expect(calls).toBe(205);expect(max).toBe(4);
});
test("empty inventory has no run requests and stays distinct",async()=>{let calls=0;const state=await readRecentWorkflows(async()=>{calls++;return Response.json([]);});expect(state.status).toBe("empty");expect(calls).toBe(1);});
