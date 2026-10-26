import type {JarvisConfig} from '../config/types';
import {readMailchimpConnection} from './mailchimp-connection';
import {mailchimpJson, MailchimpRequestError} from '../workflows/runtime/managed-mailchimp';
export class MailchimpOptionsError extends Error {constructor(message: string, readonly status = 502) {super(message);}}
export async function mailchimpOptions(config: JarvisConfig, params: URLSearchParams, request: typeof fetch = fetch) {
  const connection = readMailchimpConnection(config.daemon.data_dir);
  if (!connection) throw new MailchimpOptionsError('Connect Mailchimp before choosing an audience or campaign.', 409);
  const kind = params.get('kind');
  if (kind !== 'audiences' && kind !== 'campaigns') throw new MailchimpOptionsError('Choose audiences or campaigns.', 400);
  if (params.get('generation') && params.get('generation') !== connection.generation) throw new MailchimpOptionsError('Mailchimp account changed. Reload choices.', 409);
  const campaigns = kind === 'campaigns';
  const path = campaigns ? 'campaigns?status=sent&count=100&sort_field=send_time&sort_dir=DESC&fields=campaigns.id,campaigns.settings.title,total_items' : 'lists?count=100&fields=lists.id,lists.name,total_items';
  try {
    const raw = await mailchimpJson(path, connection, {}, request) as Record<string, unknown>;
    const items = raw?.[campaigns ? 'campaigns' : 'lists'];
    if (!Array.isArray(items) || items.length > 100 || typeof raw.total_items !== 'number' || !Number.isInteger(raw.total_items) || raw.total_items < items.length) throw new MailchimpOptionsError('Mailchimp returned invalid choices. Try again.');
    const options = items.map(item => {
      const label = campaigns ? item?.settings?.title : item?.name;
      if (!/^[a-zA-Z0-9]{1,64}$/.test(item?.id) || typeof label !== 'string') throw new MailchimpOptionsError('Mailchimp returned invalid choices. Try again.');
      return {value: item.id as string, label};
    });
    if (readMailchimpConnection(config.daemon.data_dir)?.generation !== connection.generation) throw new MailchimpOptionsError('Mailchimp account changed. Reload choices.', 409);
    return {options, generation: connection.generation, has_more: raw.total_items > options.length};
  } catch (error) {
    if (error instanceof MailchimpOptionsError) throw error;
    if (error instanceof MailchimpRequestError) throw new MailchimpOptionsError(error.message, [401,403].includes(error.status) ? 409 : error.status === 429 ? 429 : 502);
    throw new MailchimpOptionsError('Could not load Mailchimp choices. Try again.');
  }
}
