import {expect,test} from 'bun:test';
import {validateSupportRoutingFixtures} from './support-routing-fixtures';
import {supportRoutingGraph,supportRoutingCases,supportRoutingFixtureSetup,savedSupportRoutingGraph,savedSupportRoutingSetup,savedSupportRoutingCases,rejectedSupportRoutingCases,objectSupportRoutingGraph,objectSupportRoutingSetup,objectSupportRoutingCases} from './support-routing-test-data';
import {submissionConfig,prepareSubmission} from './form-submission';
import {compileWorkflow} from './workflow-readiness';
import {tracksPieceCompletion,resolveGovernedPieceAction} from './piece-effects';

test('request-ID-only admission preserves strict form validation and rejects unsafe or mixed setup',()=>{
  expect(submissionConfig({request_id_field:'body.id'})).toEqual({idField:'body.id'});
  expect(prepareSubmission({body:{id:' a '}},{idField:'body.id'}).data).toEqual({body:{id:'a'}});
  expect(submissionConfig({request_id_field:''},true)).toBeUndefined();
  for(const path of ['',null,'__proto__.id','_webhook.id','body[0]'])expect(()=>submissionConfig({request_id_field:path})).toThrow();
  expect(()=>submissionConfig({request_id_field:'id',submission_email_field:'email'})).toThrow();
  expect(()=>submissionConfig({submission_id_field:'id'})).toThrow();
  expect(()=>prepareSubmission({id:'a',email:'invalid'},{idField:'id',emailField:'email'})).toThrow();
  expect(()=>prepareSubmission({},{idField:'id'})).toThrow();
});
test('deferred request mapping is setup, not structural failure',()=>{
  const g={name:'trigger',type:'PIECE_TRIGGER',settings:{pieceName:'webhook',input:{request_id_field:''}}};
  expect(compileWorkflow(g,{phase:'composition'}).ready).toBe(true);
  expect(compileWorkflow(g,{phase:'activation'}).ready).toBe(false);
  g.settings.input.request_id_field='id';
  expect(compileWorkflow(g,{phase:'activation'}).ready).toBe(true);
});
test('actual graph fixtures cover strict routing, duplicates and uncertain creation without modifying saved setup',async()=>{
  const g=supportRoutingGraph(false),before=JSON.stringify(g);
  const report=await validateSupportRoutingFixtures(g,{setup:supportRoutingFixtureSetup(),cases:supportRoutingCases()});
  expect(report.cases).toHaveLength(13);expect(report.externalActions).toBe(0);expect(JSON.stringify(g)).toBe(before);
});
test('fixture expectations catch urgent billing double dispatch and truthy invalid urgency',async()=>{
  const g=supportRoutingGraph();g.nextAction.children[1].nextAction=structuredClone(g.nextAction.children[2]);g.nextAction.children[1].nextAction.name='duplicate';
  await expect(validateSupportRoutingFixtures(g,{cases:supportRoutingCases()})).rejects.toThrow('unexpected executed');
  const truthy=supportRoutingGraph();truthy.nextAction.settings.branches.splice(0,1);truthy.nextAction.children.splice(0,1);
  truthy.nextAction.settings.branches[0].conditions[0][0].firstValue='{{trigger.urgent}}';
  await expect(validateSupportRoutingFixtures(truthy,{cases:[supportRoutingCases()[5]]})).rejects.toThrow();
});
test('fixture refuses graph mutation through setup and unsupported actions',async()=>{
  await expect(validateSupportRoutingFixtures(supportRoutingGraph(),{setup:{trigger:{request_id_field:'invented'}},cases:supportRoutingCases()})).rejects.toThrow('only empty');
  const g=supportRoutingGraph();g.nextAction.children[0].settings.actionName='delete_task';
  await expect(validateSupportRoutingFixtures(g,{cases:supportRoutingCases()})).rejects.toThrow('unsupported action');
});
test('exact saved draft with omitted auth validates without account setup or graph repair',async()=>{
  const g=savedSupportRoutingGraph(),before=JSON.stringify(g);
  const fixture={setup:savedSupportRoutingSetup(),cases:[...savedSupportRoutingCases(),...rejectedSupportRoutingCases()]};
  const report=await validateSupportRoutingFixtures(g,fixture);
  expect(report.cases).toHaveLength(18);expect(report.externalActions).toBe(0);
  expect(report.cases.slice(-5).every(c=>c.rejectedDeliveries===2 && c.tasks===0)).toBe(true);
  expect(JSON.stringify(g)).toBe(before);
  for(const n of g.nextAction.children)expect(Object.hasOwn(n.settings.input,'auth')).toBe(false);
  // Older callers may still supply mock auth explicitly on the omitted field.
  for(const values of Object.values(fixture.setup) as any[])if('list_id' in values)values.auth='synthetic-only';
  expect((await validateSupportRoutingFixtures(g,fixture)).passed).toBe(true);
  expect(JSON.stringify(g)).toBe(before);
});
test('null and configured auth are mocked without resolving credentials; unsupported overrides still fail',async()=>{
  for(const auth of [null,'{{connections.nonexistent}}','{{missing.account}}']){
    const g=supportRoutingGraph();for(const n of g.nextAction.children)n.settings.input.auth=auth;
    expect((await validateSupportRoutingFixtures(g,{cases:supportRoutingCases()})).passed).toBe(true);
  }
  const g=savedSupportRoutingGraph();
  await expect(validateSupportRoutingFixtures(g,{setup:{step_1:{invented:'unsafe'}},cases:savedSupportRoutingCases()})).rejects.toThrow('only empty');
  await expect(validateSupportRoutingFixtures(g,{setup:{step_2:{priority_id:1}},cases:savedSupportRoutingCases()})).rejects.toThrow('only empty');
  await expect(validateSupportRoutingFixtures(supportRoutingGraph(),{setup:{urgent:{auth:'replacement'}},cases:supportRoutingCases()})).rejects.toThrow('only empty');
});
test('invalid-ID fixtures must declare expected rejection and cannot hide action failures',async()=>{
  await expect(validateSupportRoutingFixtures(supportRoutingGraph(),{cases:[{...rejectedSupportRoutingCases()[0],expectedRejection:false}]})).rejects.toThrow('ID');
  await expect(validateSupportRoutingFixtures(supportRoutingGraph(),{cases:[{...supportRoutingCases()[0],expectedRejection:true}]})).rejects.toThrow('rejection mismatch');
  const g=supportRoutingGraph();g.nextAction.children[1].settings.input.list_id=null;
  await expect(validateSupportRoutingFixtures(g,{cases:[{...supportRoutingCases()[0],expectedRejection:true}]})).rejects.toThrow('fixture setup missing');
});
test('only inspected ClickUp task actions acquire completion receipts',()=>{
  for(const action of ['create_task','clickup_create_task']){
    expect(tracksPieceCompletion('@activepieces/piece-clickup',action)).toBe(true);
    expect(resolveGovernedPieceAction('@activepieces/piece-clickup',action)?.category).toBe('write_data');
  }
  expect(tracksPieceCompletion('@activepieces/piece-clickup','delete_task')).toBe(false);
});

