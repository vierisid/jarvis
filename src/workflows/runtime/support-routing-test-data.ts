/** Synthetic data only, shared by component and real-engine qualification. */
import savedDraft from './support-routing-saved-draft.fixture.json';
import objectDraft from './support-routing-object-draft.fixture.json';

/** Exact unconfigured graph produced during the user retest; no credentials. */
export const savedSupportRoutingGraph = (): any => structuredClone(savedDraft);
export const objectSupportRoutingGraph = (): any => structuredClone(objectDraft);
export function objectSupportRoutingSetup() {
  const setup = savedSupportRoutingSetup();
  for(const name of ['step_1','step_2','step_3','step_4']){
    delete setup[name].name;delete setup[name].description;
  }
  return setup;
}
export function objectSupportRoutingCases() {
  const cases = savedSupportRoutingCases();
  return [...cases,...[{},['billing']].map((category,i)=>({
    ...cases[2]!,name:'structured category '+i,payload:{...cases[2]!.payload,category},expectedSteps:['step_4'],expectedTaskCount:1,
  }))].map(c=>({...c,expectedDescription:(c.expectedSteps[0]==='step_1'?'Urgency is missing or is not a boolean. ':'')+'Original request: '+JSON.stringify(c.payload)}));
}
export function savedSupportRoutingSetup() {
  return Object.fromEntries([['trigger',{request_id_field:'id'}], ...['step_1','step_2','step_3','step_4'].map(n => [n, {
    workspace_id:'fixture-workspace',space_id:'fixture-space',list_id:n,name:'{{trigger.title}}',description:'{{trigger.description ?? ""}}',custom_fields:{},
  }])]);
}
export function savedSupportRoutingCases() {
  const names: Record<string,string> = {review:'step_1',urgent:'step_2',billing:'step_3',general:'step_4'};
  return supportRoutingCases().map(c => ({...c,expectedSteps:c.expectedSteps.map(n => names[n]!)}));
}
export function rejectedSupportRoutingCases() {
  return [undefined,null,'   ',{},true].map((id,i) => ({name:'invalid request ID '+i,payload:{id,urgent:true,category:'billing'},expectedSteps:[],expectedTaskCount:0,expectedRejection:true,deliveries:2}));
}
export function supportRoutingGraph(configured = true): any {
  const task = (name: string, priority = 3) => ({name,type:'PIECE',settings:{pieceName:'@activepieces/piece-clickup',pieceVersion:'0.9.1',actionName:'create_task',input:{auth:configured?'{{connections.fixture-clickup}}':null,workspace_id:configured?'fixture-workspace':null,space_id:configured?'fixture-space':null,list_id:configured?name:null,name:'{{trigger.title}}',description:'{{trigger.description ?? ""}}',priority_id:priority,custom_fields:configured?{}:null}}});
  const branch = (branchName: string, expression: string) => ({branchName,branchType:'CONDITION',conditions:[[{firstValue:'{{'+expression+'}}',operator:'BOOLEAN_IS_TRUE'}]]});
  return {name:'trigger',type:'PIECE_TRIGGER',settings:{pieceName:'webhook',input:{request_id_field:configured?'id':''}},nextAction:{name:'route',type:'ROUTER',settings:{executionType:'EXECUTE_FIRST_MATCH',branches:[
    branch('Needs review','typeof (trigger.urgent ?? null) !== "boolean"'),
    branch('Urgent','(trigger.urgent ?? null) === true'),
    branch('Billing','(trigger.category ?? null) === "billing"'),
    {branchName:'General support',branchType:'FALLBACK'},
  ]},children:[task('review'),task('urgent',2),task('billing'),task('general')]}};
}
export function supportRoutingCases() {
  const payload = {id:'request-1',title:'Synthetic support request',description:'Fixture only'};
  const c = (name:string, urgent:unknown, category:string, step:string, extra: {expectedPriority?:number;deliveries?:number;loseReply?:boolean} = {}) => ({name,payload:{...payload,urgent,category},expectedSteps:[step],expectedTaskCount:1,...extra});
  return [
    c('urgent billing creates only one high-priority task',true,'billing','urgent',{expectedPriority:2}),
    c('non-urgent billing',false,'billing','billing'),
    c('general support',false,'technical','general'),
    ...[undefined,null,'false','true',0,1,{},[]].map((v,i)=>c('invalid urgency '+i,v,'billing','review')),
    c('concurrent repeated delivery',true,'billing','urgent',{deliveries:8,expectedPriority:2}),
    c('uncertain create is not repeated',true,'billing','urgent',{deliveries:4,loseReply:true}),
  ];
}
export function supportRoutingFixtureSetup() {
  return Object.fromEntries([['trigger',{request_id_field:'id'}],...['review','urgent','billing','general'].map(n=>[n,{auth:'synthetic-fixture-only',workspace_id:'fixture-workspace',space_id:'fixture-space',list_id:n,custom_fields:{}}])]);
}
