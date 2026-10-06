import type { AwarenessEvent, Suggestion } from '../awareness/types.ts';
import type { BackgroundAgentService } from './background-agent-service.ts';
import type { ChannelService } from './channel-service.ts';
import type { WebSocketService } from './ws-service.ts';
import type { WebSocketServer } from '../comms/websocket.ts';
import type { EventReactor } from './event-reactor.ts';
import type { EventCoalescer } from './event-coalescer.ts';
import type { WorkflowEventBus } from '../workflows/runtime/event-bus.ts';
import { AWARENESS_EVENT_TYPE_MAP } from '../workflows/runtime/event-types.ts';
import { classifyEvent } from './event-classifier.ts';
import { wrapUntrusted, inlineUntrusted } from '../roles/untrusted.ts';
import { sendDesktopNotification as defaultDesktop, type sendDesktopNotificationWithReceipt } from '../comms/desktop-notify.ts';
import { deliverOpportunityNotification } from './opportunity-notification.ts';

type DeliverySockets = Pick<WebSocketService, 'broadcastAwarenessEvent' | 'broadcastNotification' | 'broadcastProactiveVoice'> & {
  getServer(): Pick<WebSocketServer, 'getClientCount' | 'broadcastWithReceipt'>;
};
export interface AwarenessDeliveryDependencies {
  sockets: DeliverySockets;
  channels: Pick<ChannelService, 'broadcastToAll' | 'tryBroadcastToChannels'> & { getManager(): { listChannels(): string[] } };
  reactor: Pick<EventReactor, 'react'>;
  coalescer: Pick<EventCoalescer, 'addEvent'>;
  eventBus: Pick<WorkflowEventBus, 'publish'>;
  agent(): Pick<BackgroundAgentService, 'handleMessage' | 'lastTurnRequestedApproval'> | null;
  desktop?: typeof defaultDesktop;
  // A launched sender is not a delivery receipt; keep the two contracts distinct.
  desktopWithReceipt?: typeof sendDesktopNotificationWithReceipt;
}

/** Only the AwarenessService callback and opportunity outbox use this policy.
 * Explicit chat/research, execution failures, Authority and emergency delivery
 * keep their own governed paths. The flag is fixed for this daemon lifetime.
 */
export class AwarenessDeliveryPolicy {
  readonly quiet: boolean;
  private readonly awarenessWarnedTypes = new Set<string>();
  constructor(private readonly deps: AwarenessDeliveryDependencies, flag?: string) { this.quiet = flag === '1'; }
  readiness(): 'ready' { return 'ready'; }

