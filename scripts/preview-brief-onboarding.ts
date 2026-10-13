/** F-26 isolated browser fixture. Run: bun scripts/preview-brief-onboarding.ts
 * Loopback only, no product config/database/model/credentials. API allowlist fails closed. */
import page from '../ui/src/brief/onboarding/preview/index.html';
import type { BriefComposeRequest, BriefCompositionJob } from '../src/brief/composition-contracts';
let hosted = true, loseResponse = false;
const initial = () => ({ setup_completed: true, setup_completed_at: 1, setup_skipped_profile: false,
  profile_completed: true, tutorial_completed: false, tutorial_completed_at: null as number | null,
  tutorial_dismissed: false, tutorial_progress_step: null as string | null, last_reset_at: null,
  post_setup_services_ready: true });
let status = initial();
const jobs = new Map<string, BriefCompositionJob>();
const server = Bun.serve({ hostname: '127.0.0.1', port: 4426, routes: { '/': page }, async fetch(request) {
  const path = new URL(request.url).pathname;
  const body = request.method === 'POST' ? await request.json().catch(() => ({})) as Record<string, unknown> : {};
  const json = (value: unknown, code = 200) => Response.json(value, { status: code });
  if (path === '/fixture/reset') { hosted = body.install !== 'local'; status = initial();
    if (body.phase === 'fresh') status = { ...status, setup_completed: false, profile_completed: false };
    jobs.clear(); loseResponse = false; return json({ ok: true }); }
  if (path === '/fixture/lose-response') { loseResponse = true; return json({ ok: true }); }
  if (path === '/api/onboarding/status') return json(status);
  if (path === '/api/config/llm') return json({ hosted_llm: hosted });
  if (path === '/api/config/stt' || path === '/api/auth/managed/status') return json({});
  if (path === '/api/system/permissions') return json({ available: false, reason: 'unsupported' });
  if (path === '/api/onboarding/tutorial/progress') status.tutorial_progress_step = String(body.stepId);
  else if (path === '/api/onboarding/tutorial/complete') { status.tutorial_completed = true; status.tutorial_completed_at = Date.now(); }
  else if (path === '/api/onboarding/tutorial/dismiss') status.tutorial_dismissed = true;
  else if (path === '/api/onboarding/setup') status.setup_completed = true;
  else if (path === '/api/onboarding/profile/skip') status.setup_skipped_profile = true;
  else if (path === '/api/onboarding/skip') status = { ...initial(), setup_skipped_profile: true, tutorial_dismissed: true };
  else if (path === '/api/brief/workflow-compositions' && request.method === 'POST') {
    const input = body as unknown as BriefComposeRequest;
    let job = jobs.get(input.requestId);
    if (!job) { job = { jobId: `fixture-${jobs.size + 1}`, requestId: input.requestId,
      specification: { name: 'Synthetic onboarding draft', prompt: input.prompt }, state: 'draft_ready',
      progress: { checkedCandidates: 1 }, compositionId: 'fixture-composition',
      workflow: { flowId: 'fixture-flow', versionId: 'fixture-version' }, blocker: null, createdAt: Date.now(), updatedAt: Date.now() }; jobs.set(input.requestId, job); }
    if (loseResponse) { loseResponse = false; return json({ error: 'Synthetic response lost after acceptance' }, 503); }
    return json({ job, created: false });
  } else return json({ error: 'Not provided by this isolated fixture' }, 501);
  return json({ ok: true });
} });
console.log(`F-26 synthetic fixture: ${server.url}?brief=1#/brief/today`);
