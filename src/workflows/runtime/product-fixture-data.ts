import repaired from './fixtures/product-repaired-test17.json';
import graph from './fixtures/product-generated-test17.json';
export const productGraph = () => structuredClone(graph) as any;
export const productSetup = () => ({
  step_1: {text: JSON.stringify({pricePath:'price',stockPath:'stock',activePath:'active'})},
  step_3: {spreadsheet_id:'fixture-sheet',worksheet_title:'Fixture',range:'A:C',values:'{{[[step_2.product.price, step_2.product.stock, step_2.product.active]]}}'},
});
export function productCases() {
  const valid = {price:0,stock:0,active:false};
  const cases: any[] = [
    {name:'zero and false',payload:valid,expectedRows:[[0,0,false]],expectedStatus:'SUCCEEDED',expectedRequests:1},
    {name:'ordinary values',payload:{price:12.5,stock:8,active:true},expectedRows:[[12.5,8,true]],expectedStatus:'SUCCEEDED',expectedRequests:1},
  ];
  for (const field of ['price','stock','active']) for (const [label,value] of [['missing',undefined],['null',null],['empty','']] as const) {
    const payload: any = {...valid}; if (value === undefined) delete payload[field]; else payload[field] = value;
    cases.push({name:field+' '+label,payload,expectedRows:[],expectedStatus:'REJECTED',expectedRequests:0,
      expectedStates:{price:'present',stock:'present',active:'present',[field]:label}});
  }
  for (const field of ['price','stock']) for (const value of ['0','garbage','NaN','Infinity',true,[],{}]) {
    cases.push({name:field+' invalid '+JSON.stringify(value),payload:{...valid,[field]:value},expectedRows:[],expectedStatus:'REJECTED',expectedRequests:0});
  }
  cases.push({name:'string false is invalid',payload:{...valid,active:'false'},expectedRows:[],expectedStatus:'REJECTED',expectedRequests:0});
  cases.push({name:'Sheets explicit failure',payload:valid,sheetsOutcome:'failure',expectedRows:[],expectedStatus:'FAILED',expectedRequests:1,expectedError:'rejected append'});
  cases.push({name:'Sheets lost response',payload:valid,sheetsOutcome:'uncertain',expectedRows:[[0,0,false]],expectedStatus:'UNCERTAIN',expectedRequests:1});
  return cases;
}

export const repairedProductGraph=()=>structuredClone(repaired) as any;
export const repairedProductCases=()=>[...productCases(),
 {name:'negative price allowed without a configured minimum',payload:{price:-2.5,stock:0,active:false},expectedRows:[[-2.5,0,false]],expectedStatus:'SUCCEEDED',expectedRequests:1},
 {name:'fractional stock allowed without an integer rule',payload:{price:0,stock:1.5,active:false},expectedRows:[[0,1.5,false]],expectedStatus:'SUCCEEDED',expectedRequests:1},
 {name:'negative stock allowed without a configured minimum',payload:{price:0,stock:-1,active:false},expectedRows:[[0,-1,false]],expectedStatus:'SUCCEEDED',expectedRequests:1},
];

// Engine property processors run before an action: JSON props parse strings
// and must end as an object or array, text props must be strings.
export const typedInputGraph=(action:'run_jsonata_query'|'convert_json_to_text',result:unknown={out:'{{step_1}}'}):any=>({name:'trigger',type:'PIECE_TRIGGER',displayName:'Webhook',settings:{pieceName:'webhook',input:{}},
 nextAction:{name:'step_1',type:'PIECE',displayName:'Transform',settings:{pieceName:'@activepieces/piece-json',actionName:action,input:action==='run_jsonata_query'?{json:'{{trigger.data}}',query:'$'}:{json:'{{trigger.data}}'}},
  nextAction:{name:'step_2',type:'PIECE',displayName:'Return',settings:{pieceName:'@jarvispieces/piece-jarvis-subflow',actionName:'return_result',input:{result}}}}});
export const typedInputCases=()=>[
 {name:'object passes',payload:{data:{a:1}},expectedRows:[],expectedStatus:'SUCCEEDED',assertions:[{step:'step_2',path:['out'],equals:{a:1}}]},
 {name:'JSON string is parsed',payload:{data:'{"a":1}'},expectedRows:[],expectedStatus:'SUCCEEDED',assertions:[{step:'step_2',path:['out'],equals:{a:1}}]},
 ...[5,true,null,'abc'].map(data=>({name:'scalar '+JSON.stringify(data)+' is not JSON',payload:{data},expectedRows:[],expectedStatus:'FAILED',expectedError:'expected JSON object or array'})),
];
