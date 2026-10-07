import { ingredientKey, type Ingredient, type IngredientChoice } from "./model";
/** Explicit preview only. These are not a production catalog or account fallback. */
const choice = (selection:Ingredient,displayName:string,group:string):IngredientChoice => ({selection,displayName,group,key:ingredientKey(selection),tab:selection.kind,status:"ready"});
export const INGREDIENT_FIXTURES: IngredientChoice[] = [
  choice({kind:"connection",id:"gmail-work",pieceName:"@activepieces/piece-gmail",pieceVersion:"0.9.0",required:true},"Gmail · Work","Gmail"),
  choice({kind:"connection",id:"calendar-work",pieceName:"@activepieces/piece-google-calendar",pieceVersion:"0.5.0",required:true},"Google Calendar","Google Calendar"),
  choice({kind:"library-action",id:"@activepieces/piece-gmail",actionName:"create_draft",pieceVersion:"0.9.0",actionVersion:"a".repeat(64),required:true},"Gmail: Create draft","Gmail"),
  choice({kind:"library-action",id:"@activepieces/piece-text-helper",actionName:"extract_fields",pieceVersion:"0.3.0",actionVersion:"b".repeat(64),required:true},"Extract structured fields from meeting notes","Text Helper"),
  choice({kind:"library-action",id:"@activepieces/piece-google-calendar",actionName:"list_events",pieceVersion:"0.5.0",actionVersion:"c".repeat(64),required:true},"Google Calendar: List events","Google Calendar"),
  {key:"package:hubspot",displayName:"HubSpot",group:"HubSpot",tab:"library-action",status:"uninstalled"},
  {key:"missing:slack",displayName:"Slack",group:"Slack",tab:"connection",status:"missing-account"},
  {key:"unavailable:discord",displayName:"Discord",group:"Discord",tab:"connection",status:"unavailable"},
];
