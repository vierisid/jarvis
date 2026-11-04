import {BATCH_PIECE,BATCH_ACTION,BATCH_FINALIZE} from './lead-batch';
import {batchFixtureSetup} from './batch-fixtures';
export function batchTestGraph(configured=false):any {
 return {name:'trigger',type:'PIECE_TRIGGER',settings:{pieceName:'webhook',input:{}},nextAction:{name:'batch',type:'PIECE',settings:{pieceName:BATCH_PIECE,actionName:BATCH_ACTION,input:{submission:'{{trigger}}',...Object.fromEntries(Object.entries(batchFixtureSetup).map(([k,v])=>[k,configured?v:k==='propertyMapping'?null:'']))}},nextAction:{name:'summary',type:'PIECE',settings:{pieceName:'@jarvispieces/piece-jarvis-notify',actionName:'notify',input:{message:'{{batch.summary}}',idempotencyKey:'{{batch.notificationKey}}',channels:['dashboard']}},nextAction:{name:'finish',type:'PIECE',settings:{pieceName:BATCH_PIECE,actionName:BATCH_FINALIZE,input:{result:'{{batch}}'}}}}}};
}
