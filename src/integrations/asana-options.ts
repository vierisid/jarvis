import type {JarvisConfig} from "../config/types";
import {freshAsanaConnection} from "./asana-refresh";
import {asanaGid, asanaRequest} from "../workflows/runtime/managed-asana";
/** One explicit page, fixed URL and fields; never follow the provider's next-page URL. */
export async function asanaOptions(config:JarvisConfig,query:URLSearchParams,request:typeof fetch=fetch) {
  const workspace=asanaGid(query.get("workspace"));
  const offset=query.get("offset");
  if(offset && offset.length>4096)throw new Error("Invalid Asana pagination offset.");
  const c=await freshAsanaConnection(config,request);
  if(!c.workspaces.some(w=>w.id===workspace))throw new Error("Choose a connected Asana workspace.");
  const params=new URLSearchParams({limit:"100",archived:"false",opt_fields:"name"});
  if(offset)params.set("offset",offset);
  const page=await asanaRequest(c.access_token,"/workspaces/"+workspace+"/projects?"+params,"GET",undefined,request);
  if(!Array.isArray(page.data) || page.data.length>100)throw new Error("Asana returned invalid project choices.");
  const options=page.data.map((p:any)=>({value:asanaGid(p.gid),label:typeof p.name==="string" ? p.name.slice(0,200) : asanaGid(p.gid)}));
  if(page.next_page!=null && (typeof page.next_page.offset!=="string" || !page.next_page.offset || page.next_page.offset.length>4096))throw new Error("Asana returned invalid project pagination.");
  return {options,next_offset:page.next_page?.offset ?? null};
}
