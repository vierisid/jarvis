import { confirmDialog } from '../../v2/ui/ConfirmDialog';
import { inputDialog } from './InputDialog';
import React, { useId, useState } from 'react';
import { useBriefConversation } from '../chat/provider';
import { ConversationTabStrip } from '../chat/tab-strip/ConversationTabStrip';
import { bindConversationTabs, chatTabId } from '../chat/tab-strip/model';
import { ConversationComposer } from '../chat/composer/ConversationComposer';
import { bindConversationComposer } from '../chat/composer/model';
import { ConversationMessages } from '../chat/message/ConversationMessages';
import { bindConversationMessages } from '../chat/message/model';
import { AttachmentFan } from '../chat/attachment-fan/AttachmentFan';
import { bindAttachmentFan } from '../chat/attachment-fan/model';
import type { DashboardOwner } from './owner';

function pickFile(kind: 'document' | 'image', signal: AbortSignal): Promise<File | null> {
  return new Promise(resolve => {
    const input = document.createElement('input'); input.type = 'file'; input.hidden = true;
    input.accept = kind === 'image' ? 'image/png,image/jpeg' : '.txt,.md,.csv,.json,.pdf';
    const finish = (value: File | null) => { signal.removeEventListener('abort', abort); input.remove(); resolve(value); };
    const abort = () => finish(null); signal.addEventListener('abort', abort, { once: true });
    input.onchange = () => finish(input.files?.[0] ?? null); input.oncancel = () => finish(null);
    if (signal.aborted) finish(null); else { document.body.append(input); input.click(); }
  });
}
export function HostConversation({ host }: { host: DashboardOwner }) {
  const owner = useBriefConversation(), id = useId(), [message, setMessage] = useState('');
  const tabs = bindConversationTabs(owner, 'live'), composer = bindConversationComposer(owner, 'live');
  const fan = bindAttachmentFan(owner.client, { file: pickFile,
    screenshotAvailability: { available: host.devices().length > 0, reason: 'Connect a computer to capture its screen.' },
    screenshot: async signal => {
      const devices = host.devices(); if (!devices.length || signal.aborted) return null;
      const choice = devices.length === 1 ? '1' : await inputDialog(`Choose a computer by number:\n${devices.map((d, i) => `${i + 1}. ${d.name}`).join('\n')}`);
      if (!choice || !/^\d+$/.test(choice)) return null;
      const device = devices[Number(choice) - 1];
      if (!device || !await confirmDialog(`Capture the screen of ${device.name} and attach it to this conversation?`) || signal.aborted) return null;
      return { deviceId: device.id, confirmed: true };
    } }, 'live');
  const action = async (run: () => Promise<unknown>) => { try { await run(); setMessage(''); } catch { setMessage('The attachment change could not be confirmed.'); } };
  if (owner.status.mode === 'scoped' && !owner.state.activeId) return <div className="brief-host-conversation">
    <p className="brief-message-unavailable" role="status">{owner.status.error ? 'Your chat could not be opened.' : 'Opening your chat…'}</p>
    {owner.status.error && <button type="button" disabled={owner.status.pending > 0} onClick={() => void owner.client.ensureActive().catch(() => {})}>Try again</button>}
  </div>;
  return <div className="brief-host-conversation">
    <ConversationTabStrip mode="live" panelId={id} binding={tabs} />
    <ConversationMessages mode="live" panelId={id} labelledBy={tabs.activeId ? chatTabId(id, tabs.activeId) : undefined} binding={bindConversationMessages(owner, 'live')} />
    {!!owner.current?.attachments.length && <ul aria-label="Draft attachments">{owner.current.attachments.map(file => <li key={file.attachmentId}>
      <span>{file.name} · {file.state}</span>
      {file.state === 'failed' && <button onClick={() => void action(() => owner.client.attachments.retry(owner.state.activeId!, file.attachmentId))}>Retry</button>}
      <button onClick={() => void action(() => owner.client.attachments.remove(owner.state.activeId!, file.attachmentId))}>Remove</button>
    </li>)}</ul>}
    <p role="status">{message}</p>
    <ConversationComposer mode="live" binding={composer} attachmentControl={<AttachmentFan mode="live" binding={fan} onFeedback={setMessage} />} />
  </div>;
}
