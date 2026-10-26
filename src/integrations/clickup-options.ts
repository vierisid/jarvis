import type {JarvisConfig} from '../config/types';
import {readClickUpConnection} from './clickup-connection';

export class ClickUpOptionsError extends Error {
  constructor(message: string, readonly status = 502) { super(message); }
}
type Choice = {id: string | number; name: string};
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ClickUpOptionsError('ClickUp returned an invalid response. Try again or enter IDs.');
  return value as Record<string, unknown>;
}
function choices(value: unknown): Choice[] {
  if (!Array.isArray(value) || value.length > 2000) throw new ClickUpOptionsError('ClickUp choices could not be loaded. Try again or enter IDs.');
  return value.map(raw => {
    const item = object(raw);
    if (typeof item.name !== 'string' || !(typeof item.id === 'string' && item.id || typeof item.id === 'number' && Number.isInteger(item.id))) {
      throw new ClickUpOptionsError('ClickUp returned an invalid choice. Try again or enter IDs.');
    }
    return {id: item.id as string | number, name: item.name};
  });
}

/** Fixed read-only endpoints. Never forward provider URLs, tokens or error bodies. */
export async function clickUpOptions(config: JarvisConfig, query: URLSearchParams, request: typeof fetch = fetch) {
  const connection = readClickUpConnection(config.daemon.data_dir);
  if (!connection) throw new ClickUpOptionsError('Connect ClickUp before choosing a list.', 409);
  const kind = query.get('kind'), id = query.get('id') ?? '';
  if (!['spaces', 'lists'].includes(kind ?? '') || !/^[a-zA-Z0-9_-]{1,128}$/.test(id)) {
    throw new ClickUpOptionsError('Choose a workspace or space first.', 400);
  }
  if (kind === 'spaces' && !connection.workspaces.some(w => w.id === id)) {
    throw new ClickUpOptionsError('That workspace is not connected.', 403);
  }
  async function get(path: string): Promise<unknown> {
    let response: Response;
    try {
      response = await request('https://api.clickup.com/api/v2/' + path, {
        headers: {Authorization: 'Bearer ' + connection!.access_token},
        redirect: 'error', signal: AbortSignal.timeout(15000),
      });
    } catch { throw new ClickUpOptionsError('Could not reach ClickUp. Try again.'); }
    if (response.status === 401 || response.status === 403) {
      throw new ClickUpOptionsError('ClickUp refused access. Reconnect or choose an accessible space.', 409);
    }
    if (response.status === 429) throw new ClickUpOptionsError('ClickUp is rate limiting requests. Wait a moment and try again.', 429);
    if (!response.ok) throw new ClickUpOptionsError('Could not load ClickUp choices. Try again.');
    try { return await response.json(); }
    catch { throw new ClickUpOptionsError('ClickUp returned an invalid response. Try again.'); }
  }
  const options = (values: unknown) => choices(values).map(v => ({value: String(v.id), label: v.name.slice(0, 200)}));
  if (kind === 'spaces') return options(object(await get('team/' + id + '/space?archived=false')).spaces);
  const [rawLists, rawFolders] = await Promise.all([
    get('space/' + id + '/list?archived=false'), get('space/' + id + '/folder?archived=false'),
  ]);
  const folderless = choices(object(rawLists).lists), folders = object(rawFolders).folders;
  if (!Array.isArray(folders) || folders.length > 2000) throw new ClickUpOptionsError('ClickUp returned invalid folders. Try again or enter IDs.');
  // Get Folders includes its lists, so no per-folder request fan-out is needed.
  const nested = folders.flatMap(raw => {
    const folder = object(raw);
    if (typeof folder.name !== 'string') throw new ClickUpOptionsError('ClickUp returned an invalid folder.');
    return choices(folder.lists).map(list => ({...list, name: folder.name + ' / ' + list.name}));
  });
  return [...new Map(options([...folderless, ...nested]).map(o => [o.value, o])).values()];
}
