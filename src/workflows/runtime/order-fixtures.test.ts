import {expect,test} from 'bun:test';
import {validateJsonMappingFixtures} from './json-mapping-fixtures';
import {orderGraph,repairedOrderGraph,orderSetup,orderCases} from './order-fixture-data';

test('captured order expression fails typed-row validation before any append',async()=>{
  const graph=repairedOrderGraph();graph.nextAction.nextAction.settings.input.query=orderGraph().nextAction.settings.input.query;
  await expect(validateJsonMappingFixtures(graph,{setup:orderSetup(),cases:[orderCases()[0]]})).rejects.toThrow('values must be a typed 2D array');
});
test('saved order graph tests two independent row sets, admission and each partial outcome',async()=>{
  const graph=repairedOrderGraph(),before=JSON.stringify(graph);
  const report=await validateJsonMappingFixtures(graph,{setup:orderSetup(),cases:orderCases()});
  expect(report.cases).toHaveLength(26);expect(report.externalActions).toBe(0);expect(JSON.stringify(graph)).toBe(before);
  expect(report.cases[0].requests.map((r:any)=>r.range)).toEqual(["'Orders'!A:C","'Lines'!A:C"]);
});
test('one column remains a row; setup must include ID in both tabs',async()=>{
  const setup=orderSetup();setup.order_mapping.json.orderColumns=[{source:'order_id'}];setup.order_mapping.json.lineColumns=[{source:'order_id'}];
  const c={...orderCases()[1],expectedRows:[['order-1'],['order-1']],expectedRowsByStep:{step_2:[['order-1']],step_3:[['order-1']]}};
  expect((await validateJsonMappingFixtures(repairedOrderGraph(),{setup,cases:[c]})).passed).toBe(true);
  setup.order_mapping.json.lineColumns=[{source:'item',path:'sku'}];
  expect((await validateJsonMappingFixtures(repairedOrderGraph(),{setup,cases:[{...c,expectedRows:[],expectedRowsByStep:{step_2:[],step_3:[]},expectedRequests:0,assertions:[{step:'step_1',path:['status'],equals:'setup_required'}]}]})).passed).toBe(true);
});
test('fixtures detect duplicate writes, per-tab mistakes and absent admission setup',async()=>{
  const c=orderCases()[0];
  await expect(validateJsonMappingFixtures(repairedOrderGraph(),{setup:orderSetup(),cases:[{...c,expectedRowsByStep:{step_2:c.expectedRows}}]})).rejects.toThrow('rows differ for step_2');
  await expect(validateJsonMappingFixtures(repairedOrderGraph(),{setup:orderSetup(),cases:[{...c,deliveries:3,expectedDuplicateDeliveries:0}]})).rejects.toThrow('duplicate delivery');
  const setup=orderSetup();delete (setup as any).trigger;
  await expect(validateJsonMappingFixtures(repairedOrderGraph(),{setup,cases:[c]})).rejects.toThrow('Request ID requires');
  const graph=repairedOrderGraph();graph.settings.input.secret='unsupported';
  await expect(validateJsonMappingFixtures(graph,{setup:orderSetup(),cases:[c]})).rejects.toThrow('requires a plain or request-ID-only');
});
