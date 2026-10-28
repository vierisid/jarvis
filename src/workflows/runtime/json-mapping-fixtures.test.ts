import {expect,test} from 'bun:test';
import {validateJsonMappingFixtures} from './json-mapping-fixtures';
import {productGraph,productSetup,productCases,repairedProductGraph,repairedProductCases} from './product-fixture-data';
import {productRetestGraph,repairedProductRetestGraph,productRetestSetup,productRetestCases} from './product-retest-data';

test('actual saved product graph preserves types and distinguishes field states', async () => {
  const graph=productGraph(), before=JSON.stringify(graph);
  const report=await validateJsonMappingFixtures(graph,{setup:productSetup(),cases:productCases()});
  expect(report.cases).toHaveLength(28);expect(report.externalActions).toBe(0);
  expect(report.cases[0].requests[0].requestBody.values).toEqual([[0,0,false]]);
  expect(JSON.stringify(graph)).toBe(before);
},20_000);
test('fixtures detect lost false values, stringified rows and invalid routing', async () => {
  for(const mapping of ['{{[[step_2.product.price || 1, step_2.product.stock, step_2.product.active]]}}', '{{[[step_2.product.price, step_2.product.stock, "false"]]}}']){
    const setup=productSetup();setup.step_3.values=mapping;
    await expect(validateJsonMappingFixtures(productGraph(),{setup,cases:[productCases()[0]]})).rejects.toThrow('typed row values differ');
  }
  const graph=productGraph();graph.nextAction.nextAction.nextAction.settings.branches[0].conditions[0][0].firstValue='{{true}}';
  await expect(validateJsonMappingFixtures(graph,{setup:productSetup(),cases:[productCases()[3]]})).rejects.toThrow();
});
test('setup cannot rewrite expressions, hidden actions or retry policies', async () => {
  await expect(validateJsonMappingFixtures(productGraph(),{setup:{step_2:{query:'true'}},cases:[productCases()[0]]})).rejects.toThrow('only empty');
  const graph=productGraph();graph.nextAction.nextAction.settings.actionName='custom_api_call';
  await expect(validateJsonMappingFixtures(graph,{cases:[productCases()[0]]})).rejects.toThrow('unsupported action');
  const retry=productGraph();retry.nextAction.settings.errorHandlingOptions={retryOnFailure:{value:true}};
  await expect(validateJsonMappingFixtures(retry,{cases:[productCases()[0]]})).rejects.toThrow('retry');
});
test('configured credentials never resolve; nested mapping and destination quoting retain types',async()=>{
  const graph=productGraph();graph.nextAction.nextAction.nextAction.children[0].settings.input.auth='{{connections.must_not_be_read}}';
  const setup=productSetup();setup.step_1.text=JSON.stringify({pricePath:'product.price',stockPath:'product.stock',activePath:'product.active'});setup.step_3.worksheet_title="Customer's products";
  const c=productCases()[0];c.payload={product:c.payload};
  const report=await validateJsonMappingFixtures(graph,{setup,cases:[c]});
  expect(report.cases[0].requests[0].range).toBe("'Customer''s products'!A:C");
});

test('domain restrictions are explicit optional configuration, not invented defaults',async()=>{
 const cases=repairedProductCases();
 expect((await validateJsonMappingFixtures(repairedProductGraph(),{setup:productSetup(),cases})).cases).toHaveLength(31);
 const setup=productSetup();setup.step_1.text=JSON.stringify({pricePath:'price',stockPath:'stock',activePath:'active',priceMinimum:0,stockMinimum:0,requireIntegerStock:true});
 const limited=cases.slice(-3).map(c=>({...c,expectedRows:[],expectedStatus:'REJECTED',expectedRequests:0}));
 expect((await validateJsonMappingFixtures(repairedProductGraph(),{setup,cases:limited})).cases).toHaveLength(3);
});
test('malformed JSONata and mapping fail explicitly rather than reporting rejection or success',async()=>{
 const graph=productGraph();graph.nextAction.nextAction.settings.input.query='invalid (';
 const c={...productCases()[0],expectedRows:[],expectedStatus:'FAILED',expectedRequests:0,expectedError:'JSONata Execution Failed'};
 expect((await validateJsonMappingFixtures(graph,{setup:productSetup(),cases:[c]})).cases[0].status).toBe('FAILED');
 const setup=productSetup();setup.step_1.text='not json';
 expect((await validateJsonMappingFixtures(productGraph(),{setup,cases:[{...c,expectedError:'JSON'}]})).cases[0].status).toBe('FAILED');
});

