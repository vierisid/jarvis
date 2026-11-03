import type {JarvisConfig} from '../config/types';
import {readTrelloConnection} from './trello-connection';
import {runManagedTrelloAction} from '../workflows/runtime/managed-trello';
export class TrelloOptionsError extends Error {constructor(message:string,readonly status=502){super(message);}}
export async function trelloOptions(config:JarvisConfig,params:URLSearchParams,request:typeof fetch=fetch) {
  const connection=readTrelloConnection(config.daemon.data_dir);
  if(!connection)throw new TrelloOptionsError('Connect Trello before choosing a board or list.',409);
  const board=params.get('board');
  if(board && !/^[a-f0-9]{24}$/.test(board))throw new TrelloOptionsError('Choose a valid board.',400);
  if(params.get('generation') && params.get('generation')!==connection.generation)throw new TrelloOptionsError('Trello account changed. Reload boards before choosing.',409);
  try {
    const result=await runManagedTrelloAction(board?'list_lists':'list_boards',{
      auth:{username:connection.api_key,password:connection.access_token,jarvis_managed:'trello'},
      board_id:board,filter:'open',
    },request) as {boards?:Array<{id:string;name:string}>;lists?:Array<{id:string;name:string}>};
    if(readTrelloConnection(config.daemon.data_dir)?.generation!==connection.generation)throw new TrelloOptionsError('Trello account changed. Reload boards before choosing.',409);
    return {options:(result.boards ?? result.lists ?? []).map(v=>({value:v.id,label:v.name})),generation:connection.generation};
  } catch(error) {
    if(error instanceof TrelloOptionsError)throw error;
    const message=error instanceof Error?error.message:'Could not load Trello choices.';
    throw new TrelloOptionsError(message,message.includes('reconnect')?409:message.includes('rate limiting')?429:502);
  }
}
