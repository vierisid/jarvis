import { createPiece,createAction,PieceAuth,Property } from '@activepieces/pieces-framework';
import { postContext } from '../../context/src/lib/shared';

const draftFollowups=createAction({
  name:'draft_followups',displayName:'Prepare unsent sales follow-ups',
  description:'Qualified HubSpot/Gmail batch. Exhausts deal and reply pages, selects configured open stages and inactivity timestamp (at least 7 x 24 hours by default), requires one associated contact, checks recent inbound messages, and creates personalized UNSENT Gmail drafts using contact name, company, deal name and your sender name. Persistent atomic contact/date admission uses the configured timezone across concurrent runs and restarts. Each deal failure is recorded while others continue. Uncertain writes are fenced for review, never blindly retried. Returns all outcomes plus one summary for Jarvis Notify. Fixed read and draft-create endpoints only: no send, browser, CRM mutation or delegated agent. Account/provider/mapping/lookback settings may remain empty in a disabled draft.',
  props:{
    crmProvider:Property.StaticDropdown({displayName:'CRM',required:true,options:{options:[{label:'HubSpot',value:'hubspot'}]}}),
    hubspotConnection:Property.ShortText({displayName:'HubSpot account',required:true,description:'Select a securely saved account reference in the editor.'}),
    gmailConnection:Property.ShortText({displayName:'Gmail account',required:true,description:'Select a securely saved account reference in the editor.'}),
    ownerEmail:Property.ShortText({displayName:'Your Gmail address',required:true,description:'Must match the selected Gmail account. No sender or account is guessed.'}),
    senderName:Property.ShortText({displayName:'Your sender name',required:true}),
    openStageIds:Property.ShortText({displayName:'Open deal stage IDs',required:true,description:'Comma-separated HubSpot stage IDs. Each is checked against the actual pipeline and must be open.'}),
    inactivityProperty:Property.ShortText({displayName:'Last activity property',required:true,description:'Actual HubSpot deal datetime property defining inactivity, selected by you. Missing dates need review.'}),
    replyLookbackDays:Property.Number({displayName:'Recent reply window (days)',required:true,description:'1-365 days. Any exact-contact inbound message in this window vetoes a follow-up, across all mailbox threads.'}),
    inactivityDays:Property.Number({displayName:'Inactive for (days)',required:true,defaultValue:7}),
    timezone:Property.ShortText({displayName:'Timezone',required:true,defaultValue:'Europe/Rome'}),
  },
  outputSample:{complete:true,day:'2026-10-23',results:[{dealId:'example',status:'drafted',draftId:'example',detail:'Unsent draft saved'}],counts:{drafted:1,replied:0,already_processed:0,ineligible:0,review:0,unknown:0},summary:'One batch summary with drafts, skips and failures. Nothing sent.',notificationKey:'sales-summary:run-id'},
  async run(context){return postContext(context,'/v1/jarvis/sales/followups',context.propsValue,{complete:false,results:[],summary:''});},
});
export const jarvisSalesPiece=createPiece({displayName:'Jarvis: Sales',description:'Governed, draft-only sales follow-ups with persistent daily contact tracking and per-deal outcomes.',auth:PieceAuth.None(),minimumSupportedRelease:'0.0.0',logoUrl:'',authors:['jarvis'],actions:[draftFollowups],triggers:[]});
