import { correctFact, verifyFact, getFact, FactInputError, factText } from './facts.ts';

type FactRequest = Request & { params: { id: string } };
async function decide(req: FactRequest, action: 'confirm' | 'correct'): Promise<Response> {
  try {
    const text = await req.text();
    if (text.length > 20000) throw new FactInputError('Request too large');
    let input: Record<string, unknown>;
    try { input = JSON.parse(text); } catch { throw new FactInputError('Invalid JSON'); }
    const allowed = action === 'confirm' ? ['confirmed', 'reason'] : ['confirmed', 'reason', 'object'];
    if (!input || typeof input !== 'object' || Array.isArray(input)
        || Object.keys(input).some(key => !allowed.includes(key)) || input.confirmed !== true) {
      throw new FactInputError('Explicit confirmation and a reason are required');
    }
    const reason = factText(input.reason, 'reason', 1000);
    const fact = action === 'confirm' ? verifyFact(req.params.id, reason)
      : correctFact(req.params.id, factText(input.object, 'object'), reason);
    return Response.json(fact);
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'Could not save fact' },
      { status: error instanceof FactInputError ? error.status : 500 });
  }
}
export function createFactDecisionRoutes() {
  return {
    '/api/vault/facts/:id': { GET: (req: FactRequest) => {
      const fact = getFact(req.params.id);
      return fact ? Response.json(fact) : Response.json({ error: 'Fact not found' }, { status: 404 });
    } },
    '/api/vault/facts/:id/confirm': { POST: (req: FactRequest) => decide(req, 'confirm') },
    '/api/vault/facts/:id/correct': { POST: (req: FactRequest) => decide(req, 'correct') },
  };
}
