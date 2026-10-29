import {afterEach,expect,test} from 'bun:test';
import graph from './fixtures/month-close-generated.json';
import {validateScheduleFixtures} from './schedule-fixtures';
import {scheduleTriggerPayload} from './schedule-payload';
import {setCronTimezone} from '../../lib/cron-scheduler';
import {initWorkflowDb,closeWorkflowDb} from '../db';
import {createFlow,getFlow} from '../db/repos/flow';
import {createDraftVersion,getFlowVersion} from '../db/repos/flow-version';
import {createManageWorkflowTool} from '../../actions/tools/manage-workflow';
import {PieceCatalog} from './piece-catalog';
afterEach(()=>{closeWorkflowDb();setCronTimezone(null);});
const sample=(date:string,match=true,extra:any={})=>({name:date,scheduledFor:date,executedAt:date,expectedMatch:match,...extra});
const cases=[
 sample('2023-02-28T16:00:00Z',true,{expectedKey:'month-close:Europe/Rome:2023-02'}),
 sample('2024-02-29T16:00:00Z',true,{executedAt:'2024-03-01T09:00:00Z',expectedKey:'month-close:Europe/Rome:2024-02'}),
 sample('2027-02-26T16:00:00Z',true,{executedAt:'2027-02-27T00:05:00Z',expectedKey:'month-close:Europe/Rome:2027-02'}),
 sample('2024-08-29T15:00:00Z',false,{executedAt:'2024-08-30T00:05:00Z'}),
 sample('2024-08-30T15:00:00Z'),sample('2024-08-31T15:00:00Z',false),
 sample('2024-03-29T16:00:00Z'),sample('2024-03-31T15:00:00Z',false),
 sample('2026-10-30T16:00:00Z'),sample('2026-12-31T16:00:00Z',true,{executedAt:'2027-01-03T09:00:00Z',expectedKey:'month-close:Europe/Rome:2026-12'}),
 sample('2027-02-26T16:00:00Z',true,{notificationOutcome:'failure'}),
 sample('2027-02-26T16:00:00Z',true,{notificationOutcome:'uncertain'}),
];
test('saved graph calendar, delayed evaluation and failed/uncertain transport fixtures',async()=>{
 const before=JSON.stringify(graph),result=await validateScheduleFixtures(graph,{cases});
 expect(result.passed).toBe(true);expect(result.cases).toHaveLength(12);expect(result.externalActions).toBe(0);
 expect(result.cases.slice(-2).map((c:any)=>c.status)).toEqual(['FAILED','UNCERTAIN']);
 expect(JSON.stringify(graph)).toBe(before);
});
test('public tool tests the saved definition and leaves IDs, status and graph unchanged',async()=>{
 initWorkflowDb(':memory:');const flow=createFlow();const version=createDraftVersion({flowId:flow.id,displayName:'Month end',trigger:graph as any});
 const catalog=new PieceCatalog([{name:'@jarvispieces/piece-jarvis-notify',displayName:'Notify',description:'',actions:{notify:{name:'notify',displayName:'Notify',description:''}}}]);
 const tool=createManageWorkflowTool({pieceRegistry:catalog});
 const raw=String(await tool.execute({action:'validate_fixtures',flow:flow.id,fixture_input:{cases:[cases[1]]}}));
 expect(raw).toContain('"passed":true');expect(raw).toContain(version.id);
 expect(getFlow(flow.id)).toMatchObject({status:'DISABLED',published_version_id:null});expect(getFlowVersion(version.id)?.trigger).toEqual(graph);
});
test('occurrence metadata uses calendar timezone even when UTC is another month',()=>{
 setCronTimezone('UTC');
 const at=Date.parse('2026-12-31T23:30:00Z');
 expect(scheduleTriggerPayload({timezone:'Asia/Tokyo'},undefined,at)).toMatchObject({scheduledFor:'2026-12-31T23:30:00.000Z',scheduledDate:'2027-01-01',scheduledMonth:'2027-01'});
 const shifted={at:Date.parse('2026-03-08T07:00:00Z'),key:'2026-03-08T02:30',lateMs:0,shifted:true as const};
 expect(scheduleTriggerPayload({timezone:'America/New_York'},shifted)).toMatchObject({occurrenceKey:'2026-03-08T02:30',scheduledDate:'2026-03-08'});
});
test('uncovered shapes, invalid times and real channels are refused',async()=>{
 await expect(validateScheduleFixtures({...graph,nextAction:{...graph.nextAction,nextAction:graph.nextAction}},{cases})).rejects.toThrow('only schedule');
 await expect(validateScheduleFixtures(graph,{cases:[sample('2027-02-26T16:00:01Z')]})).rejects.toThrow('whole minute');
 const other=structuredClone(graph);other.nextAction.settings.input.channels=['telegram'];
 await expect(validateScheduleFixtures(other,{cases:[cases[0]]})).rejects.toThrow('dashboard');
});
