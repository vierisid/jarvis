import {expect,test} from "bun:test";
import {runManagedAsanaAction,MANAGED_ASANA_ACTIONS,ASANA_TASK_FIELDS} from "./managed-asana";
import {resolveGovernedPieceAction,tracksPieceCompletion} from "./piece-effects";
import {executeAuthorizedPiece} from "./piece-effect-guard";
const auth={access_token:"PRIVATE",jarvis_managed:"asana"};
test("qualified requests preserve upstream output shapes, dates, booleans and pagination",async()=>{
  const calls:Array<{url:URL;init:RequestInit;data:any}>=[];
  const request=(async(url:string,init:RequestInit)=>{
    calls.push({url:new URL(url),init,data:init.body?JSON.parse(String(init.body)).data:null});
    expect(init.redirect).toBe("error");expect(new Headers(init.headers).get("authorization")).toBe("Bearer PRIVATE");
    return Response.json(url.includes("/projects/")?{data:[{gid:"12",name:"Task"}],next_page:{offset:"next&safe",uri:"https://attacker.test"}}:{data:{gid:"12",name:"Task"}});
  }) as unknown as typeof fetch;
  const create=await runManagedAsanaAction("create_task",{auth,workspace:"1",project:"2",name:"Task",notes:"Notes",due_on:"2026-10-30",assignee:"me",tags:[]},request);
  expect(create).toEqual({gid:"12",name:"Task"});expect(calls[0]!.data).toMatchObject({projects:["2"],workspace:"1",due_on:"2026-10-30"});expect(calls[0]!.data.due_at).toBeUndefined();
  await runManagedAsanaAction("get_task",{auth,task:"12"},request);
  await runManagedAsanaAction("update_task",{auth,task:"12",completed:false,notes:"Updated"},request);
  expect(calls[2]!.init.method).toBe("PUT");expect(calls[2]!.data.completed).toBe(false);
  const page=await runManagedAsanaAction("list_project_tasks",{auth,project:"2",offset:"a&b",limit:10,completed_since:"now"},request);
  expect(page).toEqual({data:[{gid:"12",name:"Task"}],next_offset:"next&safe"});expect(calls[3]!.url.searchParams.get("offset")).toBe("a&b");
  await runManagedAsanaAction("add_task_comment",{auth,task:"12",text:"Comment",is_pinned:false},request);
  expect(calls[4]!.url.pathname).toBe("/api/1.0/tasks/12/stories");expect(calls[4]!.data).toEqual({text:"Comment",is_pinned:false});
  expect(calls.every(c=>c.url.origin==="https://app.asana.com")).toBe(true);
});
test("bad destinations and unsupported or ambiguous input fail before dispatch",async()=>{
  let calls=0;const request=(async()=>{calls++;return Response.json({data:{gid:"1"}});}) as unknown as typeof fetch;
  for(const [action,input] of [
    ["custom_api_call",{}],["get_task",{task:"1/../../secrets"}],["create_task",{workspace:"1",project:"2",name:"Task",notes:"Notes",tags:["3"]}],
    ["update_task",{task:"1"}],["update_task",{task:"1",due_on:"2026-02-30"}],["update_task",{task:"1",completed:"false"}],
    ["update_task",{task:"1",notes:"plain",html_notes:"<body>html</body>"}],["add_task_comment",{task:"1"}],
    ["list_project_tasks",{project:"1",limit:101}],
  ] as Array<[string,Record<string,unknown>]>) await expect(runManagedAsanaAction(action,{auth,...input},request)).rejects.toThrow();
  expect(calls).toBe(0);
});
test("provider failures are bounded, sanitized and never automatically retried",async()=>{
  for(const response of [()=>Response.json({error:"PRIVATE"},{status:401}),()=>Response.json({error:"PRIVATE"},{status:429}),()=>Response.json({data:{bad:"PRIVATE"}}),()=>new Response("PRIVATE".repeat(200000))]) {
    let calls=0;
    try {await runManagedAsanaAction("get_task",{auth,task:"1"},(async()=>{calls++;return response();}) as unknown as typeof fetch);throw new Error("expected refusal");}
    catch(e){expect(String(e)).not.toContain("PRIVATE");expect(String(e)).not.toContain("expected refusal");}
    expect(calls).toBe(1);
  }
});
test("reads and writes are governed and completed writes replay without provider dispatch",async()=>{
  for(const name of MANAGED_ASANA_ACTIONS){expect(resolveGovernedPieceAction("@activepieces/piece-asana",name)?.known).toBe(true);expect(tracksPieceCompletion("@activepieces/piece-asana",name)).toBe(["create_task","update_task","add_task_comment"].includes(name));}
  expect(resolveGovernedPieceAction("@activepieces/piece-asana","add_task_comment")?.category).toBe("send_message");
  expect(resolveGovernedPieceAction("@activepieces/piece-asana","delete_task")?.category).toBe("delete_data");
  expect(resolveGovernedPieceAction("@activepieces/piece-asana","custom_api_call")).toMatchObject({category:"modify_settings",known:false});
  let calls=0;const params={piece:"@activepieces/piece-asana",action:"create_task",input:{auth}} as any;
  expect(await executeAuthorizedPiece(params,{dispatch:"completed",result:{gid:"1"}} as any,async()=>{calls++;})).toEqual({gid:"1"});
  await expect(executeAuthorizedPiece(params,{dispatch:"held"} as any,async()=>{calls++;})).rejects.toThrow("waiting");expect(calls).toBe(0);
});
test("a valid JSON answer over the 1 MiB cap is refused; one just under it is read",async()=>{
  const body=(size:number)=>{const head='{"data":{"gid":"1","notes":"',tail='"}}';return head+"x".repeat(size-head.length-tail.length)+tail;};
  const under=await runManagedAsanaAction("get_task",{auth,task:"1"},(async()=>new Response(body(1048576))) as unknown as typeof fetch) as Record<string,unknown>;
  expect(String(under.notes).length).toBeGreaterThan(1048000);
  await expect(runManagedAsanaAction("get_task",{auth,task:"1"},(async()=>new Response(body(1048577))) as unknown as typeof fetch)).rejects.toThrow("invalid response");
});
test("only the requested fields reach the step output",async()=>{
  const request=(async(url:string)=>Response.json(url.includes("/projects/")
    ?{data:[{gid:"12",name:"Task",extra:"PRIVATE",assignee:{gid:"3",name:"Owner",email:"PRIVATE"}}],next_page:null}
    :url.includes("/stories")?{data:{gid:"9",text:"Hi",created_by:{gid:"3",name:"Owner",photo:"PRIVATE"},extra:"PRIVATE"}}
    :{data:{gid:"12",resource_type:"task",name:"Task",projects:[{gid:"2",name:"P",team:"PRIVATE"}],custom_fields:"PRIVATE"}})) as unknown as typeof fetch;
  const outputs=[await runManagedAsanaAction("get_task",{auth,task:"12"},request),
    await runManagedAsanaAction("list_project_tasks",{auth,project:"2"},request),
    await runManagedAsanaAction("add_task_comment",{auth,task:"12",text:"Hi"},request)];
  expect(outputs).toEqual([{gid:"12",resource_type:"task",name:"Task",projects:[{gid:"2",name:"P"}]},
    {data:[{gid:"12",name:"Task",assignee:{gid:"3",name:"Owner"}}],next_offset:null},
    {gid:"9",text:"Hi",created_by:{gid:"3",name:"Owner"}}]);
  expect(JSON.stringify(outputs)).not.toContain("PRIVATE");
});
test("gids are opaque strings, encoded into fixed paths",async()=>{
  const calls:URL[]=[];
  const request=(async(url:string)=>{calls.push(new URL(url));return Response.json({data:{gid:"task_ab-1",name:"Task"}});}) as unknown as typeof fetch;
  expect(await runManagedAsanaAction("get_task",{auth,task:"task_ab-1"},request)).toEqual({gid:"task_ab-1",name:"Task"});
  await runManagedAsanaAction("get_task",{auth,task:"a/b?c"},request);
  expect(calls[1]!.pathname).toBe("/api/1.0/tasks/a%2Fb%3Fc");
  expect(calls[1]!.searchParams.get("opt_fields")).toBe(ASANA_TASK_FIELDS);
  for(const task of ["","1".repeat(65),"1\n2",".",".."])await expect(runManagedAsanaAction("get_task",{auth,task},request)).rejects.toThrow();
  expect(calls).toHaveLength(2);
  await expect(runManagedAsanaAction("get_task",{auth,task:"1"},(async()=>Response.json({data:{gid:"bad\u0000"}})) as unknown as typeof fetch)).rejects.toThrow("invalid resource");
});
