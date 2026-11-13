import {expect,test} from 'bun:test';
import {boundedJson,childCallInput,childFailureMessage,normalizeCustomer,CUSTOMER_SCHEMA,completedChild,requireChildSuccess} from './subflow-contract';
import {childNameShown} from './subflow-service';
import {validateSubflowFixtures} from './subflow-fixtures';
import {childTestGraph,parentTestGraph} from './subflow-test-data';
test('actual graph components validate success, invalid output, failure, timeout and replay',async()=>{const report=await validateSubflowFixtures(parentTestGraph('saved-child'),childTestGraph());expect(report.cases).toHaveLength(5);expect(report.cases.every(c=>c.passed)).toBe(true);expect(report.externalActions).toBe(0);});
test('invalid customer is structured validation data, never an invented success',()=>{expect(normalizeCustomer({customer:{id:' ',name:'Test',email:'broken'},idPath:'id',namePath:'name',emailPath:'email'})).toMatchObject({valid:false,issues:['id is required','email is invalid']});});
test('unsupported schemas, missing keys and unbounded deadlines fail closed',()=>{const input={flow:'child',invocationKey:'request',payload:{},outputSchema:CUSTOMER_SCHEMA,timeoutSeconds:60};for(const change of [{invocationKey:''},{timeoutSeconds:0},{timeoutSeconds:86401},{outputSchema:{type:'object',unknown:true}},{payload:[]}])expect(()=>childCallInput({...input,...change})).toThrow();expect(()=>boundedJson('x'.repeat(33000))).toThrow();});
test('child completion is not enough without a valid explicit result',()=>{expect(completedChild('run','SUCCEEDED',{present:false},CUSTOMER_SCHEMA).status).toBe('invalid_output');expect(completedChild('run','SUCCEEDED',{present:true,value:{valid:true}},CUSTOMER_SCHEMA).status).toBe('invalid_output');expect(()=>requireChildSuccess({status:'failed',runId:'run'})).toThrow('failed');});
test('fixture runner refuses extra or swallowed graph behavior',async()=>{const p=parentTestGraph('child');p.nextAction.nextAction.nextAction={name:'surprise'};await expect(validateSubflowFixtures(p,childTestGraph())).rejects.toThrow('additional graph');});
test('a child name cannot forge or reorder its failure message',()=>{
 expect(childNameShown('Customer checker')).toBe('"Customer checker"');
 // A quote and a line break cannot close the name and add a sentence of their own.
 const forged=childNameShown('X" succeeded.\nReason: safe');expect(forged).toBe('"X\\" succeeded. Reason: safe"');
 // Bidi overrides are dropped and right-to-left text is isolated inside its quotes.
 const rtl=childNameShown('\u202Eabc \u05D0\u05D1');expect(rtl).toBe('"\u2068abc \u05D0\u05D1\u2069"');
 // A long name is cut with a visible mark.
 const long=childNameShown('n'.repeat(2000));expect(long.length).toBeLessThan(530);expect(long.endsWith('..."')).toBe(true);
});
test('each failed child outcome is explained in plain words, with no codes',()=>{
 const run='child-run',name=childNameShown('Checker');
 const cases:[Parameters<typeof childFailureMessage>[0],string][]=[[{status:'failed',runId:run,code:'CHILD_FAILED'},'failed. Open its latest run'],[{status:'invalid_output',runId:run,code:'CHILD_RESULT_MISSING'},'finished but did not send back a result'],
  [{status:'invalid_output',runId:run,code:'CHILD_RESULT_INVALID'},'sent back a result in a different shape'],[{status:'timeout',runId:run,code:'CHILD_DEADLINE_EXCEEDED'},'did not finish within 60 seconds'],[{status:'uncertain',runId:run,code:'CHILD_OUTCOME_UNCERTAIN'},'stopped before it could report back, so it is not known whether it finished']];
 for(const [result,text] of cases){const message=childFailureMessage(result,name,60);expect(message).toContain('The workflow "Checker" '+text);expect(message).not.toContain(result.code!);expect(message).toContain('Continue when the child fails');}
});