  handleEvent(event: AwarenessEvent): void {
    const { sockets: wsService, channels: channelService, reactor, coalescer, eventBus: sharedEventBus } = this.deps;
    const awarenessWarnedTypes = this.awarenessWarnedTypes;
    const sendDesktopNotification = this.deps.desktop ?? defaultDesktop;
    // Republish onto the workflow event bus so flows with `on_event`
    // triggers (awareness.context_changed, awareness.suggestion_ready, etc.)
    // can fire on real awareness state. Unknown raw types warn once + fall
    // back to `awareness.<rawType>` so the bus side never drops events.
    const mapped = AWARENESS_EVENT_TYPE_MAP[event.type];
    const canonical = mapped ?? `awareness.${event.type}`;
    if (!mapped && !awarenessWarnedTypes.has(event.type)) {
      awarenessWarnedTypes.add(event.type);
      console.warn(
        `[Daemon] AwarenessService emitted unknown raw type "${event.type}"; publishing as "${canonical}" but it is not in WORKFLOW_EVENT_TYPES; add a mapping in src/workflows/runtime/event-types.ts so the composer surfaces it.`,
      );
    }
    sharedEventBus.publish(canonical, { ...event.data, _timestamp: event.timestamp });
    // Opportunity notifications use their durable outbox below.
    if (!event.data.opportunityId) wsService.broadcastAwarenessEvent(event);
    // Capture, card/inbox signals and explicit workflow subscriptions remain active.
    // Never feed ambient awareness into an automatic assistant in quiet mode.
    if (this.quiet) return;
    const bgAgent = this.deps.agent();

    // Route awareness events through existing event pipeline
    const classified = classifyEvent({
      type: event.type,
      data: event.data,
      timestamp: event.timestamp,
    });
    if (classified.priority === 'critical' || classified.priority === 'high') {
      reactor.react(classified).catch(err =>
        console.error('[Daemon] Awareness reaction error:', err)
      );
    } else {
      coalescer.addEvent(classified);
    }
    // Push suggestions as chat notifications + voice + desktop
    if (event.type === 'suggestion_ready' && !event.data.opportunityId) {
      const title = String(event.data.title ?? '');
      const body = String(event.data.body ?? '');
      const text = `**${title}**\n${body}`;
      console.log(`[Daemon] Awareness suggestion firing: "${title}"`);

      const hasWsClients = wsService.getServer().getClientCount() > 0;

      if (hasWsClients) {
        // Primary: deliver via WebSocket + voice
        wsService.broadcastNotification(text, 'urgent');
        sendDesktopNotification(`JARVIS: ${title}`, body, { urgency: 'normal' });
        wsService.broadcastProactiveVoice(body).catch(err =>
          console.error('[Daemon] Awareness TTS error:', err)
        );
      } else {
        // Fallback: no dashboard clients; deliver via external channels + persistent desktop
        console.log('[Daemon] No WS clients; routing suggestion to external channels');
        channelService.broadcastToAll(text).catch(err =>
          console.error('[Daemon] Channel broadcast error:', err)
        );
        sendDesktopNotification(`JARVIS: ${title}`, body, { urgency: 'critical', expireMs: 30000 });
      }
    }

    // Auto-research errors: silently investigate and deliver solution
    if (event.type === 'error_detected' && bgAgent) {
      const errorText = String(event.data.errorText ?? '');
      const appName = String(event.data.appName ?? '');
      if (errorText.length > 5) {
        console.log(`[Daemon] Auto-researching error: "${errorText.slice(0, 80)}"`);
        bgAgent.handleMessage(
          // `appName` is the active window's app name, which a web page
          // controls through document.title -- the same actor that
          // supplies the framed errorText below. Framing the error text
          // and interpolating the app name raw would leave an unframed
          // channel in the sentence that introduces the block, complete
          // with newlines to open headings of its own.
          `The user is seeing an error in ${inlineUntrusted(appName, 60)}. The error text, read from their screen:\n` +
          wrapUntrusted(errorText, 'screen text (OCR)') + '\n\n' +
          `Search the web and vault for a solution. Be concise and actionable. ` +
          `Start your response with the fix, not a question.`,
          'awareness'
        ).then(solution => {
          if (solution && solution.length > 10) {
            // A turn that stopped on an approval request is not a fix yet.
            const awaiting = bgAgent?.lastTurnRequestedApproval() ?? false;
            const heading = awaiting ? `Needs your approval (error in ${appName})` : `Fix for error in ${appName}`;
            const solutionText = `**${heading}:**\n${solution.slice(0, 500)}`;
            wsService.broadcastNotification(solutionText, 'urgent');
            sendDesktopNotification(`JARVIS: ${heading}`, solution.slice(0, 200), { urgency: 'critical', expireMs: 15000 });
            // Strip markdown for TTS; voice should sound natural
            const voiceText = solution
              .replace(/#{1,6}\s*/g, '')
              .replace(/\*{1,2}([^*]+)\*{1,2}/g, '$1')
              .replace(/`([^`]+)`/g, '$1')
              .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
              .replace(/\n{2,}/g, '. ')
              .replace(/\n/g, ' ')
              .replace(/\s{2,}/g, ' ')
              .trim()
              .slice(0, 300);
            console.log(`[Daemon] Speaking error solution (${voiceText.length} chars): "${voiceText.slice(0, 80)}..."`);
            wsService.broadcastProactiveVoice(
              awaiting
                ? `I need your approval to fix the error in ${appName}. ${voiceText}`
                : `I found a fix for the error in ${appName}. ${voiceText}`
            ).then(() =>
              console.log('[Daemon] Error solution TTS delivered')
            ).catch(err =>
              console.error('[Daemon] Error solution TTS failed:', err instanceof Error ? err.message : err)
            );
          }
        }).catch(err =>
          console.error('[Daemon] Error auto-research failed:', err instanceof Error ? err.message : err)
        );
      }
    }

    // Deep-research struggles: for high-confidence code/terminal struggles
    if (event.type === 'struggle_detected' && bgAgent) {
      const appCategory = String(event.data.appCategory ?? 'general');
      const sAppName = String(event.data.appName ?? '');
      const ocrPreview = String(event.data.ocrPreview ?? '');
      const compositeScore = event.data.compositeScore as number;

      if (compositeScore >= 0.7 && (appCategory === 'code_editor' || appCategory === 'terminal')) {
        console.log(`[Daemon] Deep-researching struggle in ${sAppName} (score: ${compositeScore.toFixed(2)})`);
        bgAgent.handleMessage(
          // Same reasoning as the error path above: both of these come
          // from observer event data, so both are labels inside trusted
          // prose rather than trusted text.
          `The user has been struggling in ${inlineUntrusted(sAppName, 60)} (${inlineUntrusted(appCategory, 40)}) for several minutes. ` +
          `Here's what's on their screen:\n` +
          wrapUntrusted(ocrPreview.slice(0, 800), 'screen text (OCR)') + '\n\n' +
          `Search for solutions to any errors visible. Check documentation for the relevant language/framework. ` +
          `Provide a specific, actionable fix. Start with the solution, not a question.`,
          'awareness'
        ).then(solution => {
          if (solution && solution.length > 10) {
            const awaiting = bgAgent?.lastTurnRequestedApproval() ?? false;
            const heading = awaiting ? `Needs your approval (${sAppName})` : `Help for ${sAppName}`;
            const solutionText = `**${heading}:**\n${solution.slice(0, 500)}`;
            wsService.broadcastNotification(solutionText, 'urgent');
            sendDesktopNotification(`JARVIS: ${heading}`, solution.slice(0, 200), { urgency: 'critical', expireMs: 15000 });
            const voiceText = solution
              .replace(/#{1,6}\s*/g, '')
              .replace(/\*{1,2}([^*]+)\*{1,2}/g, '$1')
              .replace(/`([^`]+)`/g, '$1')
              .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
              .replace(/\n{2,}/g, '. ')
              .replace(/\n/g, ' ')
              .replace(/\s{2,}/g, ' ')
              .trim()
              .slice(0, 300);
            wsService.broadcastProactiveVoice(
              awaiting
                ? `I need your approval to help with what you're working on in ${sAppName}. ${voiceText}`
                : `I found something that might help with what you're working on in ${sAppName}. ${voiceText}`
            ).catch(err =>
              console.error('[Daemon] Struggle solution TTS failed:', err instanceof Error ? err.message : err)
            );
          }
        }).catch(err =>
          console.error('[Daemon] Struggle auto-research failed:', err instanceof Error ? err.message : err)
        );
      }
    }
  }

  async deliverOpportunity(suggestion: Suggestion): Promise<string | null> {
    const channel = await deliverOpportunityNotification(
      suggestion, this.deps.sockets.getServer(), this.deps.channels,
      this.deps.desktopWithReceipt, { quiet: this.quiet },
    );
    if (channel === 'websocket' && !this.quiet) {
      (this.deps.desktop ?? defaultDesktop)(`JARVIS: ${suggestion.title}`, suggestion.body, { urgency: 'normal' });
      this.deps.sockets.broadcastProactiveVoice(suggestion.body).catch(err => console.error('[Daemon] Awareness TTS error:', err));
    }
    return channel;
  }
}
