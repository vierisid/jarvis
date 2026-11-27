/**
 * The notch, as the brain puts it together (fix 02, step 7).
 *
 * This is the notch's part of the brain's start, moved out of index.ts as it
 * was: the surface and the demo, the part that talks to other people's
 * Jarvises, the real things on the notch with everything they are given, the
 * test items, the notch's routes, and the stop on the brain's way down. The
 * brain calls `createNotch` where the surface has to exist (before a desktop
 * app connects), `startNotch` once the approvals and the rest are there,
 * `notchApiRoutes` with its routes, and `stopNotchFirst` first on its way
 * down. What the rest of the brain reads of the notch is held here.
 *
 * With JARVIS_NOTCH unset `createNotch` makes nothing (it registers no notch
 * message and makes no surface), `startNotch` only puts Pause back to its
 * meaning with the switch off, and the routes are absent.
 */
import type { BriefAttachmentProvider } from '../brief/attachments';
import { appendFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import type { loadConfig } from "../config/loader.ts";
import type { AgentService } from "./agent-service.ts";
import { MIN_SECRET_LENGTH } from "./debug-rpc-gate.ts";
import type { WebSocketService } from "./ws-service.ts";
import type { CommitmentExecutor } from "./commitment-executor.ts";
import type { BriefChatTransport } from '../brief/chat-transport.ts';
import type { GoogleAuth } from "../integrations/google-auth.ts";
import type { BackgroundAgentService } from "./background-agent-service.ts";
import { DASHBOARD_DECIDER, type ApprovalManager } from "../authority/approval.ts";
import type { AuditTrail } from "../authority/audit.ts";
import { setPauseHoldsLoops, type EmergencyController } from "../authority/emergency.ts";
import type { ApprovalDelivery } from "../authority/approval-delivery.ts";
import type { DeferredExecutor } from "../authority/deferred-executor.ts";
import { NOTCH_DECIDER, SYSTEM_DECIDER, applyApprovalDecision } from "./approval-decision.ts";
import { projectFailure } from "../failures/projection.ts";
import { recordChatFailure } from "../failures/chat.ts";
import { listOpenFailures } from "../workflows/runtime/open-failures.ts";
import { getHumanInput, listHumanInputs, resolveHumanInput } from "../workflows/runtime/human-input.ts";
import type { SidecarManager } from "../sidecar/manager.ts";
import { attachNotch, createNotchReopen, NOTCH_PANEL_ID } from "../notch/attach.ts";
import { createNotchDemo } from "../notch/demo.ts";
import type { NotchDemo } from "../notch/demo.ts";
import { NOTCH_DEMO_PATH } from "../notch/demo-gate.ts";
import { NOTCH_PAGE_PATH, notchRoutes } from "../notch/routes.ts";
import { notchMailBrowser, notchMailLayerDeps, notchStudyDeps } from "./notch-mail-browser.ts";
import { NOTCH_FIXTURE_LOG, type NotchFixtures } from "../notch/fixtures.ts";
import { notchDevFor } from "../notch/dev.ts";
import { createCommitment, findCommitments } from "../vault/commitments.ts";
import { notchMoveSlipped, notchSlipped } from "./notch-slipped.ts";
import { attachNotchReal } from "../notch/real.ts";
import { NOTCH_DEV_FAILED_NOTICE, NOTCH_FAILED_NOTICE, NOTCH_PEOPLE_FAILED_NOTICE, holdNotch, notchDashboardNotice, startNotchPart, stopNotch } from "./notch-start.ts";
import { setOwnerWordProbe } from "../authority/owner-word.ts";
import { notchAskDeps, notchCallDeps, notchNoticeDeps, notchMailModelReady, notchModelReady, notchScriptDeps, setNotchFrontSource, wireOwnerWord } from "./notch-asks.ts";
import { notchOfficeDeps } from "./notch-office.ts";
import { notchPeerWork } from "./notch-peers.ts";
import { gistMessages } from "../notch/drop-gist.ts";
import { notchDayOneDeps, notchFileKnown, notchFilePlaces, notchRememberFile } from "./notch-dayone.ts";
import { NOTCH_NAME } from "../notch/name.ts";
import type { NotchSettingsPage } from "../notch/prefs.ts";
import { notchJobDeps } from "./notch-jobs.ts";
import { notchAgentDeps } from "./notch-agents.ts";
import type { NotchReal } from "../notch/real.ts";
import { NotchSurface, realNotchTimers } from "../notch/surface.ts";
import { NOTCH_PAGE_RELOADS_SINCE } from "../notch/protocol.ts";
import { notchEnabled } from "../notch/switch.ts";
import { appFound, downloadsFolder, saveDownload, saveThroughApp } from "../peers/downloads.ts";
import { PeerLink } from "../peers/link.ts";
import { PeerSetup } from "../peers/setup.ts";
import { PeerStore } from "../peers/store.ts";
import { peersEnginePath, peersOn, peersSourcePath } from "../peers/switch.ts";
import { DEFAULT_IDS } from "../workflows/db/schema.ts";
import { runWithOrigin } from "../llm/origin.ts";
import { setCaptureGuard } from "../awareness/capture-guard.ts";
import { isDesktopEnabled } from "../actions/tools/desktop-guard.ts";
import type { ManageWorkflowDeps } from '../actions/tools/manage-workflow.ts';
import type { getDb as getDbOf } from '../vault/schema.ts';
import type { NotchDemoGateState } from '../notch/demo-gate.ts';

/** What the brain's configuration is, as it was loaded. */
type JarvisConfigOf = Awaited<ReturnType<typeof loadConfig>>;

/** The small window that says it is installed, by its name among the desktop app's windows. */
const NOTCH_INSTALLED_CARD = 'notch:installed';

// The turn store, for instructions given on the notch. Built far below.
export let notchTurnStore: BriefChatTransport | null = null;
// Where the files of a notch turn are kept (what was circled on the screen, a dropped file): made with the chat routes.
export let notchAttachments: BriefAttachmentProvider | null = null;
export let notchSurface: NotchSurface | null = null;
export let notchDemo: NotchDemo | null = null;
// The real things on the notch: approvals and the rest (src/notch/real.ts).
export let notchReal: NotchReal | null = null;
// Its fixed test items, while the demo gate is open (src/notch/dev.ts).
export let notchFixtures: NotchFixtures | null = null;
/** The product's own switch for watching, as the notch's day one uses it. Null until it is there, and where there is none. */
export let notchSetWatching: ((on: boolean) => Promise<boolean>) | null = null;
/** Completes the product's own first setup from the notch's day one. Null until what it starts can be started. */
export let notchFinishSetup: (() => Promise<void>) | null = null;

// What the rest of the brain asks of the notch: each answers as if there were none when there is none.

/** Whether the notch was made. */
export function notchIsUp(): boolean { return notchReal !== null; }
/** Whether a notch page is up: then the notch tells the person, and the toasts need not. */
export function notchShowing(): boolean { return notchReal?.showing() === true; }
/** Where suggestion toasts go while the notch is on: the count. Null without a notch. */
export function notchSuggestionsNow(): NotchReal['suggestions'] | null { return notchReal?.suggestions ?? null; }
/** Watching, or what may be watched, changed: the notch's eyes follow. */
export function notchRefreshWhere(): void { notchReal?.where?.refresh(); }
/**
 * The turn store for instructions given on the notch is there. What the last run left open is closed now, and
 * answers nobody closed come back.
 */
export function notchTurnsReady(store: BriefChatTransport): void {
  notchTurnStore = store;
  notchReal?.asks?.resume();
}

/** Sets what the brain makes elsewhere for the notch, as it is made. */
export function setNotchAttachments(attachments: BriefAttachmentProvider | null): void { notchAttachments = attachments; }
export function setNotchSetWatching(set: ((on: boolean) => Promise<boolean>) | null): void { notchSetWatching = set; }
export function setNotchFinishSetup(finish: (() => Promise<void>) | null): void { notchFinishSetup = finish; }

/** A notch that could not be started is said on the dashboard: kept for the one that opens next, and shown at once in one that is open. */
let notchNotice: (message: string) => void = (message) => notchDashboardNotice(message);

export interface NotchEarly {
  sidecarManager: SidecarManager;
  wsService: WebSocketService;
  pebblePanelOrigin: string;
  notchDemoState: NotchDemoGateState;
}

/** The surface and the demo: made before a desktop app connects, so that the first page finds them. */
export function createNotch(early: NotchEarly): void {
  const { sidecarManager, wsService, pebblePanelOrigin, notchDemoState } = early;
  // A notch that could not be started is said on the dashboard: kept for the one that opens next, and shown at once in one that is open.
  notchNotice = (message: string): void => notchDashboardNotice(message, (text, storedId) => { wsService.broadcastNotificationToDashboard(text, 'normal', storedId); });
  // The notch ships dark: with JARVIS_NOTCH unset this registers nothing and
  // no notch.* message is ever sent (docs/notch/README.md).
  attachNotch(sidecarManager, { enabled: notchEnabled(), pageUrl: `${pebblePanelOrigin}${NOTCH_PAGE_PATH}` });
  if (notchEnabled()) {
    // What the notch shows lives here, so a desktop app that comes back
    // gets the same line again (src/notch/surface.ts). The notch is not
    // what the brain stands on: if it cannot be made, the brain starts
    // without it and the dashboard says so (./notch-start.ts).
    notchSurface = startNotchPart('the notch', () => {
      // With the real timers: the brain folds an offer that was left alone (the page no longer does).
      const surface = new NotchSurface(sidecarManager, undefined, undefined, realNotchTimers);
      // A page whose sign-in has ended is opened again, signed in anew.
      const notchReopen = createNotchReopen(sidecarManager, { pageUrl: `${pebblePanelOrigin}${NOTCH_PAGE_PATH}` });
      surface.onSignedOut((sidecarId) => { void notchReopen(sidecarId); });
      // A page that speaks another version of the messages is refused. One from version 2 on loads itself
      // again. An older one cannot (it was left up across an update of the brain): it is opened again here.
      surface.onRefused((sidecarId, v) => { if (v < NOTCH_PAGE_RELOADS_SINCE) void notchReopen(sidecarId, `a page speaks version ${v} of the messages`); });
      // And a notch whose window went away by itself is put back.
      sidecarManager.onEvent((sidecarId, event) => {
        if (event.event_type !== 'panel.closed') return;
        if ((event.payload as { panel_id?: unknown } | undefined)?.panel_id !== NOTCH_PANEL_ID) return;
        void notchReopen.closed(sidecarId);
      });
      return surface;
    }, { say: NOTCH_FAILED_NOTICE, notice: notchNotice });
    if (notchSurface && notchDemoState === 'open') {
      // Real things live on the notch too: yes at rest and Esc twice are
      // theirs, and when a moment ends the count is said again.
      notchDemo = createNotchDemo(notchSurface, { real: true, onEnd: () => notchReal?.inbox.refresh() });
      console.warn(`[notch] JARVIS_NOTCH_DEMO is set: ${NOTCH_DEMO_PATH} is OPEN (secret-gated). Whoever holds the secret can make the notch show sample sentences, can make the fixed test items of src/notch/fixtures.ts, and, while this brain has no real model, can load a script into the stand-in model and send it words (src/notch/script.ts). On a brain whose owner signed in to Gmail in Jarvis's own browser it can also read that mail, read the connected calendar and call the model, for the mail study (src/notch/mail/study-route.ts). Keep the secret to this computer.`);
    }
  }
  if (notchDemoState === 'too-short') {
    console.warn(`[notch] JARVIS_NOTCH_DEMO is set but shorter than ${MIN_SECRET_LENGTH} characters; the demo endpoint stays disabled.`);
  } else if (notchDemoState === 'refused-hosted') {
    console.warn('[notch] JARVIS_NOTCH_DEMO is ignored because this install counts as hosted; the demo endpoint stays disabled.');
  } else if (notchDemoState === 'notch-off') {
    console.warn('[notch] JARVIS_NOTCH_DEMO is set but JARVIS_NOTCH is not 1; the demo endpoint stays disabled.');
  }
}

export interface NotchLate {
  sidecarManager: SidecarManager;
  agentService: AgentService;
  wsService: WebSocketService;
  getDb: typeof getDbOf;
  dataDir: string;
  pebblePanelOrigin: string;
  notchDemoState: NotchDemoGateState;
  jarvisConfig: JarvisConfigOf;
  emergencyController: EmergencyController;
  approvalManager: ApprovalManager;
  approvalDelivery: ApprovalDelivery;
  deferredExecutor: DeferredExecutor;
  auditTrail: AuditTrail;
  executor: CommitmentExecutor;
  /** The brain sets these again later: each is asked for when it is used. */
  googleAuthNow: () => GoogleAuth | null;
  bgAgentNow: () => BackgroundAgentService | null;
  workflowDepsNow: () => ManageWorkflowDeps | null;
  /** The part that gets the person into an organisation, for the brain's way down. */
  setPeerSetup(setup: PeerSetup): void;
}

/** The rest of the notch: once the approvals, the pause and the audit are there. */
export function startNotch(late: NotchLate): void {
  const {
    sidecarManager, agentService, wsService, getDb, dataDir, pebblePanelOrigin, notchDemoState, jarvisConfig, emergencyController,
    approvalManager, approvalDelivery, deferredExecutor, auditTrail, executor, googleAuthNow, bgAgentNow, workflowDepsNow, setPeerSetup,
  } = late;
  // With the notch on, Pause also holds the model loops: background work
  // makes no model call until Resume, instead of going round being told no
  // by every tool (authority/emergency.ts, whenRunnable). Decided by the
  // owner on 12 November, with "Esc twice pauses, it does not kill". It is
  // behind the notch switch so that with the switch off Pause is unchanged;
  // to make it the rule everywhere, call this unconditionally.
  // A notch that could not be made is no notch: Pause keeps its meaning of
  // the switch being off (./notch-start.ts).
  setPauseHoldsLoops(notchSurface !== null);

  // The notch: every pending approval becomes one line with one yes. The
  // yes goes through applyApprovalDecision like every other surface's, as
  // its own decider, so decided-once and every refusal hold there too.
  if (notchSurface) {
    // Saying it is the approval: a raw click goes ahead unasked unless what
    // it lands on reads as a delete or a payment, so that has to be known
    // before the click (authority/owner-word.ts).
    wireOwnerWord();
    // A question on the notch is told which app is in front (notchFrontNote).
    setNotchFrontSource(() => notchReal?.where?.front() ?? null);
    // A capture that was on its way when the desktop app started looking
    // away is not kept (awareness/capture-guard.ts).
    setCaptureGuard((id, app) => notchReal?.where?.mayKeep(id, app) ?? true);
    // The dashboard's own window, on the machine named or on every one.
    const notchOpenDashboard = (sidecarId: string | null): void => {
      const targets = sidecarId ? [sidecarId] : sidecarManager.getConnectedSidecars().map((sc) => sc.id);
      for (const id of targets) {
        void sidecarManager.dispatchRPC(id, 'notch.open_dashboard', {}).catch((err) => {
          console.warn('[notch] the dashboard could not be opened:', err instanceof Error ? err.message : err);
        });
      }
    };
    // A settings page of the dashboard, in a window of its own: the
    // dashboard's main window may be open on something else, and is not
    // moved. Where that cannot be opened, the dashboard is.
    // "speech" is where speech-to-text is set: the Channels tab, at its
    // "Voice Transcription" part. The Voice tab is the voice it speaks with.
    const notchOpenPage = (sidecarId: string | null, page: NotchSettingsPage): void => {
      const query = page === 'speech' ? 'settingsTab=channels&settingsFocus=stt' : `settingsTab=${page}`;
      const targets = sidecarId ? [sidecarId] : sidecarManager.getConnectedSidecars().map((sc) => sc.id);
      for (const id of targets) {
        void sidecarManager.dispatchRPC(id, 'panel.spawn', {
          id: `notch:settings:${page}`,
          url: `${pebblePanelOrigin}/?${query}#/_panel_settings`,
          title: 'JARVIS',
          bounds: { x: -1, y: -1, w: 1100, h: 760 },
          resizable: true,
          multi_instance: false,
        }).catch(() => sidecarManager.dispatchRPC(id, 'notch.open_dashboard', {})).catch((err) => {
          console.warn('[notch] a page of the dashboard could not be opened:', err instanceof Error ? err.message : err);
        });
      }
    };
    // A card that was left up comes down when its desktop app connects: the brain went away in the card's
    // two minutes, or the app was not there when it was told to take it away. The card takes no click and no
    // key, so nothing else would ever close it. Day one shows a new one later, when the page says hello.
    sidecarManager.onSidecarConnected((sidecar) => {
      void sidecarManager.dispatchRPC(sidecar.id, 'panel.close', { id: NOTCH_INSTALLED_CARD }).catch(() => { /* none was up, or an older desktop app */ });
    });
    // Other people's Jarvises (src/peers/). Dark unless switched on: by the place of the engine, or by
    // JARVIS_PEERS=1, with which the engine comes when an organisation is made or joined.
    // The link is made before the notch, which shows what it asks of the person; the engine is started after it.
    // If this part cannot be made, the notch starts without other people, and the dashboard says so.
    const peerParts = peersOn() ? startNotchPart("the part of the notch that talks to other people's Jarvises", () => {
      const link = new PeerLink({ log: (line) => console.log(line) });
      return { link, setup: new PeerSetup({
        brainDataDir: dataDir, link, memory: new PeerStore(getDb()), enginePath: peersEnginePath(), source: peersSourcePath(),
        // The person's own home, when the brain was given another: the tunnel program keeps its account there.
        home: os.userInfo().homedir, runtimeDir: path.dirname(process.execPath), log: (line) => console.log(line),
      }) };
    }, { say: NOTCH_PEOPLE_FAILED_NOTICE, notice: notchNotice }) : null;
    const peerLink = peerParts?.link ?? null;
    const peerSetupNow = peerParts?.setup ?? null;
    // A page in the person's own browser: where they sign in. Only a page that is reached safely, and
    // on the machine the answer came from. A desktop app that cannot do it opens nothing.
    const notchOpenUrl = async (sidecarId: string | null, url: string): Promise<boolean> => {
      if (!/^https:\/\//i.test(url)) return false;
      const target = sidecarId ?? sidecarManager.getConnectedSidecars()[0]?.id ?? null;
      if (!target) return false;
      try {
        await sidecarManager.dispatchRPC(target, 'notch.open_url', { url });
        return true;
      } catch {
        return false;
      }
    };
    // Made apart from the brain's own start: when a part of it cannot be made (a notch table that cannot be
    // created, say), what was made of it is stopped again (src/notch/real.ts), what was set for it above is
    // put back, the dashboard says that the notch did not start, and the brain goes on without it.
    const notchPage = notchSurface;
    notchReal = startNotchPart('the notch', () => attachNotchReal(notchPage, {
      busy: () => notchDemo?.running() != null,
      // What a file that arrived from somebody is, in one sentence: one small question to the model about that
      // one file. A PDF is read to text by the product's own reader, apart from the daemon and under a deadline.
      gist: async (file, signal) => {
        const messages = await gistMessages(file, async (bytes) => {
          const { decodeAttachment } = await import('../brief/attachments.ts');
          return decodeAttachment(bytes, 'application/pdf');
        });
        if (!messages) return null;
        return (await agentService.getLLMManager().chatTier('medium', 'notch_file_gist', messages, { max_tokens: 80, temperature: 0, signal })).content;
      },
      // What another person's Jarvis asks of this one is done by the background agent, on a turn that starts tainted.
      ...(peerLink && peerSetupNow ? { peers: {
        db: getDb(), link: peerLink, setup: peerSetupNow, openPage: notchOpenUrl, work: notchPeerWork(bgAgentNow, { decide: (action, requestId) => applyApprovalDecision(action, requestId, NOTCH_DECIDER, { approvalManager, deferredExecutor, wsService, auditTrail }) }),
        // What a sentence that names somebody of the organisation means, when it is none of the fixed words:
        // one small question to the model. It is what the owner has just said, so it does not wait behind
        // the assistant's own work, and it is counted as theirs.
        think: (messages, signal) => runWithOrigin('user', async () =>
          (await agentService.getLLMManager().chatTier('medium', 'notch_peer_read', messages, { max_tokens: 240, temperature: 0, ...(signal ? { signal } : {}) })).content),
        // A file from somebody in the organisation: kept in the brain's own folder while it crosses, then put in the person's Downloads.
        files: {
          dir: path.join(dataDir, 'peers', 'files'),
          save: async (name, bytes) => {
            // The desktop app first: it is the program the person gave leave to touch their folders, on every
            // system. On a Mac the brain's own writing into Downloads is turned down by macOS.
            for (const sidecar of sidecarManager.getConnectedSidecars()) {
              const put = await saveThroughApp((method, params) => sidecarManager.dispatchRPC(sidecar.id, method, params, { initial: 30_000, max: 30_000 }), name, bytes).catch(() => null);
              if (put) return { place: 'Downloads', name: put.name };
            }
            // No app that can: the brain's own hand, which works where the system lets it.
            const saved = saveDownload(await downloadsFolder(), name, bytes);
            if (!saved) console.log('[notch] a file that arrived could not be put in the downloads, by the desktop app or by the brain');
            return saved ? { place: 'Downloads', name: saved.name } : null;
          },
          // A file somebody asks for: looked up by name on the person's own computer, which is the only one
          // that knows where its files are, and taken from its folder only after the person's yes.
          find: async (words) => {
            for (const sidecar of sidecarManager.getConnectedSidecars()) {
              const began = performance.now();
              try {
                // The ones that fit by name, and the ones that were changed last and may be meant whatever they are called.
                const found = appFound(await sidecarManager.dispatchRPC(sidecar.id, 'notch.find', { words, wide: true }, { initial: 8000, max: 8000 }));
                if (found) return found;
                console.log('[notch] a look for a file was answered by the desktop app in a way that is not a list of files');
              } catch (error) {
                // Said, with how long it took: on 23 November 2026 the app's look took 46 seconds where 8 are waited,
                // nothing said so, and it read as folders that could not be reached. The kind of error only.
                console.log(`[notch] the desktop app did not answer a look for a file, after ${Math.round(performance.now() - began)} ms (${error instanceof Error ? error.name : 'error'})`);
              }
            }
            return null;
          },
          // Which of them is meant: one small question to the model, about names and kinds and dates. It is the
          // assistant's own work, not something the owner asked for just now, so it waits behind what they did ask.
          think: (messages, signal) => runWithOrigin('background', async () =>
            (await agentService.getLLMManager().chatTier('medium', 'notch_peer_file', messages, { max_tokens: 60, temperature: 0, ...(signal ? { signal } : {}) })).content),
          known: (place, name) => notchFileKnown(getDb(), place, name),
          open: async (place, name, dir) => {
            for (const sidecar of sidecarManager.getConnectedSidecars()) {
              try {
                const answer = await sidecarManager.dispatchRPC(sidecar.id, 'notch.file', { place, name, ...(dir ? { dir } : {}) }, { initial: 15_000, max: 15_000 }) as
                  { opened?: unknown; _binary?: { data?: unknown } } | null;
                const data = answer?.opened === true ? answer._binary?.data : null;
                if (typeof data === 'string' && data.length > 0 && data.length <= 24 * 1024 * 1024) return new Uint8Array(Buffer.from(data, 'base64'));
              } catch { /* this one cannot hand it over */ }
            }
            return null;
          },
        },
      } } : {}),
      approvalManager,
      // What the notch does in the world is written down in its own list, and in the audit trail with it.
      actions: { db: getDb(), audit: auditTrail },
      approve: (requestId) => applyApprovalDecision('approve', requestId, NOTCH_DECIDER, { approvalManager, deferredExecutor, wsService, auditTrail }),
      // Esc on its line is a no: denied through the same function.
      deny: (requestId) => applyApprovalDecision('deny', requestId, NOTCH_DECIDER, { approvalManager, deferredExecutor, wsService, auditTrail }),
      // An instruction that ended with an approval unanswered: closed through the same function, as
      // the system. Nobody said no, and the audit does not say the owner did.
      withdraw: (requestId) => applyApprovalDecision('deny', requestId, SYSTEM_DECIDER, { approvalManager, deferredExecutor, wsService, auditTrail }),
      // Esc twice pauses through the same controller as the tray's Pause.
      emergency: emergencyController,
      // Where the person is, and whether the desktop app is looking (pass 6).
      where: {
        port: sidecarManager,
        watching: () => (jarvisConfig.awareness as { enabled?: boolean } | undefined)?.enabled !== false && isDesktopEnabled(),
        // "Open my eyes" in What I see: the product's own switch, where there is one.
        openEyes: async () => (notchSetWatching ? notchSetWatching(true) : null),
      },
      // A workflow step that stopped to ask a person: a few short options
      // become a row of choices, approve-or-reject becomes one yes, and
      // anything longer points at the dashboard. Answered through the
      // product's own function, which refuses a second answer.
      questions: {
        pending: () => listHumanInputs(DEFAULT_IDS.project),
        get: (id) => getHumanInput(DEFAULT_IDS.project, id),
        answer: (id, input) => resolveHumanInput(DEFAULT_IDS.project, id, input),
      },
      // News: a failure that opens while the notch is up is said once, in
      // the product's own sentence, and so is a background task that ends.
      openFailures: () => listOpenFailures(Date.now(), DEFAULT_IDS.project)
        // With the workflow it was a run of, and the next steps the product itself calls safe: an agent's
        // failure is said as its own, and has a way out when there is one (src/notch/news.ts).
        .map((row) => ({ key: row.failure.key, headline: row.failure.headline, flowId: row.failure.links.flowId, steps: row.failure.next.map((one) => one.step) })),
      onTaskEnded: (listener) => {
        const taskManager = agentService.getTaskManager();
        if (!taskManager) return false;
        taskManager.subscribeLifecycle((event, task) => {
          if (event === 'complete' || event === 'fail') listener(event, task);
        });
        return true;
      },
      // Promises: the fuse before one is kept, Esc to cancel, and what came of it.
      promises: {
        executor,
        kept: () => findCommitments({ status: 'completed' }),
        // What was due today and was not kept, and the way to move it: the evening line offers it.
        slipped: (since, until) => notchSlipped(since, until),
        move: (ids, at) => notchMoveSlipped(ids, at),
      },
      // Asking: typed in Home, or spoken while the talk keys are held. One
      // stored turn each, in the notch's own conversation; nothing spoken.
      asks: notchAskDeps({
        db: getDb(),
        sidecars: sidecarManager,
        config: () => agentService.getConfig(),
        llm: () => agentService.getLLMManager(),
        transport: () => notchTurnStore,
        attachments: () => notchAttachments,
      }),
      // Mail (pass 7): Jarvis looks at the mailbox by itself, on a clock,
      // through a connection when one reads mail and in its own browser tab
      // when not, and prepares a reply where a person is waiting. A test
      // brain may shorten the rule's four hours, so that a build can be tried
      // without waiting for them.
      mail: notchMailLayerDeps({
        db: getDb(),
        manager: sidecarManager,
        llm: () => agentService.getLLMManager(),
        google: googleAuthNow,
        modelReady: () => notchMailModelReady(agentService.getLLMManager()),
        waitMinutes: notchDemoState === 'open' ? Number(process.env.JARVIS_NOTCH_MAIL_WAIT_MINUTES) : undefined,
      }),
      // Agents (pass 11): a sentence becomes a workflow that is switched on
      // and asks first. The composer is built further down, with the
      // workflow tool: until then nothing can be made, and it says so.
      agents: notchAgentDeps({ db: getDb(), workflowDeps: workflowDepsNow }),
      // Standing things (pass 11): an eye kept on a person's answer, and a
      // chase until it is in. A chase waits a day or more between its two
      // mails; a test brain may shorten that, so that it can be tried.
      standing: {
        ...(notchDemoState === 'open' && Number(process.env.JARVIS_NOTCH_CHASE_WAIT_MINUTES) >= 1 && Number(process.env.JARVIS_NOTCH_CHASE_WAIT_MINUTES) <= 1440
          ? { chaseWaitMs: Math.floor(Number(process.env.JARVIS_NOTCH_CHASE_WAIT_MINUTES)) * 60_000 } : {}),
      },
      // From anywhere, and the shape of the day (pass 8): the speaking rule
      // and the quiet hours, the calendar as a source, things held during a
      // call, the lines of the day, and a lost connection. The desktop app
      // says when a call is on and whether its machine is online.
      day: { db: getDb(), around: sidecarManager },
      // Listening to a call: asked for each call, no sound kept, the words
      // kept a week and the notes ninety days (src/notch/call.ts).
      calls: notchCallDeps({ db: getDb(), sidecars: sidecarManager, config: () => agentService.getConfig(), llm: () => agentService.getLLMManager() }),
      // Noticing: in the window the person is in, one thing offered when
      // their hands rest, never where Jarvis looks away (src/notch/notice.ts).
      notice: notchNoticeDeps({ llm: () => agentService.getLLMManager() }),
      // Doing it in view (pass 10): a job done where it can be seen, one
      // caught by itself when it is done twice by hand, one shown with
      // "Watch me", and a thing put where the person points.
      jobs: notchJobDeps({
        db: getDb(),
        sidecars: sidecarManager,
        llm: () => agentService.getLLMManager(),
        modelReady: () => notchModelReady(agentService.getLLMManager()),
      }),
      openDashboard: notchOpenDashboard,
      // Day one in the notch (pass 12): on a brain that was never set up
      // it starts by itself, once. An AI is set up in the dashboard's own
      // first steps, which it opens and waits for: while this brain was
      // never set up the dashboard shows them by itself, and after that
      // the AI page is the place.
      dayOne: notchDayOneDeps({
        config: () => agentService.getConfig(),
        llm: () => agentService.getLLMManager(),
        watching: {
          on: () => (jarvisConfig.awareness as { enabled?: boolean } | undefined)?.enabled !== false && isDesktopEnabled(),
          get set() { return notchSetWatching; },
        },
        // The page where an AI is chosen and its key is given, in a window
        // of its own. It opens before the dashboard's own first steps are
        // done: day one is those steps, with the notch on.
        openSetup: (sidecarId) => notchOpenPage(sidecarId, 'llm'),
        // What makes out speech has a page and a key of its own.
        openVoice: (sidecarId) => notchOpenPage(sidecarId, 'speech'),
        finishSetup: async () => { await notchFinishSetup?.(); },
        // "Pillow is installed": a small window in the middle of the
        // screen, of each computer that shows the notch, that takes no
        // click and no key. An older desktop app opens it where it likes.
        card: {
          show: () => {
            for (const sidecar of sidecarManager.getConnectedSidecars()) {
              void sidecarManager.dispatchRPC(sidecar.id, 'panel.spawn', {
                id: NOTCH_INSTALLED_CARD,
                url: `${pebblePanelOrigin}${NOTCH_PAGE_PATH}?card=installed`,
                title: NOTCH_NAME,
                bounds: { x: -1, y: -1, w: 400, h: 112 },
                frameless: true,
                always_on_top: true,
                center: true,
                resizable: false,
                multi_instance: false,
              }).catch((err) => { console.warn('[notch] the card that says it is installed could not be shown:', err instanceof Error ? err.message : err); });
            }
          },
          hide: () => {
            for (const sidecar of sidecarManager.getConnectedSidecars()) {
              void sidecarManager.dispatchRPC(sidecar.id, 'panel.close', { id: NOTCH_INSTALLED_CARD }).catch(() => { /* it was not up */ });
            }
          },
        },
        // First names of the people a reply is prepared for. Null while mail is not read at all.
        waiting: () => (notchReal?.mail ? notchReal.mail.store.ready().map((row) => row.who.name || row.who.address.split('@')[0] || '') : null),
        meetings: async () => {
          const events = await notchReal?.mail?.calendar(Date.now(), Date.now() + 7 * 86_400_000).catch(() => null);
          return events ? events.filter((event) => !event.allDay && event.withOthers !== false).map((event) => event.summary) : null;
        },
        agents: () => notchReal?.agents?.store.list().map((agent) => agent.name) ?? [],
        system: () => {
          const os = String(sidecarManager.listSidecars().find((sidecar) => sidecar.connected)?.os ?? '').toLowerCase();
          return os.startsWith('win') ? 'windows' : os === 'darwin' || os.startsWith('mac') ? 'mac' : null;
        },
        // The files on the desktop and in the documents and downloads, by
        // name: asked of the person's own computer, which is the only one
        // that knows where they are. A desktop app from before this, or
        // one that may not read files, does not answer, and the place is
        // said to be not reached.
        files: async () => {
          for (const sidecar of sidecarManager.getConnectedSidecars()) {
            const began = performance.now();
            try {
              const places = notchFilePlaces(await sidecarManager.dispatchRPC(sidecar.id, 'notch.files', {}, { initial: 8000, max: 8000 }));
              if (places) return places;
            } catch (error) {
              console.log(`[notch] the desktop app did not answer the look at the three folders, after ${Math.round(performance.now() - began)} ms (${error instanceof Error ? error.name : 'error'})`);
            }
          }
          return null;
        },
        // One file, handed over by the person's own computer to be read
        // here and said in a line. That computer decides what it hands
        // over: never a file that is private by its name.
        openFile: async (place, name) => {
          for (const sidecar of sidecarManager.getConnectedSidecars()) {
            try {
              const answer = await sidecarManager.dispatchRPC(sidecar.id, 'notch.file', { place, name }, { initial: 15_000, max: 15_000 }) as
                { opened?: unknown; _binary?: { data?: unknown } } | null;
              const data = answer?.opened === true ? answer._binary?.data : null;
              if (typeof data === 'string' && data.length > 0 && data.length <= 24 * 1024 * 1024) return new Uint8Array(Buffer.from(data, 'base64'));
            } catch { /* this one cannot hand it over */ }
          }
          return null;
        },
        // What it read of a file is remembered, one line each, where it can be seen and forgotten.
        remember: (place, name, line) => notchRememberFile(getDb(), place, name, line),
        // The product's own reader of PDFs: apart from the daemon, and under a deadline.
        pdf: async (bytes) => {
          const { decodeAttachment } = await import('../brief/attachments.ts');
          return decodeAttachment(bytes, 'application/pdf');
        },
      }),
      // The back office that fits in a sheet (pass 12): memory with the
      // product's own Forget, this machine's keys, what makes out speech,
      // and what is connected.
      office: notchOfficeDeps({
        db: getDb(),
        config: () => agentService.getConfig(),
        sidecars: sidecarManager,
        google: googleAuthNow,
        // Whether its own browser read the mailbox at the last look. Null before any look.
        mailRead: () => { const last = notchReal?.mail?.watch.lastLook(); return last ? last.look.through !== null : null; },
        openMail: async () => {
          const browser = notchMailBrowser(sidecarManager);
          if (!browser) throw new Error('no desktop app with a browser is connected');
          await browser.navigate('https://mail.google.com/', { headless: false });
        },
        openPage: notchOpenPage,
      }),
    }), {
      say: NOTCH_FAILED_NOTICE,
      notice: notchNotice,
      undo: () => { setPauseHoldsLoops(false); setOwnerWordProbe(null); setNotchFrontSource(null); setCaptureGuard(null); },
    });
    // What the brain stops on its way down (handleShutdown).
    holdNotch(notchReal);
    // The fixed test items, for trying the notch by hand: demo gate only (src/notch/dev.ts). The shell
    // command fixture is filed against the brain's real run_command tool; "elsewhere" decides one of the
    // fixture's own approvals as a dashboard click would; a fixture promise is kept by one line in a file
    // inside the data directory, not by a model turn.
    // Made through the same guard as the rest: a throw here leaves the brain, and the notch, up.
    notchFixtures = startNotchPart('the test items of the notch', () => notchDevFor(notchDemoState, notchReal, () => ({
      approvalManager,
      deliverApproval: (request) => approvalDelivery.deliver(request),
      toolRegistry: () => agentService.getOrchestrator().getToolRegistry(),
      approveAsDashboard: (requestId) => applyApprovalDecision('approve', requestId, DASHBOARD_DECIDER, { approvalManager, deferredExecutor, wsService, auditTrail }),
      recordFailure: () => {
        const failure = projectFailure({ source: 'unknown', message: 'A test failure made by `jarvis notch fixture failure`. Nothing failed.' },
          { label: 'The notch test', sideEffects: true }, { requestId: `notch-fixture-${Date.now()}` });
        recordChatFailure(failure);
        return failure.headline;
      },
      promises: { executor, create: (what, options) => createCommitment(what, options), appendLog: (line) => appendFileSync(path.join(dataDir, NOTCH_FIXTURE_LOG), line) },
    })), { say: NOTCH_DEV_FAILED_NOTICE, notice: notchNotice });
    // Nothing answers what the engine asks of the person when there is no notch: then it is not started.
    if (peerSetupNow && notchReal) {
      // What the engine asks of the person goes to the link, and from there to the notch. Nothing else answers it.
      setPeerSetup(peerSetupNow);
      peerSetupNow.start();
    }
  }
}

/** The notch's routes, for the brain's API. */
export function notchApiRoutes(given: { sidecarManager: SidecarManager; agentService: AgentService; googleAuthNow: () => GoogleAuth | null }): ReturnType<typeof notchRoutes> {
  const { sidecarManager, agentService, googleAuthNow } = given;
  // Absent unless the notch switch is on.
  return notchRoutes(notchEnabled(), {
    demo: notchDemo, fixtures: notchFixtures, pages: () => notchSurface?.listening() ?? 0,
    // A file dropped on the notch's page arrives here, from the page itself.
    drop: (dropped) => notchReal?.drop?.take(dropped) ?? { taken: false },
    script: notchReal?.asks && notchReal.talk ? notchScriptDeps({
      llm: () => agentService.getLLMManager(),
      type: (text) => { notchReal?.asks?.typed(text); },
      say: (text) => { notchReal?.talk?.pretend(text); },
    }) : null,
    // The mail study (the plan's Track B), through Jarvis's own browser.
    study: notchStudyDeps({
      manager: sidecarManager,
      llm: () => agentService.getLLMManager(),
      google: googleAuthNow,
      mail: () => { const layer = notchReal?.mail; return layer ? { look: (kind) => layer.look(kind), counts: () => layer.store.counts() } : null; },
    }),
  });
}

/** First on the brain's way down. `stopExecutor` stops the commitment executor. */
export function stopNotchFirst(stopExecutor: () => void): void {
  // The notch first, before the turns are waited for: from here on it looks at no window and reads no mail,
  // and a yes whose window was still running on it sends nothing (docs/notch/README.md, rule 22).
  // A promise about to be kept shows its window on the notch, and is kept by the executor's own clock when
  // the window has run out (src/notch/promises.ts). With the notch stopped nobody can see that window or take
  // the promise back, so the clock is stopped with it: the promise stays open for the next brain to
  // announce. Without a notch the executor is stopped where it always was, further down.
  if (stopNotch()) stopExecutor();
}
