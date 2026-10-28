import { ONBOARDING_PIECE, ONBOARDING_ACTION } from './customer-onboarding';
import { onboardingFixtureSetup } from './onboarding-fixtures';
export function onboardingTestGraph(configured=false): any {
  return {name:'trigger',type:'PIECE_TRIGGER',settings:{pieceName:'webhook',input:{}},nextAction:{name:'resources',type:'PIECE',settings:{pieceName:ONBOARDING_PIECE,actionName:ONBOARDING_ACTION,input:{customer:'{{trigger}}',...Object.fromEntries(Object.entries(onboardingFixtureSetup).map(([k,v])=>[k,configured?v:'']))}},nextAction:{name:'summary',type:'PIECE',settings:{pieceName:'@jarvispieces/piece-jarvis-notify',actionName:'notify',input:{message:'{{resources.summary}}',idempotencyKey:'{{resources.notificationKey}}',channels:['dashboard']}}}}};
}