test('second actual saved draft serializes entire webhook objects and accepts the declared priority choice',async()=>{
  const g=objectSupportRoutingGraph(),before=JSON.stringify(g);
  const report=await validateSupportRoutingFixtures(g,{setup:objectSupportRoutingSetup(),cases:[...objectSupportRoutingCases(),...rejectedSupportRoutingCases()]});
  expect(report.cases).toHaveLength(20);expect(report.passed).toBe(true);expect(report.externalActions).toBe(0);
  expect(JSON.stringify(g)).toBe(before);
  g.nextAction.children[1].settings.input.priority_id='3';
  await expect(validateSupportRoutingFixtures(g,{setup:objectSupportRoutingSetup(),cases:[objectSupportRoutingCases()[0]]})).rejects.toThrow('wrong priority');
});
test('fixture text interpolation matches engine JSON, multiple-token and absent-value semantics',async()=>{
  const g=supportRoutingGraph(),input=g.nextAction.children[1].settings.input;
  const c={...supportRoutingCases()[0]!,payload:{id:'request-1',title:'Example',urgent:true,category:'billing',details:{items:[1,'a'],flag:false}}};
  input.description='{{trigger.title}} / {{trigger.details}} / {{trigger.details.items}} / {{trigger.missing ?? null}} / {{trigger.urgent}}';
  expect((await validateSupportRoutingFixtures(g,{cases:[{...c,expectedDescription:'Example / {"items":[1,"a"],"flag":false} / [1,"a"] /  / true'}]})).passed).toBe(true);
  input.description='Missing: {{trigger.missing}}';
  await expect(validateSupportRoutingFixtures(g,{cases:[c]})).rejects.toThrow('absent value');
  input.description='{{trigger.missing}}';
  await expect(validateSupportRoutingFixtures(g,{cases:[c]})).rejects.toThrow('absent value');
  input.description='{{trigger}}';
  expect((await validateSupportRoutingFixtures(g,{cases:[{...c,expectedDescription:JSON.stringify(c.payload)}]})).passed).toBe(true);
  await expect(validateSupportRoutingFixtures(g,{cases:[{...c,expectedDescription:'[object Object]'}]})).rejects.toThrow('wrong task description');
  input.description='Items: {{flattenNestedKeys(trigger.details, ["items"])}}';
  await expect(validateSupportRoutingFixtures(g,{cases:[c]})).rejects.toThrow('require the engine fixture suite');
});
