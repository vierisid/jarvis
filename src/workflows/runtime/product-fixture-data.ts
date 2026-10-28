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
