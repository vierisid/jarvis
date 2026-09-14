import {
  acceptSuggestion, getSuggestionLearning, listSuggestionCompositions, listSuggestionRoutines,
  recordSuggestionDecision, retrySuggestionComposition, SuggestionFeedbackError,
} from './suggestion-feedback.ts';
import type { SuggestionComposer } from './suggestion-composer.ts';

type RequestWithId = Request & { params: { id: string } };
const json = (data: unknown, status = 200) => Response.json(data, { status });

async function body(req: Request): Promise<unknown> {
  const value = await req.text();
  if (value.length > 12_000) throw new SuggestionFeedbackError('Feedback is too large', 413);
  try { return JSON.parse(value); } catch { throw new SuggestionFeedbackError('Expected valid JSON'); }
}
const handle = async (fn: () => unknown | Promise<unknown>): Promise<Response> => {
  try { return json(await fn()); }
  catch (e) {
    if (e instanceof SuggestionFeedbackError) return json({ error: e.message }, e.status);
    console.error('[SuggestionFeedback]', e);
    return json({ error: 'Could not save suggestion feedback' }, 500);
  }
};

export function createSuggestionFeedbackRoutes(composer: () => Pick<SuggestionComposer, 'kick'> | null | undefined) {
  return {
    '/api/awareness/routines': { GET: (req?: Request) => handle(() => {
      const offset = Number(req ? new URL(req.url).searchParams.get('offset') ?? 0 : 0);
      if (!Number.isSafeInteger(offset) || offset < 0) throw new SuggestionFeedbackError('offset must be a non-negative integer');
      const suggestions = listSuggestionRoutines(offset);
      return { suggestions, nextOffset: suggestions.length === 100 ? offset + 100 : null };
    }) },
    '/api/awareness/compositions': { GET: (req?: Request) => handle(() => {
      const offset = Number(req ? new URL(req.url).searchParams.get('offset') ?? 0 : 0);
      if (!Number.isSafeInteger(offset) || offset < 0) throw new SuggestionFeedbackError('offset must be a non-negative integer');
      const suggestions = listSuggestionCompositions(offset);
      return { suggestions, nextOffset: suggestions.length === 100 ? offset + 100 : null };
    }) },
    '/api/awareness/suggestions/:id/learning': {
      GET: (req: RequestWithId) => handle(() => getSuggestionLearning(req.params.id)),
    },
    '/api/awareness/suggestions/:id/accept': {
      POST: (req: RequestWithId) => handle(async () => {
        const result = acceptSuggestion(req.params.id, await body(req));
        composer()?.kick();
        return result;
      }),
    },
    '/api/awareness/suggestions/:id/retry': {
      POST: (req: RequestWithId) => handle(async () => {
        const result = retrySuggestionComposition(req.params.id, await body(req));
        composer()?.kick();
        return result;
      }),
    },
    '/api/awareness/suggestions/:id/dismiss': {
      PATCH: (req: RequestWithId) => handle(async () => {
        const input = await req.text();
        let data: unknown = { requestId: 'legacy-dismiss', reason: 'Dismissed without a reason' };
        if (input.length > 2000) throw new SuggestionFeedbackError('Feedback is too large', 413);
        if (input.trim()) { try { data = JSON.parse(input); } catch { throw new SuggestionFeedbackError('Expected valid JSON'); } }
        return { ok: true, learning: recordSuggestionDecision(req.params.id, 'dismiss', data) };
      }),
    },
    '/api/awareness/suggestions/:id/act': {
      PATCH: (req: RequestWithId) => handle(() => ({ ok: true, learning: recordSuggestionDecision(req.params.id, 'interest',
        { requestId: 'legacy-interest', reason: 'Requested more information' }) })),
    },
  };
}