test('actual retest catches singleton flattening before any mocked append',async()=>{
 await expect(validateJsonMappingFixtures(productRetestGraph(),{setup:productRetestSetup(),cases:[productRetestCases()[0]]})).rejects.toThrow('values must be a typed 2D array');
});
test('repaired retest graph supports numeric routing and typed batch/state assertions',async()=>{
 const graph=repairedProductRetestGraph(),before=JSON.stringify(graph);
 const report=await validateJsonMappingFixtures(graph,{setup:productRetestSetup(),cases:productRetestCases()});
 expect(report.cases).toHaveLength(39);expect(report.externalActions).toBe(0);expect(JSON.stringify(graph)).toBe(before);
});

test('structured assertions cannot pass wrong counts, states or missing paths',async()=>{
 for(const assertion of [{step:'step_2',path:['validCount'],equals:2},{step:'step_2',path:['records',0,'fields',0,'state'],equals:'missing'},{step:'step_2',path:['absent'],equals:0}]){
   const c={...productRetestCases()[0],assertions:[assertion]};
   await expect(validateJsonMappingFixtures(repairedProductRetestGraph(),{setup:productRetestSetup(),cases:[c]})).rejects.toThrow('assert');
 }
});
test('explicit required/null/empty policies reject all nine distinct absent-value cases',async()=>{
 const setup=productRetestSetup();for(const f of setup.step_1.json.fields){f.required=true;f.allowNull=false;f.allowEmpty=false;}
 const cases=productRetestCases().slice(1,10).map(c=>({...c,expectedRows:[],expectedRequests:0,assertions:[...c.assertions,{step:'step_2',path:['invalidCount'],equals:1}]}));
 expect((await validateJsonMappingFixtures(repairedProductRetestGraph(),{setup,cases})).cases).toHaveLength(9);
});
test('numeric comparisons and lazy guarded operands follow production routing',async()=>{
 for(const [operator,secondValue] of [['NUMBER_IS_GREATER_THAN','0'],['NUMBER_IS_LESS_THAN',2],['NUMBER_IS_EQUAL_TO','1']]){
   const graph=repairedProductRetestGraph();graph.nextAction.nextAction.nextAction.settings.branches[0].conditions[0][1]={firstValue:'{{step_2.validCount}}',operator,secondValue};
   expect((await validateJsonMappingFixtures(graph,{setup:productRetestSetup(),cases:[productRetestCases()[0]]})).cases[0].requests).toHaveLength(1);
 }
 const graph=repairedProductRetestGraph();
 graph.nextAction.nextAction.nextAction.settings.branches[0].conditions=[[{operator:'NUMBER_IS_EQUAL_TO',firstValue:0,secondValue:'1'},{operator:'NUMBER_IS_GREATER_THAN',firstValue:'{{step_2.absent}}',secondValue:'0'}]];
 expect((await validateJsonMappingFixtures(graph,{setup:productRetestSetup(),cases:[{...productRetestCases()[0],expectedRows:[],expectedRequests:0}]})).cases[0].requests).toHaveLength(0);
 graph.nextAction.nextAction.nextAction.settings.branches[0].conditions[0][0].operator='UNKNOWN';
 await expect(validateJsonMappingFixtures(graph,{setup:productRetestSetup(),cases:[productRetestCases()[0]]})).rejects.toThrow('unsupported condition UNKNOWN');
});
