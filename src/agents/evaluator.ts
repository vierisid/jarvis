import type { LLMManager } from '../llm/manager.ts';
import type { LLMRouter, IntentType } from '../llm/router.ts';

const COMPLEX_KEYWORDS = [
  'code', 'refactor', 'debug', 'script', 'error', 'architect',
  'implement', 'design', 'complex', 'reason', 'analyze', 'algorithm'
];

export class IntentEvaluator {
  private manager: LLMManager;
  private router: LLMRouter;

  constructor(manager: LLMManager, router: LLMRouter) {
    this.manager = manager;
    this.router = router;
  }

  async evaluate(prompt: string): Promise<IntentType> {
    // 1. Heuristics Check (Bypass LLM for speed)
    if (this.containsComplexKeywords(prompt)) {
      console.log('[Evaluator] Complexity detected via heuristics');
      return 'COMPLEX';
    }

    // 2. LLM Evaluation (Cheap call)
    try {
      const evaluatorProvider = this.router.getCheapestAvailable();
      if (!evaluatorProvider) return 'SIMPLE';

      const response = await this.manager.chat([{
        role: 'system',
        content: `Classify the user's intent as SIMPLE or COMPLEX.
SIMPLE: Casual chat, status updates, greeting, simple questions, or basic information.
COMPLEX: Technical questions, multi-step tasks, logical reasoning, or creative writing.
Response with ONLY the word "SIMPLE" or "COMPLEX".`
      }, {
        role: 'user',
        content: prompt
      }], {
        model: undefined, // Uses default for provider
        temperature: 0,
        max_tokens: 5,
      });

      const classification = response.content.trim().toUpperCase();
      if (classification === 'COMPLEX') return 'COMPLEX';
    } catch (err) {
      console.error('[Evaluator] LLM evaluation failed, defaulting to SIMPLE:', err);
    }

    return 'SIMPLE';
  }

  private containsComplexKeywords(prompt: string): boolean {
    const lower = prompt.toLowerCase();
    return COMPLEX_KEYWORDS.some(keyword => lower.includes(keyword));
  }
}
