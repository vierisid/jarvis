import {afterEach,beforeEach,expect,test} from "bun:test";
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {randomUUID} from "node:crypto";
import {asanaOptions,AsanaOptionsInputError} from "./asana-options";
let dir:string,config:any;
beforeEach(()=>{dir=mkdtempSync(join(tmpdir(),"asana-options-"));mkdirSync(join(dir,"connections"));config={daemon:{data_dir:dir},usejarvis_integrations:{page_url:"https://app.usejarvis.dev/account"}};
writeFileSync(join(dir,"connections/asana.json"),JSON.stringify({version:1,provider:"asana",status:"connected",generation:randomUUID(),access_token:"PRIVATE",refresh_token:"REFRESH",expires_at:new Date(Date.now()+3600000).toISOString(),refresh:{url:"https://app.usejarvis.dev/api/integrations/asana/refresh",instance_id:randomUUID(),secret:"a".repeat(64)},account:{id:"9",label:"Owner"},workspaces:[{id:"1",name:"Sandbox"}],connected_at:new Date().toISOString()}));});
afterEach(()=>rmSync(dir,{recursive:true,force:true}));
test("project choices use the selected workspace and opaque pagination, never provider URLs",async()=>{
  const request=(async(url:string,init:RequestInit)=>{const u=new URL(url);expect(u.origin+u.pathname).toBe("https://app.asana.com/api/1.0/workspaces/1/projects");expect(u.searchParams.get("offset")).toBe("a&b");expect(init.redirect).toBe("error");return Response.json({data:[{gid:"2",name:"Sandbox"}],next_page:{offset:"next",uri:"https://attacker.test"}});}) as unknown as typeof fetch;
  expect(await asanaOptions(config,new URLSearchParams({workspace:"1",offset:"a&b"}),request)).toEqual({options:[{value:"2",label:"Sandbox"}],next_offset:"next"});
});
test("wrong workspace, malformed IDs and revoked credentials cannot dispatch project reads",async()=>{
  let calls=0;const request=(async()=>{calls++;return Response.json({});}) as unknown as typeof fetch;
  for(const workspace of ["2","../secrets"])await expect(asanaOptions(config,new URLSearchParams({workspace}),request)).rejects.toBeInstanceOf(AsanaOptionsInputError);
  await expect(asanaOptions(config,new URLSearchParams({workspace:"1",offset:"x".repeat(4097)}),request)).rejects.toBeInstanceOf(AsanaOptionsInputError);
  writeFileSync(join(dir,"connections/asana.json"),JSON.stringify({version:1,provider:"asana",status:"disconnected"}));
  await expect(asanaOptions(config,new URLSearchParams({workspace:"1"}),request)).rejects.toThrow("Connect Asana");
  await expect(asanaOptions(config,new URLSearchParams({workspace:"1"}),request)).rejects.not.toBeInstanceOf(AsanaOptionsInputError);expect(calls).toBe(0);
});
